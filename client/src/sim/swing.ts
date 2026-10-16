import type { ZipParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

const SURFACE_NUDGE = 0.05;

/** Where a swing tether would attach: the first surface hit within range, nudged off the surface. */
export function pickSwingAnchor(world: World, origin: Vec3, dir: Vec3, range: number): Vec3 | null {
  const hit = world.raycast(origin, dir, range);
  if (!hit) return null;
  return {
    x: hit.point.x + hit.normal.x * SURFACE_NUDGE,
    y: hit.point.y + hit.normal.y * SURFACE_NUDGE,
    z: hit.point.z + hit.normal.z * SURFACE_NUDGE,
  };
}

/**
 * Where a zip would pull the player. Hitting a wall just below a roof edge aims at a point above the
 * roof instead, so the zip carries the player up and over the ledge.
 */
export function pickZipAnchor(world: World, origin: Vec3, dir: Vec3, handHeight: number, z: ZipParams): Vec3 | null {
  const hit = world.raycast(origin, dir, z.range);
  if (!hit) return null;
  const top = hit.collider.max.y;
  const onWall = hit.normal.y === 0;
  if (onWall && top - hit.point.y <= z.ledgeSnap) {
    return {
      x: hit.point.x - hit.normal.x * 1.0,
      y: top + handHeight + 0.1,
      z: hit.point.z - hit.normal.z * 1.0,
    };
  }
  return {
    x: hit.point.x + hit.normal.x * SURFACE_NUDGE,
    y: hit.point.y + hit.normal.y * SURFACE_NUDGE,
    z: hit.point.z + hit.normal.z * SURFACE_NUDGE,
  };
}

/** Shortens `delta` so that `hand + delta` stays within `length` of the anchor (a rope can pull, never push). */
export function ropeLimitedDelta(hand: Vec3, delta: Vec3, anchor: Vec3, length: number): Vec3 {
  const rx = hand.x + delta.x - anchor.x;
  const ry = hand.y + delta.y - anchor.y;
  const rz = hand.z + delta.z - anchor.z;
  const d = Math.hypot(rx, ry, rz);
  if (d <= length) return delta;
  const k = length / d;
  return { x: anchor.x + rx * k - hand.x, y: anchor.y + ry * k - hand.y, z: anchor.z + rz * k - hand.z };
}

/** If the rope is taut, removes the part of `vel` that points away from the anchor. Mutates `vel`. */
export function removeOutwardVelocity(vel: Vec3, hand: Vec3, anchor: Vec3, length: number): void {
  const rx = hand.x - anchor.x;
  const ry = hand.y - anchor.y;
  const rz = hand.z - anchor.z;
  const d = Math.hypot(rx, ry, rz);
  if (d < length - 0.02 || d === 0) return;
  const outward = (vel.x * rx + vel.y * ry + vel.z * rz) / d;
  if (outward <= 0) return;
  vel.x -= (outward * rx) / d;
  vel.y -= (outward * ry) / d;
  vel.z -= (outward * rz) / d;
}
