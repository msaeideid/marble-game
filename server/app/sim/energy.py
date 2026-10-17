from __future__ import annotations

from types import SimpleNamespace
from typing import Protocol


class EnergyState(Protocol):
    energy: float
    energy_delay: float


def try_spend(s: EnergyState, amount: float, p: SimpleNamespace) -> bool:
    """All-or-nothing spend. Returns False (and changes nothing) if there is not enough energy."""
    if s.energy < amount:
        return False
    s.energy -= amount
    s.energy_delay = p.regenDelay
    return True


def drain(s: EnergyState, amount: float, p: SimpleNamespace) -> bool:
    """Continuous drain. Clamps at zero and returns True while there is energy left."""
    s.energy = max(0.0, s.energy - amount)
    s.energy_delay = p.regenDelay
    return s.energy > 0


def regen(s: EnergyState, p: SimpleNamespace, dt: float) -> None:
    if s.energy_delay > 0:
        s.energy_delay = max(0.0, s.energy_delay - dt)
        return
    s.energy = min(p.max, s.energy + p.regenPerSecond * dt)
