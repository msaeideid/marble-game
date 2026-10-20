"""Generate the campaign's levels and missions (deterministic). Run from the repo root:

    python tools/gen_content.py

Writes shared/levels/*.json and shared/data/missions/*.json. Everything is plain data, so after generating you can
hand-edit any file; re-running overwrites them. The names, story text and numbers below are placeholders the game's
author is free to change (see docs/CAMPAIGN.md, "Decisions for you").
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEVELS = ROOT / "shared" / "levels"
MISSIONS = ROOT / "shared" / "data" / "missions"


def write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf8", newline="\n")


# ------------------------------------------------------------------ level helpers
def box(kind: str, lo: list[float], hi: list[float], **extra: object) -> dict:
    return {"kind": kind, "min": lo, "max": hi, **extra}


def building(cx: float, cz: float, w: float, d: float, h: float) -> dict:
    return box("building", [cx - w / 2, 0, cz - d / 2], [cx + w / 2, h, cz + d / 2])


def hashed(i: int, j: int, seed: int) -> int:
    return ((i * 73856093) ^ (j * 19349663) ^ (seed * 83492791)) & 0xFFFFFFFF


def level(lid: str, name: str, theme: dict, spawn: list[float], colliders: list[dict], **extra: object) -> dict:
    return {
        "id": lid,
        "name": name,
        "theme": theme,
        "spawn": spawn,
        "killY": extra.pop("killY", -40),
        "waveDelay": 5,
        "base": extra.pop("base", None),
        "enemySpawns": [],
        "props": extra.pop("props", []),
        "colliders": colliders,
        **extra,
    }


def clean(lv: dict) -> dict:
    if lv.get("base") is None:
        lv.pop("base", None)
    return lv


def pad(x: float, z: float) -> dict:
    return {"pos": [x, 0, z], "radius": 5, "regenPerSecond": 25}


GROUND = lambda r: box("ground", [-r, -2, -r], [r, 0, r])  # noqa: E731

THEMES = {
    "city": {"sky": [0.55, 0.78, 0.95], "ground": [0.5, 0.78, 0.5], "buildings": [[0.93, 0.45, 0.45], [0.4, 0.62, 0.95], [0.98, 0.78, 0.35], [0.62, 0.5, 0.9]]},
    "arena": {"sky": [0.75, 0.82, 0.95], "ground": [0.78, 0.78, 0.82], "buildings": [[0.55, 0.5, 0.75], [0.45, 0.45, 0.7], [0.65, 0.55, 0.8]]},
    "sugar": {"sky": [1.0, 0.85, 0.92], "ground": [0.98, 0.9, 0.82], "buildings": [[1.0, 0.55, 0.7], [0.55, 0.9, 0.78], [1.0, 0.85, 0.45], [0.75, 0.6, 0.95]]},
    "cloud": {"sky": [0.62, 0.84, 1.0], "ground": [0.96, 0.97, 1.0], "buildings": [[0.7, 0.85, 1.0], [1.0, 0.85, 0.7], [0.85, 0.75, 1.0]]},
    "gear": {"sky": [0.32, 0.3, 0.38], "ground": [0.42, 0.4, 0.38], "buildings": [[0.75, 0.55, 0.25], [0.6, 0.45, 0.3], [0.5, 0.5, 0.55], [0.8, 0.65, 0.35]]},
    "finale": {"sky": [0.28, 0.2, 0.42], "ground": [0.4, 0.34, 0.5], "buildings": [[0.55, 0.35, 0.8], [0.4, 0.3, 0.7], [0.7, 0.4, 0.85]]},
    "ash": {"sky": [0.7, 0.66, 0.66], "ground": [0.5, 0.55, 0.45], "buildings": [[0.55, 0.4, 0.4], [0.4, 0.45, 0.6], [0.6, 0.55, 0.4], [0.5, 0.42, 0.55]]},
}


# ------------------------------------------------------------------ levels
def tutorial() -> tuple[dict, dict]:
    cols = [GROUND(70)]
    for sx in (-1, 1):
        for z in (-8, 12, 30):
            cols.append(building(sx * 18, z, 10, 10, 8 + (z % 7)))
    cols.append(box("wall", [-4, 0, 10], [4, 5, 11.5], breakable=1))  # a weak wall across the way: charge or throw
    cols.append(box("crate", [8, 0, -14], [10, 2, -12]))
    lv = level("tutorial", "Brightport Training Grounds", THEMES["city"], [0, 0.01, -35], cols, base=pad(0, -35),
               props=[{"type": "prop.car", "pos": [6, 0, 0]}, {"type": "prop.crate", "pos": [-6, 0, -4]}, {"type": "prop.dumpster", "pos": [-7, 0, 20]}])
    return clean(lv), {"start": [0, 0.01, -35], "exit": [0, 0.01, 38], "fight": [0, 0.01, 22]}


def boss_arena(lid: str, name: str, theme: dict, radius: float, pillars: int, cars: int) -> tuple[dict, dict]:
    import math

    cols = [GROUND(radius + 20)]
    for k in range(pillars):
        a = k / pillars * math.tau
        cols.append(building(round(math.sin(a) * radius * 0.55, 1), round(math.cos(a) * radius * 0.55, 1), 4, 4, 14))
    props = []
    for k in range(cars):
        a = (k + 0.5) / cars * math.tau
        props.append({"type": "prop.car" if k % 3 else "prop.dumpster", "pos": [round(math.sin(a) * radius * 0.3, 1), 0, round(math.cos(a) * radius * 0.3, 1)]})
    lv = level(lid, name, theme, [0, 0.01, -radius + 8], cols, base=pad(0, -radius + 8), props=props)
    return clean(lv), {"start": [0, 0.01, -radius + 8], "boss": [0, 0.01, radius * 0.45], "ring": [0, 0.01, 0]}


def grid_city(lid: str, name: str, theme: dict, S: float, block: float, hmin: int, hmax: int, seed: int, plugs: bool,
              plaza_cells: set[tuple[int, int]]) -> tuple[dict, dict]:
    """A 7x7 district grid. Streets run between the blocks; intersections are at ((i+.5)S, (j+.5)S)."""
    R = 3
    ix = lambda i: round((i + 0.5) * S, 3)  # noqa: E731
    cols = [GROUND((R + 1) * S)]
    for i in range(-R, R + 1):
        for j in range(-R, R + 1):
            if (i, j) in plaza_cells:
                continue
            h = hmin + hashed(i, j, seed) % (hmax - hmin + 1)
            cols.append(building(i * S, j * S, block, block, h))
    anchors_idx = [(-4, -4), (-4, 0), (0, 0), (0, 3), (1, 3), (1, 1), (2, 2), (-2, -1), (0, 2), (2, 0), (-2, -3), (2, -2), (-1, 1), (1, -1)]
    if plugs:
        # Weak walls plugging street segments (secret shortcuts for the charge). A plug is only kept if every place the
        # missions use can still be reached without breaking anything.
        g = (S - block) / 2 - 0.05
        edges = [("ns", i, j) for i in range(-4, 4) for j in range(-4, 3)] + [("ew", i, j) for i in range(-4, 3) for j in range(-4, 4)]
        plugged: set[tuple[str, int, int]] = set()

        def connected(blocked: set[tuple[str, int, int]]) -> bool:
            seen = {anchors_idx[0]}
            todo = [anchors_idx[0]]
            while todo:
                i, j = todo.pop()
                for kind, ni, nj in (("ns", i, j), ("ns", i, j - 1), ("ew", i, j), ("ew", i - 1, j)):
                    if (kind, ni, nj) in blocked:
                        continue
                    other = {("ns", i, j): (i, j + 1), ("ns", i, j - 1): (i, j - 1), ("ew", i, j): (i + 1, j), ("ew", i - 1, j): (i - 1, j)}[(kind, ni, nj)]
                    if -4 <= other[0] <= 3 and -4 <= other[1] <= 3 and other not in seen:
                        seen.add(other)
                        todo.append(other)
            return all(a in seen for a in anchors_idx)

        for kind, i, j in edges:
            ni, nj = (i, j + 1) if kind == "ns" else (i + 1, j)
            cell_a = (i + 1, j + 1) if kind == "ns" else (i + 1, j + 1)
            if (cell_a in plaza_cells) or hashed(i, j, seed + 7 + (kind == "ew")) % 4 != 0:
                continue
            trial = plugged | {(kind, i, j)}
            if connected(trial):
                plugged = trial
                if kind == "ns":
                    cols.append(box("wall", [ix(i) - g, 0, (j + 1) * S - 0.6], [ix(i) + g, 5, (j + 1) * S + 0.6], breakable=1))
                else:
                    cols.append(box("wall", [(i + 1) * S - 0.6, 0, ix(j) - g], [(i + 1) * S + 0.6, 5, ix(j) + g], breakable=1))
    props = []
    for k in range(6):
        i, j = (-3 + (hashed(k, 1, seed) % 7)), (-3 + (hashed(k, 2, seed) % 7))
        props.append({"type": ["prop.car", "prop.crate", "prop.dumpster"][k % 3], "pos": [ix(i), 0, ix(j) + 2.5]})
    lv = level(lid, name, theme, [ix(-4), 0.01, ix(-4)], cols, base=pad(ix(-4) + 6, ix(-4)), props=props)
    plaza_x = sum(c[0] for c in plaza_cells) / max(1, len(plaza_cells)) * S
    plaza_z = sum(c[1] for c in plaza_cells) / max(1, len(plaza_cells)) * S
    return clean(lv), {
        "start": [ix(-4), 0.01, ix(-4)],
        "wp1": [ix(-4), 0.01, ix(0)],
        "wp2": [ix(0), 0.01, ix(0)],
        "wp3": [ix(0), 0.01, ix(3)],
        "gate": [ix(1), 0.01, ix(1)],
        "boss": [plaza_x, 0.01, plaza_z],
        "camp1": [ix(-2), 0.01, ix(-1)],
        "camp2": [ix(0), 0.01, ix(2)],
        "camp3": [ix(2), 0.01, ix(0)],
        "spots": [[ix(-2), 0.01, ix(-3)], [ix(2), 0.01, ix(-2)], [ix(-1), 0.01, ix(1)], [ix(1), 0.01, ix(-1)]],
        "S": S,
    }


def cloudspire() -> tuple[dict, dict]:
    S, half = 22, 9.0
    cols: list[dict] = []
    cells = [(i, j) for j in range(-2, 3) for i in range(-2, 3)]
    for i, j in cells:
        cols.append(box("ground", [i * S - half, -2, j * S - half], [i * S + half, 0, j * S + half]))
        h = hashed(i, j, 31) % 4
        if h == 0:
            cols.append(building(i * S + 4, j * S - 4, 5, 5, 12))  # a tower to swing from
        elif h == 1:
            cols.append(building(i * S - 4, j * S + 4, 6, 4, 3))  # a low hut
    # serpentine route: row by row, snaking up the grid
    route: list[tuple[int, int]] = []
    for row, j in enumerate(range(-2, 3)):
        xs = range(-2, 3) if row % 2 == 0 else range(2, -3, -1)
        route += [(i, j) for i in xs]
    for (i0, j0), (i1, j1) in zip(route, route[1:], strict=False):
        cx, cz = (i0 + i1) / 2 * S, (j0 + j1) / 2 * S
        if i0 != i1:
            cols.append(box("ground", [cx - (S - 2 * half) / 2 - 0.5, -2, cz - 2.5], [cx + (S - 2 * half) / 2 + 0.5, 0, cz + 2.5]))
        else:
            cols.append(box("ground", [cx - 2.5, -2, cz - (S - 2 * half) / 2 - 0.5], [cx + 2.5, 0, cz + (S - 2 * half) / 2 + 0.5]))
    at = lambda k: [route[k][0] * S, 0.01, route[k][1] * S]  # noqa: E731
    props = [{"type": "prop.car" if k % 2 else "prop.crate", "pos": [route[k][0] * S + 3, 0, route[k][1] * S + 3]} for k in (3, 8, 13, 18)]
    lv = level("cloudspire", "Cloudspire", THEMES["cloud"], at(0), cols, killY=-25, base=pad(route[0][0] * S + 5, route[0][1] * S), props=props)
    return clean(lv), {
        "start": at(0), "wp1": at(6), "wp2": at(12), "wp3": at(18), "gate": at(22), "boss": at(24),
        "camp1": at(4), "camp2": at(10), "camp3": at(16),
        "spots": [at(2), at(8), at(14), at(20)],
        "S": S,
    }


def finale_level() -> tuple[dict, dict]:
    return boss_arena("finale", "The Shard Engine", THEMES["finale"], 52, 10, 6)


def damaged_hub() -> dict:
    a = json.loads((ROOT / "shared" / "levels" / "arena.json").read_text(encoding="utf8"))
    a["id"] = "arena_damaged"
    a["name"] = "Brightport (after VASTOR)"
    a["theme"] = THEMES["ash"]
    a["waveDelay"] = 4
    # rubble where he smashed through, and the thugs hit harder
    for x, z in ((12, -12), (-12, 12), (12, 12)):
        a["colliders"].append(box("crate", [x - 2, 0, z - 2], [x + 2, 2.5, z + 2]))
    a["enemySpawns"].append({"type": "enemy.brute", "pos": [0, 0.01, 30]})
    return a


# ------------------------------------------------------------------ missions
def at(p: list[float], dx: float = 0, dz: float = 0, y: float | None = None) -> list[float]:
    return [round(p[0] + dx, 2), p[1] if y is None else y, round(p[2] + dz, 2)]


def mission(mid: str, title: str, chapter: str, kind: str, lvl: str, summary: str, objectives: list[dict], **extra: object) -> dict:
    d = {
        "id": mid,
        "title": title,
        "chapter": chapter,
        "kind": kind,
        "level": lvl,
        "summary": summary,
        "requires": extra.pop("requires", {}),
        "objectives": objectives,
        "spawns": extra.pop("spawns", []),
        "dialogue": extra.pop("dialogue", []),
        "reward": extra.pop("reward", {"scrap": 20, "xp": 40}),
    }
    d.update(extra)
    return d


def reach(oid: str, text: str, p: list[float], radius: float = 4) -> dict:
    return {"id": oid, "text": text, "kind": "reach", "pos": p, "radius": radius}


def defeat(oid: str, text: str, n: int, enemy_type: str | None = None) -> dict:
    d = {"id": oid, "text": text, "kind": "defeat", "count": n}
    if enemy_type:
        d["enemyType"] = enemy_type
    return d


def say(when: dict, speaker: str, text: str) -> dict:
    return {"when": when, "speaker": speaker, "text": text}


def done(oid: str) -> dict:
    return {"objective": oid, "event": "complete"}


def begin(oid: str) -> dict:
    return {"objective": oid, "event": "start"}


def group(when: dict, enemy_type: str, pos: list[float], count: int, spread: float = 1.4, tag: str | None = None) -> dict:
    e: dict = {"type": enemy_type, "pos": pos, "count": count, "spread": spread}
    if tag:
        e["tag"] = tag
    return {"when": when, "enemies": [e]}


def world_missions(prefix: str, chapter: str, title: str, lvl: str, a: dict, boss: str, boss_title: str, foe: str,
                   requires: dict, flag: str, lines: dict, hard: str) -> list[dict]:
    ms: list[dict] = []
    s = a["S"]
    spread = 1.4 if s >= 20 else 1.2
    objectives = [
        reach("wp1", "Follow the main path to the first marker", a["wp1"]),
        defeat("camp1", f"Clear the first camp ({4} enemies)", 4),
        reach("wp2", "Press on to the second marker", a["wp2"]),
        defeat("camp2", "Clear the second camp", 6),
        reach("wp3", "Head for the third marker", a["wp3"]),
        reach("gate", f"Reach the gate of the {boss_title.split(',')[0]}'s lair", a["gate"], 4),
        {"id": "boss", "text": f"Defeat {boss_title}", "kind": "boss", "tag": "boss"},
    ]
    spawns = [
        group(begin("camp1"), foe, a["camp1"], 4, spread),
        group(begin("camp2"), foe, a["camp2"], 4, spread),
        group(begin("camp2"), hard, at(a["camp2"], 0, 0), 2, spread + 0.4),
        group(done("gate"), boss, a["boss"], 1, 1.0, tag="boss"),
    ]
    dialogue = [
        say({"start": True}, "Dot", lines["intro"]),
        say(done("wp1"), "Dot", lines["camp"]),
        say(begin("boss"), "Dot", lines["boss"]),
        say({"complete": True}, "Dot", lines["outro"]),
    ]
    ms.append(mission(f"mission.{prefix}.main", title, chapter, "story", lvl, lines["summary"], objectives, requires=requires,
                      spawns=spawns, dialogue=dialogue, reward={"scrap": 120, "xp": 250, "flags": [flag]}))

    base_req = {"missions": ["mission.vastor"]}
    spots = a["spots"]
    ms.append(mission(f"mission.{prefix}.sweep", f"{title}: Sweep", chapter, "challenge", lvl, "Clear a pack before the clock runs out.",
                      [defeat("sweep", "Defeat 8 enemies", 8)], requires=base_req, timeLimit=70,
                      spawns=[group({"start": True}, foe, spots[0], 8, spread)], reward={"scrap": 40, "xp": 60}))
    ms.append(mission(f"mission.{prefix}.dash", f"{title}: Dash", chapter, "challenge", lvl, "Touch three markers fast.",
                      [reach("d1", "Marker 1", spots[1]), reach("d2", "Marker 2", spots[2]), reach("d3", "Marker 3", spots[3])],
                      requires=base_req, timeLimit=60, reward={"scrap": 35, "xp": 55}))
    ms.append(mission(f"mission.{prefix}.heavies", f"{title}: Heavies", chapter, "challenge", lvl, "Take down the big ones.",
                      [defeat("heavies", "Defeat 2 brutes", 2, "enemy.brute")], requires=base_req, timeLimit=90,
                      spawns=[group({"start": True}, "enemy.brute", spots[2], 2, 3.0)], reward={"scrap": 50, "xp": 80}))
    ms.append(mission(f"mission.{prefix}.untouchable", f"{title}: Untouchable", chapter, "challenge", lvl, "Stay alive for 30 seconds without being hit.",
                      [{"id": "hold", "text": "Survive 30 seconds without a scratch", "kind": "survive", "seconds": 30}],
                      requires=base_req, noDamage=True,
                      spawns=[group({"start": True}, foe, at(spots[3], 0, 8), 3, spread)], reward={"scrap": 45, "xp": 70}))
    return ms


def build_missions(a: dict[str, dict]) -> list[dict]:
    ms: list[dict] = []
    city = "chapter.city"
    t = a["tutorial"]
    ms.append(mission(
        "mission.tutorial", "Training Day", city, "story", "tutorial",
        "Learn to move, strike and use your special. Then show the thugs who's boss.",
        [
            {"id": "move", "text": "Run around (WASD)", "kind": "do", "action": "move", "amount": 12},
            {"id": "jump", "text": "Jump twice (Space)", "kind": "do", "action": "jump", "amount": 2},
            {"id": "strike", "text": "Strike 4 times (J or click)", "kind": "do", "action": "strike", "amount": 4},
            {"id": "special", "text": "Use your special ability twice (see the controls)", "kind": "do", "action": "special", "amount": 2},
            defeat("fight", "Defeat 3 thugs", 3, "enemy.thug"),
            reach("exit", "Head to the glowing marker", t["exit"], 4),
        ],
        spawns=[group(begin("fight"), "enemy.thug", t["fight"], 3, 2.0)],
        dialogue=[
            say({"start": True}, "Dot", "Welcome to Brightport! I'm Dot, your dispatcher. Let's check the suit. Try running around."),
            say(done("move"), "Dot", "Smooth! Now hop. The city has lots of puddles."),
            say(done("jump"), "Dot", "Great. Give the air a few good punches."),
            say(done("strike"), "Dot", "Nice combo. Your hero has a special move too: check the controls and try it out!"),
            say(begin("fight"), "Dot", "Uh-oh, three thugs just wandered in. They look grumpy. Handle it!"),
            say({"complete": True}, "Dot", "Training complete! Out in the city there are challenges for scrap and XP. Spend scrap at the upgrade bay."),
        ],
        reward={"scrap": 30, "xp": 60, "flags": ["tutorialDone"]}))

    # ---- free roam challenges in the city hub (the arena) ----
    hub_req = {"missions": ["mission.tutorial"]}
    ms.append(mission("mission.challenge.thug_rush", "Thug Rush", city, "challenge", "arena", "Six thugs, fifty seconds.",
                      [defeat("rush", "Defeat 6 thugs", 6, "enemy.thug")], requires=hub_req, timeLimit=50,
                      spawns=[group({"start": True}, "enemy.thug", [0, 0.01, 14], 6, 2.0)], reward={"scrap": 25, "xp": 50}))
    ms.append(mission("mission.challenge.rooftop_run", "Rooftop Run", city, "challenge", "arena", "Touch three markers around the block, fast.",
                      [reach("r1", "Marker 1", [20, 0.01, 20]), reach("r2", "Marker 2", [-20, 0.01, 20]), reach("r3", "Marker 3", [-20, 0.01, -20])],
                      requires=hub_req, timeLimit=40, reward={"scrap": 25, "xp": 50}))
    ms.append(mission("mission.challenge.untouchable", "Untouchable", city, "challenge", "arena", "Survive 30 seconds without taking a hit.",
                      [{"id": "hold", "text": "Survive 30 seconds without a scratch", "kind": "survive", "seconds": 30}], requires=hub_req, noDamage=True,
                      spawns=[group({"start": True}, "enemy.thug", [0, 0.01, 20], 4, 2.0)], reward={"scrap": 30, "xp": 60}))

    # ---- VASTOR (the costly fight) ----
    v = a["vastor_arena"]
    ms.append(mission(
        "mission.vastor", "The Worldbreaker", city, "story", "vastor_arena",
        "A shadow falls over Brightport. VASTOR has arrived. He is very tall, very armored, and very rude.",
        [defeat("shards", "Clear the shard swarm (6)", 6, "enemy.shard"),
         {"id": "boss", "text": "Fight VASTOR", "kind": "boss", "tag": "vastor", "escapeAt": 0.3}],
        requires={"missions": ["mission.tutorial"], "level": 3},
        spawns=[group({"start": True}, "enemy.shard", at(v["ring"], 0, 10), 6, 2.0),
                group(done("shards"), "boss.vastor", v["boss"], 1, 1.0, tag="vastor")],
        dialogue=[
            say({"start": True}, "Dot", "Big readings downtown! Something is crushing buildings. I don't like it. Get there!"),
            say({"start": True}, "VASTOR", "Hm. A city. How charming. How BREAKABLE."),
            say(begin("boss"), "VASTOR", "You tiny sparks! I am VASTOR, the Worldbreaker! Try to dent me!"),
            say(done("boss"), "VASTOR", "Impressive. You hurt me! ...I'll be back, with all of the worlds behind me!"),
            say({"complete": True}, "Dot", "He got away, and half the skyline came with him. He's heading for the Sugarworks. Upgrade, then follow!"),
        ],
        reward={"scrap": 100, "xp": 200, "flags": ["vastorEscaped"]}))

    # ---- the three worlds ----
    ms += world_missions(
        "w1", "chapter.world1", "Sugarworks", "sugarworks", a["sugarworks"], "boss.big_batch", "Big Batch, the Runaway Mixer", "enemy.thug",
        {"missions": ["mission.vastor"]}, "world1Done", {
            "summary": "A candy factory has gone wild. Sticky floors, grumpy mixers, and a boss that won't stop stirring.",
            "intro": "The Sugarworks smells amazing and is extremely dangerous. VASTOR's shards got into the machines. Follow the markers!",
            "camp": "Thugs on the sugar line. Try not to get stuck to anything.",
            "boss": "That's Big Batch, the mixer VASTOR woke up. It's huge, it's armored and it is VERY mixed up.",
            "outro": "Big Batch is out of batter! Something new for your suit is in the bay. Next stop: Cloudspire!",
        }, "enemy.shard")
    ms += world_missions(
        "w2", "chapter.world2", "Cloudspire", "cloudspire", a["cloudspire"], "boss.gale_warden", "Gale Warden, Keeper of the Spire", "enemy.shard",
        {"missions": ["mission.w1.main"]}, "world2Done", {
            "summary": "Islands in the sky, linked by thin bridges. Mind the gaps (or fly over them).",
            "intro": "Cloudspire! Floating islands, a lot of wind, and not a lot of floor. Stick to the bridges, or take the high road.",
            "camp": "Shards ahead. They're fast, so keep moving.",
            "boss": "The Gale Warden guards the spire. It charges, so dodge sideways!",
            "outro": "The Warden has calmed down. The wind feels nicer already. Down below, a clockwork city is ticking...",
        }, "enemy.brute")
    ms += world_missions(
        "w3", "chapter.world3", "Gearhollow", "gearhollow", a["gearhollow"], "boss.clockwork_duchess", "The Clockwork Duchess", "enemy.brute",
        {"missions": ["mission.w2.main"]}, "world3Done", {
            "summary": "A maze of tunnels and gears. Some walls look weak. A certain strong hero could do something about that.",
            "intro": "Gearhollow is all tunnels and ticking. Some of the walls look wobbly, so strong heroes can make shortcuts!",
            "camp": "Brutes! They hit hard but they're slow. Use the corners.",
            "boss": "The Clockwork Duchess runs this place like clockwork. Her slams are big and she calls for help.",
            "outro": "The Duchess has stopped ticking! VASTOR's engine is the only thing left. He's waiting for you.",
        }, "enemy.thug")

    # ---- finale ----
    f = a["finale"]
    ms.append(mission(
        "mission.finale", "The Shard Engine", "chapter.finale", "story", "finale",
        "VASTOR's engine hums at the heart of it all. This time he has nowhere to run.",
        [defeat("guards", "Clear the engine's guards (8)", 8),
         {"id": "boss", "text": "Defeat VASTOR for good", "kind": "boss", "tag": "vastor"}],
        requires={"missions": ["mission.w3.main"], "flags": ["world3Done"]},
        spawns=[group({"start": True}, "enemy.shard", at(f["ring"], 0, 10), 5, 2.0), group({"start": True}, "enemy.brute", at(f["ring"], 0, 20), 3, 2.5),
                group(done("guards"), "boss.vastor", f["boss"], 1, 1.0, tag="vastor")],
        dialogue=[
            say({"start": True}, "Dot", "This is it. All four of you, one Worldbreaker. You've got upgrades, a plan, and snacks. Go!"),
            say(begin("boss"), "VASTOR", "You again! Fine. Let me show you what a REAL world breaking looks like!"),
            say({"complete": True}, "VASTOR", "...Okay. Okay! You win. The worlds are yours. Please stop hitting me."),
            say({"complete": True}, "Dot", "You did it! Brightport, Sugarworks, Cloudspire, Gearhollow: all safe. Take a bow, heroes."),
        ],
        reward={"scrap": 300, "xp": 500, "flags": ["gameComplete"]}))
    return ms


def main() -> None:
    anchors: dict[str, dict] = {}
    levels: list[dict] = []

    lv, anchors["tutorial"] = tutorial()
    levels.append(lv)
    lv, anchors["vastor_arena"] = boss_arena("vastor_arena", "Brightport Plaza", THEMES["arena"], 48, 8, 4)
    levels.append(lv)
    lv, anchors["sugarworks"] = grid_city("sugarworks", "Sugarworks", THEMES["sugar"], 22, 14, 5, 12, 11, False, {(2, 2), (3, 2), (2, 3), (3, 3)})
    levels.append(lv)
    lv, anchors["cloudspire"] = cloudspire()
    levels.append(lv)
    lv, anchors["gearhollow"] = grid_city("gearhollow", "Gearhollow", THEMES["gear"], 18, 12, 6, 9, 23, True, {(2, 2), (3, 2), (2, 3), (3, 3)})
    levels.append(lv)
    lv, anchors["finale"] = finale_level()
    levels.append(lv)
    levels.append(damaged_hub())

    for lv in levels:
        write(LEVELS / f"{lv['id']}.json", lv)
    for m in build_missions(anchors):
        write(MISSIONS / f"{m['id'].split('.', 1)[1].replace('.', '_')}.json", m)
    print(f"wrote {len(levels)} levels and {len(list(MISSIONS.glob('*.json')))} missions")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
