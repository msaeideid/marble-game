from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .energy import drain, regen, try_spend
from .swing import (
    aim_dir,
    pick_swing_anchor,
    pick_zip_anchor,
    remove_outward_velocity,
    rope_limited_delta,
)
from .vec import Vec3
from .world import Collider, World

MAX_SUBSTEP = 0.4
EPS = 1e-6


@dataclass(slots=True)
class Tether:
    anchor: Vec3
    length: float
    target_length: float


@dataclass(slots=True)
class Zip:
    anchor: Vec3
    time_left: float


@dataclass(slots=True)
class Intent:
    """What a controller asks the character to do this tick (mirrors PlayerIntent in types.ts)."""

    moveX: float = 0.0
    moveZ: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    jumpPressed: bool = False
    swingHeld: bool = False
    reelHeld: bool = False
    zipPressed: bool = False

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Intent:
        return Intent(
            moveX=float(d.get("moveX", 0.0)),
            moveZ=float(d.get("moveZ", 0.0)),
            yaw=float(d.get("yaw", 0.0)),
            pitch=float(d.get("pitch", 0.0)),
            jumpPressed=bool(d.get("jumpPressed", False)),
            swingHeld=bool(d.get("swingHeld", False)),
            reelHeld=bool(d.get("reelHeld", False)),
            zipPressed=bool(d.get("zipPressed", False)),
        )


@dataclass(slots=True)
class PlayerState:
    pos: Vec3
    prev_pos: Vec3
    vel: Vec3 = field(default_factory=Vec3)
    grounded: bool = False
    coyote: float = 0.0
    jump_buffer: float = 0.0
    facing: float = 0.0
    energy: float = 0.0
    energy_delay: float = 0.0
    tether: Tether | None = None
    zip: Zip | None = None
    swing_held_prev: bool = False


def create_player_state(spawn: Vec3, hero: SimpleNamespace) -> PlayerState:
    return PlayerState(pos=spawn.copy(), prev_pos=spawn.copy(), energy=float(hero.energy.max))


@dataclass(slots=True)
class MoveResult:
    hit_down: bool = False
    hit_up: bool = False
    hit_x: bool = False
    hit_z: bool = False


def move_and_collide(pos: Vec3, delta: Vec3, p: SimpleNamespace, colliders: list[Collider]) -> MoveResult:
    """Move an upright box (centred on its feet) one axis at a time, pushing it out of colliders."""
    res = MoveResult()
    largest = max(abs(delta.x), abs(delta.y), abs(delta.z))
    steps = max(1, math.ceil(largest / MAX_SUBSTEP))
    sx = delta.x / steps
    sy = delta.y / steps
    sz = delta.z / steps
    for _ in range(steps):
        pos.x += sx
        if sx != 0 and _push_out("x", sx, pos, p, colliders):
            res.hit_x = True
        pos.z += sz
        if sz != 0 and _push_out("z", sz, pos, p, colliders):
            res.hit_z = True
        pos.y += sy
        if sy != 0 and _push_out("y", sy, pos, p, colliders):
            if sy < 0:
                res.hit_down = True
            else:
                res.hit_up = True
    return res


def _overlaps(pos: Vec3, p: SimpleNamespace, c: Collider) -> bool:
    return (
        pos.x + p.halfWidth > c.min.x + EPS
        and pos.x - p.halfWidth < c.max.x - EPS
        and pos.y + p.height > c.min.y + EPS
        and pos.y < c.max.y - EPS
        and pos.z + p.halfWidth > c.min.z + EPS
        and pos.z - p.halfWidth < c.max.z - EPS
    )


def _push_out(axis: str, d: float, pos: Vec3, p: SimpleNamespace, colliders: list[Collider]) -> bool:
    hit = False
    for c in colliders:
        if not _overlaps(pos, p, c):
            continue
        hit = True
        if axis == "y":
            pos.y = c.max.y if d < 0 else c.min.y - p.height
        elif d > 0:
            setattr(pos, axis, getattr(c.min, axis) - p.halfWidth)
        else:
            setattr(pos, axis, getattr(c.max, axis) + p.halfWidth)
    return hit


def hand_pos(s: PlayerState, hero: SimpleNamespace) -> Vec3:
    return Vec3(s.pos.x, s.pos.y + hero.swing.handHeight, s.pos.z)


