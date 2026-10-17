from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def shared_dir() -> Path:
    """Repo `shared/` folder (override with VANGUARD_SHARED, e.g. inside a container)."""
    env = os.environ.get("VANGUARD_SHARED")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[3] / "shared"


def _ns(obj: Any) -> Any:
    if isinstance(obj, dict):
        return SimpleNamespace(**{k: _ns(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [_ns(v) for v in obj]
    return obj


def load_json(rel: str) -> Any:
    return json.loads((shared_dir() / rel).read_text(encoding="utf8"))


def load_level(name: str = "arena") -> dict[str, Any]:
    return load_json(f"levels/{name}.json")


def load_hero(hero_id: str = "hero.swinger") -> SimpleNamespace:
    """Flatten a hero and its abilities into one params object (mirrors resolveHero in content.ts)."""
    abilities: dict[str, dict[str, Any]] = {}
    for f in sorted((shared_dir() / "data" / "abilities").glob("*.json")):
        a = json.loads(f.read_text(encoding="utf8"))
        abilities[a["id"]] = a
    for f in sorted((shared_dir() / "data" / "heroes").glob("*.json")):
        h = json.loads(f.read_text(encoding="utf8"))
        if h["id"] != hero_id:
            continue
        by_kind: dict[str, dict[str, Any]] = {}
        for aid in h["abilities"]:
            a = abilities[aid]
            if a["kind"] in by_kind:
                raise ValueError(f"Hero {hero_id} has two '{a['kind']}' abilities")
            by_kind[a["kind"]] = a
        return _ns(
            {
                "id": h["id"],
                "displayName": h["displayName"],
                "movement": h["movement"],
                "energy": h["energy"],
                "health": h["health"],
                "respawnDelay": h["respawnDelay"],
                "respawnInvulnerable": h["respawnInvulnerable"],
                "swing": by_kind["swing"]["swing"],
                "zip": by_kind["zip"]["zip"],
                "melee": by_kind["melee"]["melee"],
                "snare": by_kind["snare"]["snare"],
            }
        )
    raise KeyError(f"Unknown hero {hero_id}")
