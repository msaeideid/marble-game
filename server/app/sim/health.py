"""Shield-over-core health. Mirrors client/src/sim/health.ts."""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace


@dataclass(slots=True)
class HealthState:
    shield: float
    core: float
    shield_delay: float = 0.0  # seconds until the shield starts regenerating
    core_delay: float = 0.0


def create_health(p: SimpleNamespace) -> HealthState:
    return HealthState(float(p.shield.max), float(p.core.max))


def apply_damage(h: HealthState, amount: float, p: SimpleNamespace) -> tuple[float, float, bool]:
    """The shield absorbs damage first; the rest hits the core. Returns (shield lost, core lost, defeated)."""
    shield_lost = min(h.shield, amount)
    core_lost = min(h.core, amount - shield_lost)
    h.shield -= shield_lost
    h.core -= core_lost
    h.shield_delay = float(p.shield.regenDelay)
    h.core_delay = float(p.core.regenDelay)
    return shield_lost, core_lost, h.core <= 0


def regen_health(h: HealthState, p: SimpleNamespace, dt: float) -> None:
    if h.core <= 0:
        return
    if h.shield_delay > 0:
        h.shield_delay = max(0.0, h.shield_delay - dt)
    else:
        h.shield = min(float(p.shield.max), h.shield + p.shield.regenPerSecond * dt)
    if h.core_delay > 0:
        h.core_delay = max(0.0, h.core_delay - dt)
    else:
        h.core = min(float(p.core.max), h.core + p.core.regenPerSecond * dt)
