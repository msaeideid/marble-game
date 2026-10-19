"""Melee combo state machine, melee targeting and the snare pick. Mirrors client/src/sim/combat.ts."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from .vec import Vec3
from .world import World


@dataclass(slots=True)
class MeleeState:
    phase: str = "idle"  # idle | windup | recovery
    timer: float = 0.0
    step: int = 0  # index of the combo step being (or last) performed
    combo_timer: float = 0.0  # while > 0 the next attack continues the combo
    buffer: float = 0.0  # a press remembered for this many more seconds


def step_melee(m: MeleeState, pressed: bool, p: SimpleNamespace, dt: float, spend: Callable[[float], bool]) -> int | None:
    """Advance the melee state machine one tick. Returns the combo step whose hit lands this tick, or None."""
    m.buffer = float(p.inputBuffer) if pressed else max(0.0, m.buffer - dt)
    if m.phase != "windup":
        m.combo_timer = max(0.0, m.combo_timer - dt)

    if m.phase == "idle" and m.buffer > 0:
        m.buffer = 0.0
        if p.cost == 0 or spend(p.cost):
            m.step = (m.step + 1) % len(p.steps) if m.combo_timer > 0 else 0
            m.phase = "windup"
            m.timer = float(p.windup)

    hit: int | None = None
    if m.phase == "windup":
        m.timer -= dt
        if m.timer <= 0:
            hit = m.step
            m.phase = "recovery"
            m.timer = float(p.recovery)
            m.combo_timer = p.comboWindow + p.recovery
    elif m.phase == "recovery":
        m.timer -= dt
        if m.timer <= 0:
            m.phase = "idle"
    return hit


@dataclass(slots=True)
class Candidate:
    obj: Any
    pos: Vec3
    half_width: float
    height: float = 0.0


def melee_targets(attacker: Vec3, yaw: float, p: SimpleNamespace, candidates: list[Candidate]) -> list[Candidate]:
    """Targets inside the attacker's frontal arc. `yaw` is the attack heading (0 = +Z)."""
    fx = math.sin(yaw)
    fz = math.cos(yaw)
    min_cos = math.cos((p.arcDegrees * math.pi) / 360)
    out: list[Candidate] = []
    for c in candidates:
        dx = c.pos.x - attacker.x
        dz = c.pos.z - attacker.z
        dist = math.hypot(dx, dz)
        if dist > p.range + c.half_width:
            continue
        if abs(c.pos.y - attacker.y) > p.verticalReach:
            continue
        if dist > 0.05 and (dx * fx + dz * fz) / dist < min_cos:
            continue
        out.append(c)
    return out


def pick_snare_target(
    world: World, origin: Vec3, d: Vec3, p: SimpleNamespace, candidates: list[Candidate]
) -> Candidate | None:
    """The nearest enemy within `radius` of the aim ray (up to `range`) that has a clear line of sight."""
    best: Candidate | None = None
    best_t = math.inf
    for c in candidates:
        cx = c.pos.x - origin.x
        cy = c.pos.y + c.height / 2 - origin.y
        cz = c.pos.z - origin.z
        t = cx * d.x + cy * d.y + cz * d.z
        if t < 0 or t > p.range or t >= best_t:
            continue
        off2 = cx * cx + cy * cy + cz * cz - t * t
        if off2 > p.radius * p.radius:
            continue
        wall = world.raycast(origin, d, t)
        if wall is not None and wall.distance < t - 0.5:
            continue
        best = c
        best_t = t
    return best