def _release_tether(s: PlayerState, hero: SimpleNamespace) -> None:
    s.tether = None
    speed = math.hypot(s.vel.x, s.vel.y, s.vel.z)
    if speed > 6:
        k = hero.swing.releaseBoost / speed
        s.vel.x += s.vel.x * k
        s.vel.y += s.vel.y * k
        s.vel.z += s.vel.z * k


def step_player(s: PlayerState, intent: Intent, hero: SimpleNamespace, world: World, dt: float) -> None:
    """Advance one player by one fixed tick. Mirrors stepPlayer in client/src/sim/controller.ts."""
    p = hero.movement
    s.prev_pos = s.pos.copy()
    aim = aim_dir(intent.yaw, intent.pitch)

    # ---- tether and zip state changes ----
    if intent.swingHeld and not s.swing_held_prev and s.zip is None and s.tether is None:
        hand = hand_pos(s, hero)
        anchor = pick_swing_anchor(world, hand, aim, hero.swing.maxRange)
        if anchor is not None and try_spend(s, hero.swing.attachCost, hero.energy):
            length = math.hypot(anchor.x - hand.x, anchor.y - hand.y, anchor.z - hand.z)
            ground = world.raycast(hand, Vec3(0.0, -1.0, 0.0), 300)
            ground_y = ground.point.y if ground is not None else s.pos.y
            clear_length = anchor.y - ground_y - hero.swing.arcClearance
            target_length = max(hero.swing.minLength, min(length, clear_length))
            s.tether = Tether(anchor, length, target_length)
    if not intent.swingHeld and s.tether is not None:
        _release_tether(s, hero)
    s.swing_held_prev = intent.swingHeld

    if intent.zipPressed and s.zip is None:
        hand = hand_pos(s, hero)
        anchor = pick_zip_anchor(world, hand, aim, hero.swing.handHeight, hero.zip)
        if anchor is not None and try_spend(s, hero.zip.cost, hero.energy):
            s.tether = None
            s.zip = Zip(anchor, float(hero.zip.maxDuration))

    if s.tether is not None:
        t = s.tether
        cost = hero.swing.drainPerSecond
        if intent.reelHeld:
            cost += hero.swing.reelDrainPerSecond
            t.target_length = max(hero.swing.minLength, t.target_length - hero.swing.reelSpeed * dt)
        if t.length > t.target_length:
            rate = hero.swing.reelSpeed if intent.reelHeld else hero.swing.autoReelSpeed
            t.length = max(t.target_length, t.length - rate * dt)
            hand = hand_pos(s, hero)
            dx = t.anchor.x - hand.x
            dy = t.anchor.y - hand.y
            dz = t.anchor.z - hand.z
            d = math.hypot(dx, dy, dz) or 1.0
            inward = (s.vel.x * dx + s.vel.y * dy + s.vel.z * dz) / d
            if inward < rate:
                k = (rate - inward) * min(1.0, hero.swing.pullGain * dt)
                s.vel.x += (dx / d) * k
                s.vel.y += (dy / d) * k
                s.vel.z += (dz / d) * k
        if not drain(s, cost * dt, hero.energy):
            _release_tether(s, hero)

    # ---- horizontal control ----
    mx = max(-1.0, min(1.0, intent.moveX))
    mz = max(-1.0, min(1.0, intent.moveZ))
    mag = math.hypot(mx, mz)
    if mag > 1:
        mx /= mag
        mz /= mag
    sin = math.sin(intent.yaw)
    cos = math.cos(intent.yaw)
    wish_x = mz * sin + mx * cos
    wish_z = mz * cos - mx * sin

    if s.zip is not None:
        pass  # zip overrides velocity entirely
    elif s.tether is not None:
        s.vel.x += wish_x * hero.swing.airControl * dt
        s.vel.z += wish_z * hero.swing.airControl * dt
    elif s.grounded:
        tx = wish_x * p.runSpeed
        tz = wish_z * p.runSpeed
        dx = tx - s.vel.x
        dz = tz - s.vel.z
        dist = math.hypot(dx, dz)
        if dist > 0:
            k = min(1.0, (p.groundAccel * dt) / dist)
            s.vel.x += dx * k
            s.vel.z += dz * k
    else:
        wish_mag = math.hypot(wish_x, wish_z)
        if wish_mag > 0:
            ux = wish_x / wish_mag
            uz = wish_z / wish_mag
            wish_speed = wish_mag * p.runSpeed
            add = wish_speed - (s.vel.x * ux + s.vel.z * uz)
            if add > 0:
                a = min(add, p.airAccel * dt)
                s.vel.x += ux * a
                s.vel.z += uz * a

    # ---- jump ----
    s.coyote = float(p.coyoteTime) if s.grounded else max(0.0, s.coyote - dt)
    s.jump_buffer = float(p.jumpBufferTime) if intent.jumpPressed else max(0.0, s.jump_buffer - dt)
    if s.zip is None and s.jump_buffer > 0 and s.coyote > 0:
        s.vel.y = p.jumpSpeed
        s.jump_buffer = 0.0
        s.coyote = 0.0
        s.grounded = False

    # ---- gravity / zip pull ----
    if s.zip is not None:
        hand = hand_pos(s, hero)
        dx = s.zip.anchor.x - hand.x
        dy = s.zip.anchor.y - hand.y
        dz = s.zip.anchor.z - hand.z
        d = math.hypot(dx, dy, dz) or 1.0
        s.vel.x = (dx / d) * hero.zip.speed
        s.vel.y = (dy / d) * hero.zip.speed
        s.vel.z = (dz / d) * hero.zip.speed
    else:
        s.vel.y = max(s.vel.y - p.gravity * dt, -p.maxFallSpeed)

    speed = math.hypot(s.vel.x, s.vel.y, s.vel.z)
    if s.zip is None and speed > hero.swing.maxSpeed:
        k = hero.swing.maxSpeed / speed
        s.vel.x *= k
        s.vel.y *= k
        s.vel.z *= k

    # ---- move ----
    delta = Vec3(s.vel.x * dt, s.vel.y * dt, s.vel.z * dt)
    if s.tether is not None:
        delta = rope_limited_delta(hand_pos(s, hero), delta, s.tether.anchor, s.tether.length)
    r = move_and_collide(s.pos, delta, p, world.colliders)
    if r.hit_x:
        s.vel.x = 0.0
    if r.hit_z:
        s.vel.z = 0.0
    if r.hit_down:
        s.vel.y = 0.0
        s.grounded = True
    else:
        s.grounded = False
        if r.hit_up and s.vel.y > 0:
            s.vel.y = 0.0

    # ---- post-move: rope, zip arrival ----
    if s.tether is not None:
        hand = hand_pos(s, hero)
        remove_outward_velocity(s.vel, hand, s.tether.anchor, s.tether.length)
        to = Vec3(s.tether.anchor.x - hand.x, s.tether.anchor.y - hand.y, s.tether.anchor.z - hand.z)
        dist = math.hypot(to.x, to.y, to.z)
        blocked = world.raycast(hand, to, dist - hero.swing.ropeClearTolerance)
        if blocked is not None:
            _release_tether(s, hero)

    if s.zip is not None:
        s.zip.time_left -= dt
        hand = hand_pos(s, hero)
        dist = math.hypot(s.zip.anchor.x - hand.x, s.zip.anchor.y - hand.y, s.zip.anchor.z - hand.z)
        if dist <= hero.zip.arriveDistance or s.zip.time_left <= 0:
            s.zip = None
            s.vel.x *= hero.zip.exitKeep
            s.vel.y = s.vel.y * hero.zip.exitKeep + hero.zip.popSpeed
            s.vel.z *= hero.zip.exitKeep

    if s.tether is None and s.zip is None:
        regen(s, hero.energy, dt)

    if math.hypot(s.vel.x, s.vel.z) > 0.5:
        s.facing = math.atan2(s.vel.x, s.vel.z)


def to_wire(s: PlayerState) -> dict[str, Any]:
    """Serialise the movement state. Same shape as toWire in client/src/sim/wire.ts."""
    return {
        "pos": s.pos.to_list(),
        "vel": s.vel.to_list(),
        "grounded": s.grounded,
        "coyote": s.coyote,
        "jumpBuffer": s.jump_buffer,
        "facing": s.facing,
        "energy": s.energy,
        "energyDelay": s.energy_delay,
        "swingHeldPrev": s.swing_held_prev,
        "tether": (
            {"anchor": s.tether.anchor.to_list(), "length": s.tether.length, "targetLength": s.tether.target_length}
            if s.tether
            else None
        ),
        "zip": {"anchor": s.zip.anchor.to_list(), "timeLeft": s.zip.time_left} if s.zip else None,
    }
