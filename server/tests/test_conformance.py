"""Replays the TypeScript-generated scenarios in shared/conformance/movement against the Python sim port."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from app.sim.content import load_hero, load_level, load_props, shared_dir
from app.sim.controller import Intent, to_wire
from app.sim.game import GameSim
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


def replay(sc: dict[str, Any]) -> list[tuple[int, dict[str, Any], list[int], list[dict[str, Any]]]]:
    hero = load_hero(sc["hero"])
    world = World(load_level("arena"))
    game = GameSim(world, load_props(), hero)
    s = game.add_player("p1", hero)
    s.pos = Vec3.from_list(sc["start"]["pos"])
    s.prev_pos = s.pos.copy()
    out: list[tuple[int, dict[str, Any], list[int], list[dict[str, Any]]]] = []

    def record(t: int) -> None:
        out.append((t, to_wire(s), world.broken_list(), game.props.to_wire() if game.props else []))

    tick = 0
    every = sc["checkpointEvery"]
    for seg in sc["segments"]:
        intent = Intent.from_dict(seg["intent"])
        for i in range(seg["ticks"]):
            if i > 0:
                intent.jumpPressed = False
                intent.zipPressed = False
                intent.chargePressed = False
                intent.grabPressed = False
            game.step({"p1": intent}, sc["dt"])
            tick += 1
            if tick % every == 0:
                record(tick)
    if tick % every != 0:
        record(tick)
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
    for (tick, state, broken, props), exp in zip(got, sc["expected"], strict=True):
        assert tick == exp["tick"]
        assert broken == exp["broken"], f"broken walls differ at tick {tick}"
        assert len(props) == len(exp["props"])
        for mine, theirs in zip(props, exp["props"], strict=True):
            assert mine["mode"] == theirs["mode"] and mine["holder"] == theirs["holder"], f"prop {mine['id']} at tick {tick}"
            assert mine["hp"] == theirs["hp"]
            worst_prop = max(distance(mine["pos"], theirs["pos"]), distance(mine["vel"], theirs["vel"]), abs(mine["respawn"] - theirs["respawn"]))
            assert worst_prop < TOLERANCE, f"prop {mine['id']} drifted {worst_prop} at tick {tick}"
        d = distance(state, exp["state"])
        if d > worst:
            worst, worst_tick = d, tick
    print(f"\n{path.stem}: worst drift {worst:.3e} at tick {worst_tick}")
    assert worst < TOLERANCE, f"{path.stem} drifted {worst} at tick {worst_tick}"


def test_scenarios_actually_exercise_the_movement_features() -> None:
    """Guards against recording boring scenarios that would pass trivially."""
    seen_tether = seen_zip = seen_airborne = seen_low_energy = seen_charge = seen_broken = False
    seen_carry = seen_thrown = seen_destroyed = False
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
            seen_carry |= st["carrying"] is not None
            seen_thrown |= any(p["mode"] == "thrown" for p in exp["props"])
            seen_destroyed |= any(p["mode"] == "destroyed" for p in exp["props"])
    assert seen_tether and seen_zip and seen_airborne and seen_low_energy and seen_charge and seen_broken
    assert seen_carry and seen_thrown and seen_destroyed
