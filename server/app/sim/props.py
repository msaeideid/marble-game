"""Lift-and-throw props: lifting, carrying, throwing, landing, wall breaking, enemy hits, detonation, respawning.

Mirrors client/src/sim/props.ts.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .controller import PlayerState, move_and_collide
from .swing import aim_dir
from .vec import Vec3
from .weapons import Target
from .world import World

GRAVITY = 28.0
IMPACT_SPEED = 6.0  # a thrown prop must be at least this fast to damage itself on a hard stop...
WALL_BREAK_SPEED = 8.0  # ...and at least this fast to smash a breakable wall


@dataclass(slots=True)
class PropState:
    id: int
    def_id: str
    pos: Vec3
    vel: Vec3
    home: Vec3
    hp: int
    mode: str = "resting"  # resting | held | thrown | destroyed
    holder: str | None = None
    respawn: float = 0.0
    hit: list[str] = field(default_factory=list)  # enemies already struck by the current throw (not synced)
    thrower: str | None = None  # who threw it last (not synced)


@dataclass(slots=True)
class PropHooks:
    """What a prop needs to know about the rest of the world while it flies and sits."""

    holder_top: Callable[[str], Vec3 | None]
    enemies: Callable[[], list[Target]] | None = None
    hit_enemy: Callable[[str, float, float, float, float], None] | None = None


@dataclass(slots=True)
class CarryScales:
    speed_scale: float
    jump_scale: float


def carry_scales(defn: SimpleNamespace | None) -> CarryScales | None:
    if defn is None:
        return None
    return CarryScales(float(defn.carrySlow), math.sqrt(defn.carrySlow))


@dataclass
class PropSystem:
    world: World
    defs: dict[str, SimpleNamespace]
    props: list[PropState] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.props = []
        for pid, spawn in enumerate(self.world.prop_spawns):
            d = self.defs[spawn["type"]]
            pos = Vec3.from_list(spawn["pos"])
            self.props.append(PropState(pid, spawn["type"], pos.copy(), Vec3(), pos.copy(), int(d.hp)))

    def handle_grab(
        self, player_id: str, player: PlayerState, hero: SimpleNamespace, yaw: float, pitch: float
    ) -> list[dict[str, Any]]:
        """The grab button: throw what you carry, otherwise lift the nearest prop in reach."""
        lift = getattr(hero, "lift", None)
        if lift is None or player.grab_cooldown > 0 or player.charge is not None:
            return []
        if player.carrying is not None:
            return self._throw_held(player_id, player, hero, lift, yaw, pitch)
        return self._lift_nearest(player_id, player, lift)

    def _lift_nearest(self, player_id: str, player: PlayerState, lift: SimpleNamespace) -> list[dict[str, Any]]:
        best: PropState | None = None
        best_d = math.inf
        for pr in self.props:
            if pr.mode != "resting":
                continue
            half = self.defs[pr.def_id].size.halfWidth
            d = math.hypot(pr.pos.x - player.pos.x, pr.pos.z - player.pos.z)
            if d > lift.liftRange + half or abs(pr.pos.y - player.pos.y) > 2.5:
                continue
            if d < best_d:
                best, best_d = pr, d
        if best is None:
            return []
        best.mode = "held"
        best.holder = player_id
        best.vel = Vec3()
        player.carrying = (best.id, best.def_id)
        player.grab_cooldown = float(lift.cooldown)
        return [{"type": "lift", "id": best.id, "by": player_id}]

    def _throw_held(
        self,
        player_id: str,
        player: PlayerState,
        hero: SimpleNamespace,
        lift: SimpleNamespace,
        yaw: float,
        pitch: float,
    ) -> list[dict[str, Any]]:
        assert player.carrying is not None
        pr = self.props[player.carrying[0]] if player.carrying[0] < len(self.props) else None
        player.carrying = None
        player.grab_cooldown = float(lift.cooldown)
        if pr is None:
            return []
        d = self.defs[pr.def_id]
        a = aim_dir(yaw, pitch)
        dx = a.x
        dy = max(a.y, 0.1) + 0.15
        dz = a.z
        length = math.hypot(dx, dy, dz) or 1.0
        dx /= length
        dy /= length
        dz /= length
        speed = d.throwSpeed * lift.strength
        h = math.hypot(a.x, a.z) or 1.0
        reach = hero.movement.halfWidth + d.size.halfWidth + 0.15
        pr.pos = Vec3(
            player.pos.x + (a.x / h) * reach,
            player.pos.y + hero.movement.height * 0.7,
            player.pos.z + (a.z / h) * reach,
        )
        pr.vel = Vec3(dx * speed, dy * speed, dz * speed)
        pr.mode = "thrown"
        pr.holder = None
        pr.hit = []
        pr.thrower = player_id
        return [{"type": "throw", "id": pr.id, "by": player_id}]

    def volatile_targets(self) -> list[Target]:
        """Volatile props in the air right now: what a laser bolt or rocket burst can detonate. Ids are `prop:<n>`."""
        out: list[Target] = []
        for pr in self.props:
            d = self.defs[pr.def_id]
            if pr.mode != "thrown" or getattr(d, "detonation", None) is None:
                continue
            out.append(Target(f"prop:{pr.id}", pr.pos, d.size.halfWidth, d.size.height))
        return out

    def detonate(self, pid: int) -> tuple[Vec3, SimpleNamespace, str | None, list[dict[str, Any]]] | None:
        """Blow up a thrown volatile prop. Returns (centre, def, thrower, events) or None."""
        pr = self.props[pid] if 0 <= pid < len(self.props) else None
        d = self.defs[pr.def_id] if pr is not None else None
        if pr is None or d is None or getattr(d, "detonation", None) is None or pr.mode != "thrown":
            return None
        centre = Vec3(pr.pos.x, pr.pos.y + d.size.height / 2, pr.pos.z)
        events: list[dict[str, Any]] = []
        self._destroy(pr, d, events)
        return centre, d, pr.thrower, events

    def drop_held_by(self, player_id: str, at: Vec3) -> None:
        for pr in self.props:
            if pr.mode == "held" and pr.holder == player_id:
                pr.mode = "resting"
                pr.holder = None
                pr.pos = at.copy()
                pr.vel = Vec3()

    def step(self, dt: float, hooks: PropHooks) -> list[dict[str, Any]]:
        """Advance every prop one tick. `hooks.holder_top(player_id)` gives the point above a carrier's head, or None."""
        events: list[dict[str, Any]] = []
        for pr in self.props:
            d = self.defs[pr.def_id]
            if pr.mode == "held":
                top = hooks.holder_top(pr.holder) if pr.holder else None
                if top is not None:
                    pr.pos = top
                else:
                    pr.mode = "resting"
                    pr.holder = None
            elif pr.mode == "destroyed":
                pr.respawn -= dt
                if pr.respawn <= 0:
                    pr.mode = "resting"
                    pr.pos = pr.home.copy()
                    pr.vel = Vec3()
                    pr.hp = int(d.hp)
                    events.append({"type": "propRespawn", "id": pr.id})
            elif pr.mode == "resting":
                pr.vel.y -= GRAVITY * dt
                r = move_and_collide(pr.pos, Vec3(0.0, pr.vel.y * dt, 0.0), d.size, self.world.active)
                if r.hit_down or r.hit_up:
                    pr.vel.y = 0.0
                if pr.pos.y < self.world.kill_y:
                    self._destroy(pr, d, events)
            elif pr.mode == "thrown":
                self._step_thrown(pr, d, dt, hooks, events)
        return events

    def _destroy(self, pr: PropState, d: SimpleNamespace, events: list[dict[str, Any]]) -> None:
        pr.mode = "destroyed"
        pr.respawn = float(d.respawnTime)
        pr.vel = Vec3()
        pr.holder = None
        events.append({"type": "propBreak", "id": pr.id})

    def _step_thrown(
        self, pr: PropState, d: SimpleNamespace, dt: float, hooks: PropHooks, events: list[dict[str, Any]]
    ) -> None:
        pr.vel.y -= GRAVITY * dt
        speed_before = math.hypot(pr.vel.x, pr.vel.y, pr.vel.z)
        r = move_and_collide(
            pr.pos, Vec3(pr.vel.x * dt, pr.vel.y * dt, pr.vel.z * dt), d.size, self.world.active
        )

        # Enemies in the way take the hit; the prop loses some of its force and a hit point.
        struck: list[str] = []
        if hooks.enemies is not None and hooks.hit_enemy is not None:
            for e in hooks.enemies():
                if e.id in pr.hit:
                    continue
                overlap = (
                    abs(e.pos.x - pr.pos.x) < d.size.halfWidth + e.half_width
                    and abs(e.pos.z - pr.pos.z) < d.size.halfWidth + e.half_width
                    and pr.pos.y < e.pos.y + e.height
                    and pr.pos.y + d.size.height > e.pos.y
                )
                if not overlap:
                    continue
                pr.hit.append(e.id)
                struck.append(e.id)
                h = math.hypot(pr.vel.x, pr.vel.z) or 1.0
                hooks.hit_enemy(e.id, float(d.throwDamage), pr.vel.x / h, pr.vel.z / h, float(d.throwKnockback))
                pr.hp -= 1
                pr.vel.x *= 0.35
                pr.vel.z *= 0.35

        blocked = r.hit_x or r.hit_z or r.hit_up or r.hit_down
        if blocked and speed_before >= WALL_BREAK_SPEED:
            for c in r.side_hits:
                if c.breakable is not None and c.breakable <= d.breakPower and self.world.break_collider(c.id):
                    events.append({"type": "break", "id": c.id, "by": f"prop:{pr.id}"})
        if blocked or pr.hp <= 0:
            if blocked and speed_before >= IMPACT_SPEED:
                pr.hp -= 1
            events.append({"type": "impact", "id": pr.id, "speed": speed_before, "hits": struck})
            pr.vel = Vec3()
            if pr.hp <= 0:
                self._destroy(pr, d, events)
            else:
                pr.mode = "resting"
        elif struck:
            events.append({"type": "impact", "id": pr.id, "speed": speed_before, "hits": struck})
        if pr.mode == "thrown" and pr.pos.y < self.world.kill_y:
            self._destroy(pr, d, events)

    def to_wire(self) -> list[dict[str, Any]]:
        return [
            {
                "id": p.id,
                "def": p.def_id,
                "pos": p.pos.to_list(),
                "vel": p.vel.to_list(),
                "mode": p.mode,
                "holder": p.holder,
                "hp": p.hp,
                "respawn": p.respawn,
            }
            for p in self.props
        ]
