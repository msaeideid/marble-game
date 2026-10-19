"""Enemy state and physics. Mirrors client/src/sim/enemy.ts."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .controller import move_and_collide
from .health import HealthState, create_health
from .vec import Vec3
from .world import World

GRAVITY = 28.0
KNOCKBACK_FRICTION = 8.0  # fraction of horizontal knockback speed lost per second


@dataclass(slots=True)
class EnemyState:
    id: str
    type_id: str
    pos: Vec3
    prev_pos: Vec3
    health: HealthState
    vel: Vec3 = field(default_factory=Vec3)
    facing: float = 0.0
    grounded: bool = False
    defeated_timer: float | None = None  # seconds left of the power-down animation after defeat
    ai_state: str = "idle"  # idle | chase | windup | recovery | stagger
    ai_timer: float = 0.0
    attack_cooldown: float = 0.0
    snared_timer: float = 0.0
    poise_timer: float = 0.0


def create_enemy(eid: str, d: SimpleNamespace, pos: Vec3) -> EnemyState:
    return EnemyState(eid, d.id, pos.copy(), pos.copy(), create_health(d.health))


def step_enemy_physics(e: EnemyState, d: SimpleNamespace, world: World, dt: float) -> None:
    e.prev_pos = e.pos.copy()
    e.vel.y -= GRAVITY * dt
    decay = max(0.0, 1 - KNOCKBACK_FRICTION * dt)
    e.vel.x *= decay
    e.vel.z *= decay
    r = move_and_collide(e.pos, Vec3(e.vel.x * dt, e.vel.y * dt, e.vel.z * dt), d.move, world.active)
    if r.hit_x:
        e.vel.x = 0.0
    if r.hit_z:
        e.vel.z = 0.0
    e.grounded = r.hit_down
    if r.hit_down or r.hit_up:
        e.vel.y = 0.0


def enemy_wire(e: EnemyState) -> dict[str, Any]:
    """The part of an enemy that clients draw (snapshots) and conformance scenarios record."""
    return {
        "id": e.id,
        "type": e.type_id,
        "pos": e.pos.to_list(),
        "vel": e.vel.to_list(),
        "facing": e.facing,
        "ai": e.ai_state,
        "aiTimer": e.ai_timer,
        "shield": e.health.shield,
        "core": e.health.core,
        "snared": e.snared_timer,
        "poise": e.poise_timer,
        "cooldown": e.attack_cooldown,
        "defeated": e.defeated_timer,
    }
