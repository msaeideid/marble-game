from __future__ import annotations

import math
from types import SimpleNamespace

from .vec import Vec3
from .world import World

SURFACE_NUDGE = 0.05


def aim_dir(yaw: float, pitch: float) -> Vec3:
    """Unit view direction. Positive pitch = camera above looking down (so negative looks up)."""
    cp = math.cos(pitch)
    return Vec3(math.sin(yaw) * cp, -math.sin(pitch), math.cos(yaw) * cp)


def pick_swing_anchor(world: World, origin: Vec3, direction: Vec3, rng: float) -> Vec3 | None:
    hit = world.raycast(origin, direction, rng)
    if hit is None:
        return None
    return Vec3(
        hit.point.x + hit.normal.x * SURFACE_NUDGE,
        hit.point.y + hit.normal.y * SURFACE_NUDGE,
        hit.point.z + hit.normal.z * SURFACE_NUDGE,
    )


def pick_zip_anchor(
    world: World, origin: Vec3, direction: Vec3, hand_height: float, z: SimpleNamespace
) -> Vec3 | None:
    hit = world.raycast(origin, direction, z.range)
    if hit is None:
        return None
    top = hit.collider.max.y
    on_wall = hit.normal.y == 0
    if on_wall and top - hit.point.y <= z.ledgeSnap:
        return Vec3(
            hit.point.x - hit.normal.x * 1.0,
            top + hand_height + 0.1,
            hit.point.z - hit.normal.z * 1.0,
        )
    return Vec3(
        hit.point.x + hit.normal.x * SURFACE_NUDGE,
        hit.point.y + hit.normal.y * SURFACE_NUDGE,
        hit.point.z + hit.normal.z * SURFACE_NUDGE,
    )


def rope_limited_delta(hand: Vec3, delta: Vec3, anchor: Vec3, length: float) -> Vec3:
    rx = hand.x + delta.x - anchor.x
    ry = hand.y + delta.y - anchor.y
    rz = hand.z + delta.z - anchor.z
    d = math.hypot(rx, ry, rz)
    if d <= length:
        return delta
    k = length / d
    return Vec3(anchor.x + rx * k - hand.x, anchor.y + ry * k - hand.y, anchor.z + rz * k - hand.z)


def remove_outward_velocity(vel: Vec3, hand: Vec3, anchor: Vec3, length: float) -> None:
    rx = hand.x - anchor.x
    ry = hand.y - anchor.y
    rz = hand.z - anchor.z
    d = math.hypot(rx, ry, rz)
    if d < length - 0.02 or d == 0:
        return
    outward = (vel.x * rx + vel.y * ry + vel.z * rz) / d
    if outward <= 0:
        return
    vel.x -= (outward * rx) / d
    vel.y -= (outward * ry) / d
    vel.z -= (outward * rz) / d
