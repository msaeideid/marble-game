"""Combat conformance: the Python GameSim must reproduce the TypeScript Sim on shared/conformance/combat scenarios.

Each scenario is a recorded input log. Both sides replay it and must agree on every checkpoint: each player's movement
and combat state, every enemy, rocket, strike and prop, the broken walls, the wave number and how many events of each
type happened. Floats must agree to 1e-9; everything else exactly.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from app.sim.content import load_enemies, load_hero, load_level, load_props, shared_dir
from app.sim.controller import Intent, combat_wire, to_wire
from app.sim.game import GameSim
from app.sim.vec import Vec3
from app.sim.world import World

TOLERANCE = 1e-9
SCENARIO_DIR = shared_dir() / "conformance" / "combat"
SCENARIOS = sorted(SCENARIO_DIR.glob("*.json"))

# Button *presses* only exist on the first tick of a segment.
EDGES = (
    "jumpPressed",
    "zipPressed",
    "attackPressed",
    "snarePressed",
    "chargePressed",
    "grabPressed",
    "rocketPressed",
    "chainPressed",
    "stormPressed",
)


def build_level(opts: dict[str, Any]) -> dict[str, Any]:
    level = load_level("arena")
    if opts.get("noBase"):
        level.pop("base", None)
    if opts.get("openField"):
        level["colliders"] = [level["colliders"][0]]
    if "props" in opts:
        level["props"] = opts["props"]
    return level


def replay(sc: dict[str, Any]) -> list[dict[str, Any]]:
    opts = sc["level"]
    world = World(build_level(opts))
    game = GameSim(
        world,
        load_props(),
        load_hero(sc["players"][0]["hero"]),
        load_enemies(),
        waves=bool(opts.get("waves", False)),
    )
    for p in sc["players"]:
        s = game.add_player(p["id"], load_hero(p["hero"]))
        s.pos = Vec3.from_list(p["pos"])
        s.prev_pos = s.pos.copy()
        s.invulnerable = 0.0
    for e in sc["enemies"]:
        en = game.spawn_enemy(e["type"], Vec3.from_list(e["pos"]))
        en.snared_timer = float(e.get("snared") or 0)

    out: list[dict[str, Any]] = []
    counts: dict[str, int] = {}

    def record(tick: int) -> None:
        out.append(
            {
                "tick": tick,
                "players": {
                    p["id"]: {"state": to_wire(game.players[p["id"]]), "combat": combat_wire(game.players[p["id"]])}
                    for p in sc["players"]
                },
                "enemies": game.enemy_wires(),
                "rockets": game.rocket_system.to_wire() if game.rocket_system else [],
                "strikes": game.strike_system.to_wire() if game.strike_system else [],
                "props": game.props.to_wire() if game.props else [],
                "broken": game.world.broken_list(),
                "wave": game.wave,
                "events": {k: counts[k] for k in sorted(counts)},
            }
        )
        counts.clear()

    tick = 0
    every = sc["checkpointEvery"]
    for seg in sc["segments"]:
        for i in range(seg["ticks"]):
            intents = {}
            for pid, raw in seg["intents"].items():
                d = dict(raw)
                if i > 0:
                    for k in EDGES:
                        d[k] = False
                intents[pid] = Intent.from_dict(d)
            game.step(intents, sc["dt"])
            for ev in game.events:
                counts[ev["type"]] = counts.get(ev["type"], 0) + 1
            tick += 1
            if tick % every == 0:
                record(tick)
    if tick % every != 0:
        record(tick)
    return out


def first_difference(a: Any, b: Any, path: str = "") -> str | None:
    """Where two JSON-like values first differ (floats within tolerance), or None if they agree."""
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None:
        return None if a == b else f"{path}: {a!r} != {b!r}"
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return None if math.isclose(a, b, rel_tol=0, abs_tol=TOLERANCE) else f"{path}: {a!r} != {b!r}"
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return f"{path}: keys {sorted(a)} != {sorted(b)}"
        for k in a:
            d = first_difference(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            d = first_difference(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    return None if a == b else f"{path}: {a!r} != {b!r}"


def test_scenarios_exist() -> None:
    assert len(SCENARIOS) >= 10


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: Path(p).stem)
def test_python_matches_typescript(path: Path) -> None:
    sc = json.loads(path.read_text(encoding="utf8"))
    got = replay(sc)
    assert len(got) == len(sc["expected"])
    for mine, theirs in zip(got, sc["expected"], strict=True):
        diff = first_difference(mine, theirs, f"tick {mine['tick']}")
        assert diff is None, f"{path.stem} diverged at {diff}"


def test_scenarios_actually_exercise_combat() -> None:
    """Guards against recording boring scenarios that would pass trivially."""
    seen: set[str] = set()
    most_enemies = 0
    for path in SCENARIOS:
        sc = json.loads(path.read_text(encoding="utf8"))
        for cp in sc["expected"]:
            seen.update(cp["events"])
            most_enemies = max(most_enemies, len(cp["enemies"]))
    wanted = {
        "melee", "damage", "defeated", "enemyAttack", "respawn", "snare", "charge", "laser", "rocketLaunch",
        "explosion", "chain", "strikeStart", "strikeHit", "detonate", "throw", "impact", "wave",
    }  # fmt: skip
    assert wanted <= seen, f"scenarios never exercise: {sorted(wanted - seen)}"
    assert most_enemies >= 3
