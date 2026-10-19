"""Ranged weapons: laser bolts, lock-on, homing rockets, chain lightning, storm strikes.

Mirrors client/src/sim/weapons.ts.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .vec import Vec3, vec
from .world import World

HIT_STEP = 0.3  # how far a rocket travels between hit tests against enemies


@dataclass(slots=True)
class Target:
    """Anything a ranged weapon can hit: an upright box centred on its feet. `pos` is the live position."""

    id: str
    pos: Vec3
    half_width: float
    height: float


def centre(t: Target) -> Vec3:
    return Vec3(t.pos.x, t.pos.y + t.height / 2, t.pos.z)


def trace_laser(world: World, origin: Vec3, d: Vec3, p: SimpleNamespace, targets: list[Target]) -> tuple[Vec3, Target | None]:
    """A hitscan bolt along the unit vector `d`. Returns (end point, the target hit or None)."""
    wall = world.raycast(origin, d, p.range)
    reach = wall.distance if wall is not None else float(p.range)
    hit: Target | None = None
    for c in targets:
        m = centre(c)
        cx = m.x - origin.x
        cy = m.y - origin.y
        cz = m.z - origin.z
        t = cx * d.x + cy * d.y + cz * d.z
        if t < 0 or t > reach:
            continue
        off2 = cx * cx + cy * cy + cz * cz - t * t
        r = c.half_width + p.aimAssist
        if off2 > r * r:
            continue
        hit = c
        reach = t
    return Vec3(origin.x + d.x * reach, origin.y + d.y * reach, origin.z + d.z * reach), hit


def pick_lock_target(world: World, origin: Vec3, d: Vec3, lock_range: float, lock_angle_degrees: float, targets: list[Target]) -> Target | None:
    """The target closest to the crosshair direction, within the lock angle and range, with a clear line of sight."""
    min_cos = math.cos((lock_angle_degrees * math.pi) / 180)
    best: Target | None = None
    best_cos = min_cos
    for c in targets:
        m = centre(c)
        vx = m.x - origin.x
        vy = m.y - origin.y
        vz = m.z - origin.z
        dist = math.hypot(vx, vy, vz)
        if dist < 0.5 or dist > lock_range:
            continue
        cos = (vx * d.x + vy * d.y + vz * d.z) / dist
        if cos < best_cos:
            continue
        wall = world.raycast(origin, Vec3(vx / dist, vy / dist, vz / dist), dist)
        if wall is not None and wall.distance < dist - 0.5:
            continue
        best = c
        best_cos = cos
    return best


@dataclass(slots=True)
class RocketState:
    id: int
    owner: str
    pos: Vec3
    prev_pos: Vec3
    dir: Vec3
    age: float = 0.0
    target_id: str | None = None


@dataclass(slots=True)
class RocketHooks:
    targets: Callable[[], list[Target]]
    props: Callable[[], list[Target]]
    detonate: Callable[[str, str], None]
    blast: Callable[[str, float, float, float, float], None]


def _steer(d: Vec3, frm: Vec3, to: Vec3, max_angle: float) -> None:
    """Turn the unit vector `d` toward the point `to` by at most `max_angle` radians."""
    dx = to.x - frm.x
    dy = to.y - frm.y
    dz = to.z - frm.z
    length = math.hypot(dx, dy, dz)
    if length < 1e-6:
        return
    dx /= length
    dy /= length
    dz /= length
    dot = max(-1.0, min(1.0, d.x * dx + d.y * dy + d.z * dz))
    angle = math.acos(dot)
    if angle <= max_angle:
        d.x, d.y, d.z = dx, dy, dz
        return
    if angle > math.pi - 1e-4:
        return  # exactly backwards: no unique turn, keep going
    a = math.sin(angle - max_angle) / math.sin(angle)
    b = math.sin(max_angle) / math.sin(angle)
    nx = d.x * a + dx * b
    ny = d.y * a + dy * b
    nz = d.z * a + dz * b
    n = math.hypot(nx, ny, nz) or 1.0
    d.x, d.y, d.z = nx / n, ny / n, nz / n


def _touches(t: Target, x: float, y: float, z: float, radius: float) -> bool:
    return (
        abs(x - t.pos.x) <= t.half_width + radius
        and abs(z - t.pos.z) <= t.half_width + radius
        and y >= t.pos.y - radius
        and y <= t.pos.y + t.height + radius
    )


class RocketSystem:
    """Homing rockets in flight: steering, flying, hitting, bursting."""

    def __init__(self, world: World, params: SimpleNamespace) -> None:
        self.world = world
        self.params = params
        self.rockets: list[RocketState] = []
        self._next_id = 1

    def launch(self, owner: str, origin: Vec3, d: Vec3, target_id: str | None) -> dict[str, Any]:
        r = RocketState(self._next_id, owner, origin.copy(), origin.copy(), d.copy(), 0.0, target_id)
        self._next_id += 1
        self.rockets.append(r)
        return {"type": "rocketLaunch", "id": r.id, "owner": owner, "locked": target_id}

    def step(self, dt: float, hooks: RocketHooks) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        p = self.params
        targets = hooks.targets()
        props = hooks.props()
        alive: list[RocketState] = []
        for r in self.rockets:
            r.age += dt
            r.prev_pos = r.pos.copy()
            target = next((t for t in targets if t.id == r.target_id), None) if r.target_id else None
            if target is not None:
                _steer(r.dir, r.pos, centre(target), p.turnRate * dt)

            dist = p.speed * dt
            wall = self.world.raycast(r.pos, r.dir, dist + p.radius)
            stop = max(0.0, wall.distance - p.radius) if wall is not None else math.inf
            limit = min(stop, dist)
            at = min(HIT_STEP, limit)
            while True:
                x = r.pos.x + r.dir.x * at
                y = r.pos.y + r.dir.y * at
                z = r.pos.z + r.dir.z * at
                if any(_touches(t, x, y, z, p.radius) for t in targets) or any(_touches(t, x, y, z, p.radius) for t in props):
                    stop = at
                    break
                if at >= limit:
                    break
                at = min(at + HIT_STEP, limit)
            travelled = min(stop, dist)
            r.pos = Vec3(r.pos.x + r.dir.x * travelled, r.pos.y + r.dir.y * travelled, r.pos.z + r.dir.z * travelled)

            if stop <= dist or r.age >= p.lifetime:
                events.append(self._explode(r, targets, props, hooks))
            else:
                alive.append(r)
        self.rockets = alive
        return events

    def _explode(self, r: RocketState, targets: list[Target], props: list[Target], hooks: RocketHooks) -> dict[str, Any]:
        p = self.params
        hits: list[str] = []
        for t in props:
            m = centre(t)
            d = math.hypot(m.x - r.pos.x, m.y - r.pos.y, m.z - r.pos.z) - t.half_width
            if d <= p.splashRadius:
                hooks.detonate(t.id, r.owner)
        for t in targets:
            m = centre(t)
            dx = m.x - r.pos.x
            dy = m.y - r.pos.y
            dz = m.z - r.pos.z
            d = max(0.0, math.hypot(dx, dy, dz) - t.half_width)
            if d > p.splashRadius:
                continue
            frac = d / p.splashRadius
            flat = math.hypot(dx, dz)
            hits.append(t.id)
            hooks.blast(
                t.id,
                p.damage * (1 - (1 - p.edgeFalloff) * frac),
                dx / flat if flat > 1e-6 else math.sin(r.age),
                dz / flat if flat > 1e-6 else math.cos(r.age),
                p.knockback * (1 - 0.5 * frac),
            )
        return {"type": "explosion", "pos": vec(r.pos), "radius": float(p.splashRadius), "owner": r.owner, "hits": hits}

    def to_wire(self) -> list[dict[str, Any]]:
        return [
            {"id": r.id, "owner": r.owner, "pos": r.pos.to_list(), "dir": r.dir.to_list(), "target": r.target_id}
            for r in self.rockets
        ]


def trace_chain(world: World, origin: Vec3, d: Vec3, p: SimpleNamespace, targets: list[Target]) -> list[Target]:
    """The locked target first, then up to maxTargets - 1 jumps to the nearest unhit enemy within jumpRadius."""
    first = pick_lock_target(world, origin, d, p.range, p.lockAngleDegrees, targets)
    if first is None:
        return []
    hits: list[Target] = [first]
    while len(hits) < p.maxTargets:
        frm = centre(hits[-1])
        best: Target | None = None
        best_d = float(p.jumpRadius)
        for t in targets:
            if any(h is t for h in hits):
                continue
            m = centre(t)
            dd = math.hypot(m.x - frm.x, m.y - frm.y, m.z - frm.z)
            if dd >= best_d:
                continue
            wall = world.raycast(frm, Vec3((m.x - frm.x) / dd, (m.y - frm.y) / dd, (m.z - frm.z) / dd), dd)
            if wall is not None and wall.distance < dd - 0.3:
                continue
            best = t
            best_d = dd
        if best is None:
            break
        hits.append(best)
    return hits


def strike_point(world: World, origin: Vec3, d: Vec3, p: SimpleNamespace) -> Vec3 | None:
    """Where a storm strike aimed along `d` would land: the first surface within range, or None (sky)."""
    hit = world.raycast(origin, d, p.range)
    return hit.point.copy() if hit is not None else None


@dataclass(slots=True)
class StrikeState:
    id: int
    owner: str
    pos: Vec3
    timer: float


@dataclass(slots=True)
class StrikeHooks:
    targets: Callable[[], list[Target]]
    shock: Callable[[str, float, float, float, float, float], None]


@dataclass
class StrikeSystem:
    """Storm strikes that have been called and are waiting to land."""

    params: SimpleNamespace
    strikes: list[StrikeState] = field(default_factory=list)
    _next_id: int = 1

    def call(self, owner: str, pos: Vec3) -> dict[str, Any]:
        s = StrikeState(self._next_id, owner, pos.copy(), float(self.params.delay))
        self._next_id += 1
        self.strikes.append(s)
        return {
            "type": "strikeStart",
            "id": s.id,
            "owner": owner,
            "pos": vec(pos),
            "radius": float(self.params.radius),
            "delay": float(self.params.delay),
        }

    def step(self, dt: float, hooks: StrikeHooks) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        p = self.params
        targets = hooks.targets()
        waiting: list[StrikeState] = []
        for s in self.strikes:
            s.timer -= dt
            if s.timer > 0:
                waiting.append(s)
                continue
            hits: list[str] = []
            for t in targets:
                dx = t.pos.x - s.pos.x
                dz = t.pos.z - s.pos.z
                flat = math.hypot(dx, dz)
                if flat > p.radius + t.half_width or t.pos.y < s.pos.y - 1.2 or t.pos.y > s.pos.y + 3:
                    continue
                hits.append(t.id)
                hooks.shock(
                    t.id,
                    float(p.damage),
                    float(p.stunTime),
                    dx / flat if flat > 1e-6 else 0.0,
                    dz / flat if flat > 1e-6 else 1.0,
                    float(p.knockback),
                )
            events.append(
                {"type": "strikeHit", "id": s.id, "owner": s.owner, "pos": vec(s.pos), "radius": float(p.radius), "hits": hits}
            )
        self.strikes = waiting
        return events

    def to_wire(self) -> list[dict[str, Any]]:
        return [{"id": s.id, "owner": s.owner, "pos": s.pos.to_list(), "timer": s.timer} for s in self.strikes]

