"""Replays the TypeScript-generated scenarios in shared/conformance/movement against the Python sim port."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from app.sim.content import load_hero, load_level, shared_dir
from app.sim.controller import Intent, create_player_state, step_player, to_wire
from app.sim.vec import Vec3
from app.sim.world import World

SCENARIOS = sorted((shared_dir() / "conformance" / "movement").glob("*.json"))

# Largest allowed difference between the two languages for any number in the state.
TOLERANCE = 1e-9


def distance(a: Any, b: Any, path: str = "") -> float:
    """Largest numeric difference between two wire states; inf if booleans / None-ness differ."""
    if a is None or b is None:
        return 0.0 if a is None and b is None else math.inf
    if isinstance(a, bool) or isinstance(b, bool):
        return 0.0 if a == b else math.inf
    if isinstance(a, (int, float)):
        return abs(float(a) - float(b))
    if isinstance(a, list):
        return max((distance(x, y, path) for x, y in zip(a, b, strict=True)), default=0.0)
    if isinstance(a, dict):
        assert a.keys() == b.keys(), f"keys differ at {path}"
        return max((distance(a[k], b[k], f"{path}.{k}") for k in a), default=0.0)
    return 0.0 if a == b else math.inf


def replay(sc: dict[str, Any]) -> list[tuple[int, dict[str, Any], list[int]]]:
    hero = load_hero(sc["hero"])
    world = World(load_level("arena"))
    s = create_player_state(world.spawn, hero)
    s.pos = Vec3.from_list(sc["start"]["pos"])
    s.prev_pos = s.pos.copy()
    out: list[tuple[int, dict[str, Any], list[int]]] = []
    tick = 0
    every = sc["checkpointEvery"]
    for seg in sc["segments"]:
        intent = Intent.from_dict(seg["intent"])
        for i in range(seg["ticks"]):
            if i > 0:
                intent.jumpPressed = False
                intent.zipPressed = False
                intent.chargePressed = False
            step_player(s, intent, hero, world, sc["dt"])
            tick += 1
            if tick % every == 0:
                out.append((tick, to_wire(s), world.broken_list()))
    if tick % every != 0:
        out.append((tick, to_wire(s), world.broken_list()))
    return out


def test_scenarios_exist() -> None:
    assert len(SCENARIOS) >= 10


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: Path(p).stem)
def test_python_matches_typescript(path: Path) -> None:
    sc = json.loads(path.read_text(encoding="utf8"))
    got = replay(sc)
    assert len(got) == len(sc["expected"])
    worst = 0.0
    worst_tick = 0
    for (tick, state, broken), exp in zip(got, sc["expected"], strict=True):
        assert tick == exp["tick"]
        assert broken == exp["broken"], f"broken walls differ at tick {tick}"
        d = distance(state, exp["state"])
        if d > worst:
            worst, worst_tick = d, tick
    print(f"\n{path.stem}: worst drift {worst:.3e} at tick {worst_tick}")
    assert worst < TOLERANCE, f"{path.stem} drifted {worst} at tick {worst_tick}"


def test_scenarios_actually_exercise_the_movement_features() -> None:
    """Guards against recording boring scenarios that would pass trivially."""
    seen_tether = seen_zip = seen_airborne = seen_low_energy = seen_charge = seen_broken = False
    for path in SCENARIOS:
        sc = json.loads(path.read_text(encoding="utf8"))
        for exp in sc["expected"]:
            st = exp["state"]
            seen_tether |= st["tether"] is not None
            seen_zip |= st["zip"] is not None
            seen_airborne |= not st["grounded"]
            seen_low_energy |= st["energy"] < 5
            seen_charge |= st["charge"] is not None
            seen_broken |= len(exp["broken"]) > 0
    assert seen_tether and seen_zip and seen_airborne and seen_low_energy and seen_charge and seen_broken
