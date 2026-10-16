import type { Collider, Vec3 } from './types';

export interface LevelData {
  id: string;
  spawn: number[];
  killY: number;
  colliders: { kind: string; min: number[]; max: number[] }[];
}

export interface RayHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
}

/** Static collision world made of axis-aligned boxes. Same shape the (future) Python server loads. */
export class World {
  readonly colliders: Collider[];
  readonly spawn: Vec3;
  readonly killY: number;

  constructor(level: LevelData) {
    this.colliders = level.colliders.map((c) => ({
      kind: c.kind as Collider['kind'],
      min: { x: c.min[0]!, y: c.min[1]!, z: c.min[2]! },
      max: { x: c.max[0]!, y: c.max[1]!, z: c.max[2]! },
    }));
    this.spawn = { x: level.spawn[0]!, y: level.spawn[1]!, z: level.spawn[2]! };
    this.killY = level.killY;
  }

  /** Nearest hit of a ray (dir need not be normalised) within `maxDistance`, or null. */
  raycast(origin: Vec3, dir: Vec3, maxDistance: number): RayHit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len === 0) return null;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    let best: RayHit | null = null;
    for (const c of this.colliders) {
      const hit = rayVsBox(origin, d, c.min, c.max, maxDistance);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }
}

const AXES = ['x', 'y', 'z'] as const;

/** Slab test. Rays starting inside a box report no hit, which suits camera and anchor queries. */
export function rayVsBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxDistance: number): RayHit | null {
  let tNear = 0;
  let tFar = maxDistance;
  let nAxis: (typeof AXES)[number] = 'x';
  let nSign = 0;
  for (const a of AXES) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < min[a] || o[a] > max[a]) return null;
      continue;
    }
    let t1 = (min[a] - o[a]) / d[a];
    let t2 = (max[a] - o[a]) / d[a];
    // Entering through the min face means the outward normal points toward -axis.
    const sign = d[a] > 0 ? -1 : 1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
    }
    if (t1 > tNear) {
      tNear = t1;
      nAxis = a;
      nSign = sign;
    }
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }
  if (nSign === 0) return null;
  const normal = { x: 0, y: 0, z: 0 };
  normal[nAxis] = nSign;
  return {
    distance: tNear,
    point: { x: o.x + d.x * tNear, y: o.y + d.y * tNear, z: o.z + d.z * tNear },
    normal,
  };
}
