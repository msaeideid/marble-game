from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .vec import Vec3

AXES = ("x", "y", "z")


@dataclass(slots=True)
class Collider:
    id: int
    kind: str
    min: Vec3
    max: Vec3
    breakable: int | None = None  # tier; a charge with at least this break power smashes it


@dataclass(slots=True)
class RayHit:
    distance: float
    point: Vec3
    normal: Vec3
    collider: Collider


@dataclass(slots=True)
class Base:
    pos: Vec3
    radius: float
    regenPerSecond: float


class World:
    """Collision world of axis-aligned boxes (mirrors client/src/sim/world.ts), including breakable walls."""

    def __init__(self, level: dict[str, Any]) -> None:
        self.colliders = [
            Collider(
                i,
                c["kind"],
                Vec3.from_list(c["min"]),
                Vec3.from_list(c["max"]),
                c.get("breakable"),
            )
            for i, c in enumerate(level["colliders"])
        ]
        self.broken: set[int] = set()
        self.broken_version = 0
        self.active: list[Collider] = list(self.colliders)
        self.prop_spawns: list[dict[str, Any]] = list(level.get("props", []))
        self.enemy_spawns: list[tuple[str, Vec3]] = [(e["type"], Vec3.from_list(e["pos"])) for e in level.get("enemySpawns", [])]
        self.wave_delay: float = float(level.get("waveDelay", 5))
        self.spawn = Vec3.from_list(level["spawn"])
        self.kill_y: float = float(level["killY"])
        b = level.get("base")
        self.base = Base(Vec3.from_list(b["pos"]), float(b["radius"]), float(b["regenPerSecond"])) if b else None

    # ---- breakable walls ----
    def break_collider(self, cid: int) -> bool:
        """Smash a breakable collider. Returns True if it was newly broken."""
        if not 0 <= cid < len(self.colliders):
            return False
        c = self.colliders[cid]
        if c.breakable is None or cid in self.broken:
            return False
        self.broken.add(cid)
        self._refresh_active()
        return True

    def set_broken(self, ids: Iterable[int]) -> None:
        nxt = {i for i in ids if 0 <= i < len(self.colliders) and self.colliders[i].breakable is not None}
        if nxt != self.broken:
            self.broken = nxt
            self._refresh_active()

    def _refresh_active(self) -> None:
        self.active = [c for c in self.colliders if c.id not in self.broken]
        self.broken_version += 1

    def broken_list(self) -> list[int]:
        return sorted(self.broken)

    def is_on_base(self, pos: Vec3) -> bool:
        b = self.base
        return (
            b is not None
            and math.hypot(pos.x - b.pos.x, pos.z - b.pos.z) <= b.radius
            and abs(pos.y - b.pos.y) < 3
        )

    def raycast(self, origin: Vec3, direction: Vec3, max_distance: float) -> RayHit | None:
        length = math.hypot(direction.x, direction.y, direction.z)
        if length == 0:
            return None
        d = Vec3(direction.x / length, direction.y / length, direction.z / length)
        best: RayHit | None = None
        for c in self.active:
            hit = ray_vs_box(origin, d, c.min, c.max, max_distance)
            if hit is not None and (best is None or hit[0] < best.distance):
                best = RayHit(hit[0], hit[1], hit[2], c)
        return best


def ray_vs_box(
    o: Vec3, d: Vec3, mn: Vec3, mx: Vec3, max_distance: float
) -> tuple[float, Vec3, Vec3] | None:
    """Slab test. Rays that start inside a box report no hit."""
    t_near = 0.0
    t_far = max_distance
    n_axis = "x"
    n_sign = 0
    for a in AXES:
        da = getattr(d, a)
        oa = getattr(o, a)
        lo = getattr(mn, a)
        hi = getattr(mx, a)
        if abs(da) < 1e-12:
            if oa < lo or oa > hi:
                return None
            continue
        t1 = (lo - oa) / da
        t2 = (hi - oa) / da
        sign = -1 if da > 0 else 1
        if t1 > t2:
            t1, t2 = t2, t1
        if t1 > t_near:
            t_near = t1
            n_axis = a
            n_sign = sign
        t_far = min(t_far, t2)
        if t_near > t_far:
            return None
    if n_sign == 0:
        return None
    normal = Vec3()
    setattr(normal, n_axis, n_sign)
    point = Vec3(o.x + d.x * t_near, o.y + d.y * t_near, o.z + d.z * t_near)
    return t_near, point, normal
