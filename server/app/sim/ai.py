"""Thug behaviour: idle -> chase -> windup -> recovery -> chase. Mirrors client/src/sim/ai.ts."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace

from .enemy import EnemyState
from .vec import Vec3

HIT_LENIENCY = 0.6  # how far (m) a target may drift out of range during a windup and still be hit
MAX_VERTICAL_REACH = 1.6  # largest vertical gap (m) at which a thug can start or land an attack
SEPARATION_RADIUS = 1.3


@dataclass(slots=True)
class AiTarget:
    id: str
    pos: Vec3


def step_enemy_ai(
    e: EnemyState,
    d: SimpleNamespace,
    targets: list[AiTarget],
    neighbours: list[EnemyState],
    dt: float,
    attack: Callable[[str], None],
) -> None:
    e.attack_cooldown = max(0.0, e.attack_cooldown - dt)
    e.poise_timer = max(0.0, e.poise_timer - dt)

    if e.snared_timer > 0:
        e.snared_timer = max(0.0, e.snared_timer - dt)
        e.vel.x = 0.0
        e.vel.z = 0.0
        return

    if e.ai_state == "stagger":
        e.ai_timer -= dt
        if e.ai_timer <= 0:
            e.ai_state = "chase"
            e.poise_timer = float(d.poiseTime)
        return

    target = _nearest(e, targets, float(d.aggroRange))
    if target is None:
        e.ai_state = "idle"
        return
    if e.ai_state == "idle":
        e.ai_state = "chase"

    dx = target.pos.x - e.pos.x
    dz = target.pos.z - e.pos.z
    dist = math.hypot(dx, dz)
    dy = abs(target.pos.y - e.pos.y)
    if dist > 0.01:
        e.facing = math.atan2(dx, dz)

    if e.ai_state == "chase":
        if dist <= d.attack.range and dy <= MAX_VERTICAL_REACH and e.attack_cooldown <= 0:
            e.ai_state = "windup"
            e.ai_timer = float(d.attack.windup)
            e.vel.x = 0.0
            e.vel.z = 0.0
            return
        _steer(e, d, dx, dz, dist, neighbours)
    elif e.ai_state == "windup":
        e.vel.x = 0.0
        e.vel.z = 0.0
        e.ai_timer -= dt
        if e.ai_timer <= 0:
            if dist <= d.attack.range + HIT_LENIENCY and dy <= MAX_VERTICAL_REACH + 0.2:
                attack(target.id)
            e.ai_state = "recovery"
            e.ai_timer = float(d.attack.recovery)
            e.attack_cooldown = float(d.attack.cooldown)
    elif e.ai_state == "recovery":
        e.vel.x = 0.0
        e.vel.z = 0.0
        e.ai_timer -= dt
        if e.ai_timer <= 0:
            e.ai_state = "chase"


def _nearest(e: EnemyState, targets: list[AiTarget], rng: float) -> AiTarget | None:
    best: AiTarget | None = None
    best_dist = rng
    for t in targets:
        dist = math.hypot(t.pos.x - e.pos.x, t.pos.z - e.pos.z)
        if dist <= best_dist:
            best = t
            best_dist = dist
    return best


def _steer(e: EnemyState, d: SimpleNamespace, dx: float, dz: float, dist: float, neighbours: list[EnemyState]) -> None:
    """Walk toward the target, stopping just inside attack range and shoving apart from crowding neighbours."""
    vx = 0.0
    vz = 0.0
    if dist > d.attack.range * 0.85:
        vx = (dx / dist) * d.move.speed
        vz = (dz / dist) * d.move.speed
    for n in neighbours:
        if n is e or n.defeated_timer is not None:
            continue
        sx = e.pos.x - n.pos.x
        sz = e.pos.z - n.pos.z
        dd = math.hypot(sx, sz)
        if 0 < dd < SEPARATION_RADIUS:
            push = ((SEPARATION_RADIUS - dd) / SEPARATION_RADIUS) * d.move.speed
            vx += (sx / dd) * push
            vz += (sz / dd) * push
    speed = math.hypot(vx, vz)
    mx = d.move.speed
    if speed > mx:
        vx = (vx / speed) * mx
        vz = (vz / speed) * mx
    e.vel.x = vx
    e.vel.z = vz
