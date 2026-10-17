import type { Collider, Vec3 } from './types';

export interface LevelData {
  id: string;
  spawn: number[];
  killY: number;
  waveDelay?: number;
  base?: { pos: number[]; radius: number; regenPerSecond: number };
  enemySpawns?: { type: string; pos: number[] }[];
  props?: { type: string; pos: number[] }[];
  colliders: { kind: string; min: number[]; max: number[]; breakable?: number }[];
}

export interface RayHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
  collider: Collider;
}

type BoxHit = Omit<RayHit, 'collider'>;

/** Static collision world made of axis-aligned boxes. Same shape the (future) Python server loads. */
export class World {
  /** Every collider in the level, indexed by `id` (broken ones included). */
  readonly colliders: Collider[];
  /** Ids of breakable colliders that have been smashed. Only changes through the methods below. */
  readonly broken = new Set<number>();
  /** Bumped whenever `broken` changes, so views know when to refresh. */
  brokenVersion = 0;
  private activeList: Collider[];
  readonly spawn: Vec3;
  readonly killY: number;
  readonly waveDelay: number;
  /** Safe pad where players recover: shield and energy refill quickly, core health slowly. */
  readonly base: { pos: Vec3; radius: number; regenPerSecond: number } | null;
  readonly enemySpawns: { type: string; pos: Vec3 }[];
  /** Where liftable props start (and respawn). */
  readonly propSpawns: { type: string; pos: Vec3 }[];

  constructor(level: LevelData) {
    this.colliders = level.colliders.map((c, id) => ({
      id,
      kind: c.kind as Collider['kind'],
      ...(c.breakable !== undefined ? { breakable: c.breakable } : {}),
      min: { x: c.min[0]!, y: c.min[1]!, z: c.min[2]! },
      max: { x: c.max[0]!, y: c.max[1]!, z: c.max[2]! },
    }));
    this.activeList = [...this.colliders];
    this.spawn = { x: level.spawn[0]!, y: level.spawn[1]!, z: level.spawn[2]! };
    this.killY = level.killY;
    this.waveDelay = level.waveDelay ?? 5;
    this.base = level.base
      ? {
          pos: { x: level.base.pos[0]!, y: level.base.pos[1]!, z: level.base.pos[2]! },
          radius: level.base.radius,
          regenPerSecond: level.base.regenPerSecond,
        }
      : null;
    this.propSpawns = (level.props ?? []).map((e) => ({
      type: e.type,
      pos: { x: e.pos[0]!, y: e.pos[1]!, z: e.pos[2]! },
    }));
    this.enemySpawns = (level.enemySpawns ?? []).map((e) => ({
      type: e.type,
      pos: { x: e.pos[0]!, y: e.pos[1]!, z: e.pos[2]! },
    }));
  }

  /** The colliders that currently block movement and rays (everything not yet broken). */
  get active(): readonly Collider[] {
    return this.activeList;
  }

  /** Smash a breakable collider. Returns true if it was newly broken. */
  breakCollider(id: number): boolean {
    const c = this.colliders[id];
    if (!c || c.breakable === undefined || this.broken.has(id)) return false;
    this.broken.add(id);
    this.refreshActive();
    return true;
  }

  /** Make the set of broken colliders exactly `ids` (used when the server's world state is authoritative). */
  setBroken(ids: Iterable<number>): void {
    const next = new Set<number>();
    for (const id of ids) if (this.colliders[id]?.breakable !== undefined) next.add(id);
    if (next.size === this.broken.size && [...next].every((id) => this.broken.has(id))) return;
    this.broken.clear();
    for (const id of next) this.broken.add(id);
    this.refreshActive();
  }

  /** Add to the broken set without ever un-breaking anything (other players' breaks arriving in snapshots). */
  unionBroken(ids: Iterable<number>): void {
    let changed = false;
    for (const id of ids) {
      if (this.colliders[id]?.breakable !== undefined && !this.broken.has(id)) {
        this.broken.add(id);
        changed = true;
      }
    }
    if (changed) this.refreshActive();
  }

  private refreshActive(): void {
    this.activeList = this.colliders.filter((c) => !this.broken.has(c.id));
    this.brokenVersion++;
  }

  isOnBase(pos: Vec3): boolean {
    const b = this.base;
    return !!b && Math.hypot(pos.x - b.pos.x, pos.z - b.pos.z) <= b.radius && Math.abs(pos.y - b.pos.y) < 3;
  }

  /** Nearest hit of a ray (dir need not be normalised) within `maxDistance`, or null. */
  raycast(origin: Vec3, dir: Vec3, maxDistance: number): RayHit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len === 0) return null;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    let best: RayHit | null = null;
    for (const c of this.activeList) {
      const hit = rayVsBox(origin, d, c.min, c.max, maxDistance);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, collider: c };
    }
    return best;
  }
}

const AXES = ['x', 'y', 'z'] as const;

/** Slab test. Rays starting inside a box report no hit, which suits camera and anchor queries. */
export function rayVsBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxDistance: number): BoxHit | null {
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
