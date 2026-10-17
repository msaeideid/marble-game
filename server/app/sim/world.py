from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .vec import Vec3

AXES = ("x", "y", "z")


@dataclass(slots=True)
class Collider:
    kind: str
    min: Vec3
    max: Vec3


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
    """Static collision world of axis-aligned boxes (mirrors client/src/sim/world.ts)."""

    def __init__(self, level: dict[str, Any]) -> None:
        self.colliders = [
            Collider(c["kind"], Vec3.from_list(c["min"]), Vec3.from_list(c["max"])) for c in level["colliders"]
        ]
        self.spawn = Vec3.from_list(level["spawn"])
        self.kill_y: float = float(level["killY"])
        b = level.get("base")
        self.base = Base(Vec3.from_list(b["pos"]), float(b["radius"]), float(b["regenPerSecond"])) if b else None

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
        for c in self.colliders:
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
