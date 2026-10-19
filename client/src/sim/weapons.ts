import type { ChainParams, LaserParams, RocketParams, TempestParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

/** Anything a ranged weapon can hit: an upright box centred on its feet (enemies today). */
export interface Target {
  id: string;
  pos: Vec3;
  halfWidth: number;
  height: number;
}

export interface LaserShot {
  /** Where the bolt ends: the enemy it hit, the wall it stopped at, or the end of its range. */
  end: Vec3;
  hit: Target | null;
}

const centre = (t: Target): Vec3 => ({ x: t.pos.x, y: t.pos.y + t.height / 2, z: t.pos.z });

/**
 * A hitscan bolt along the unit vector `dir`. It stops at the first wall; the nearest enemy whose body is within
 * `aimAssist` of the line before that is hit, so the crosshair does not need to be pixel-perfect.
 */
export function traceLaser(
  world: World,
  origin: Vec3,
  dir: Vec3,
  p: LaserParams,
  targets: Iterable<Target>,
): LaserShot {
  const wall = world.raycast(origin, dir, p.range);
  let reach = wall ? wall.distance : p.range;
  let hit: Target | null = null;
  for (const c of targets) {
    const m = centre(c);
    const cx = m.x - origin.x;
    const cy = m.y - origin.y;
    const cz = m.z - origin.z;
    const t = cx * dir.x + cy * dir.y + cz * dir.z;
    if (t < 0 || t > reach) continue;
    const off2 = cx * cx + cy * cy + cz * cz - t * t;
    const r = c.halfWidth + p.aimAssist;
    if (off2 > r * r) continue;
    hit = c;
    reach = t;
  }
  return { end: { x: origin.x + dir.x * reach, y: origin.y + dir.y * reach, z: origin.z + dir.z * reach }, hit };
}

/**
 * The enemy a lock-on weapon (rockets, chain lightning) fired now would pick: the one closest to the crosshair direction, within the lock angle and
 * range, with a clear line of sight. `dir` must be a unit vector.
 */
export function pickLockTarget<T extends Target>(
  world: World,
  origin: Vec3,
  dir: Vec3,
  p: { lockRange: number; lockAngleDegrees: number },
  targets: Iterable<T>,
): T | null {
  const minCos = Math.cos((p.lockAngleDegrees * Math.PI) / 180);
  let best: T | null = null;
  let bestCos = minCos;
  for (const c of targets) {
    const m = centre(c);
    const vx = m.x - origin.x;
    const vy = m.y - origin.y;
    const vz = m.z - origin.z;
    const dist = Math.hypot(vx, vy, vz);
    if (dist < 0.5 || dist > p.lockRange) continue;
    const cos = (vx * dir.x + vy * dir.y + vz * dir.z) / dist;
    if (cos < bestCos) continue;
    const wall = world.raycast(origin, { x: vx / dist, y: vy / dist, z: vz / dist }, dist);
    if (wall && wall.distance < dist - 0.5) continue;
    best = c;
    bestCos = cos;
  }
  return best;
}

export interface RocketState {
  id: number;
  owner: string;
  pos: Vec3;
  /** Position at the start of the last tick (for render interpolation). */
  prevPos: Vec3;
  /** Unit heading. */
  dir: Vec3;
  age: number;
  /** The enemy it is chasing, or null for a dumb-fire rocket. */
  targetId: string | null;
}

/** A rocket in flight as the server describes it to clients. */
export interface RocketWire {
  id: number;
  owner: string;
  pos: [number, number, number];
  dir: [number, number, number];
  target: string | null;
}

export interface StrikeWire {
  id: number;
  owner: string;
  pos: [number, number, number];
  timer: number;
}

export type RocketEvent =
  | { type: 'rocketLaunch'; id: number; owner: string; locked: string | null }
  | { type: 'explosion'; pos: Vec3; radius: number; owner: string; hits: string[] };

export interface RocketHooks {
  /** Enemies that are alive right now. */
  targets(): Iterable<Target>;
  /** Thrown volatile props: a rocket stops against them and its burst detonates the ones it catches. */
  props?(): Iterable<Target>;
  /** Detonate a thrown volatile prop (id `prop:<n>`) on behalf of a rocket's owner. */
  detonate?(propId: string, owner: string): void;
  /** Apply blast damage and a shove (horizontal direction and strength) to one enemy. */
  blast(id: string, amount: number, dirX: number, dirZ: number, knockback: number): void;
}

/** How far a rocket travels between hit tests against enemies (smaller than any enemy's width). */
const HIT_STEP = 0.3;

/** Homing rockets in flight: steering, flying, hitting, bursting. */
export class RocketSystem {
  readonly rockets: RocketState[] = [];
  private nextId = 1;

  constructor(
    private readonly world: World,
    readonly params: RocketParams,
  ) {}

  launch(owner: string, origin: Vec3, dir: Vec3, targetId: string | null): RocketEvent {
    const r: RocketState = {
      id: this.nextId++,
      owner,
      pos: { ...origin },
      prevPos: { ...origin },
      dir: { ...dir },
      age: 0,
      targetId,
    };
    this.rockets.push(r);
    return { type: 'rocketLaunch', id: r.id, owner, locked: targetId };
  }

  toWire(): RocketWire[] {
    return this.rockets.map((r) => ({
      id: r.id,
      owner: r.owner,
      pos: [r.pos.x, r.pos.y, r.pos.z],
      dir: [r.dir.x, r.dir.y, r.dir.z],
      target: r.targetId,
    }));
  }

  step(dt: number, hooks: RocketHooks): RocketEvent[] {
    const events: RocketEvent[] = [];
    const p = this.params;
    const targets = [...hooks.targets()];
    const props = [...(hooks.props?.() ?? [])];
    const alive: RocketState[] = [];
    for (const r of this.rockets) {
      r.age += dt;
      r.prevPos = { ...r.pos };
      const target = r.targetId ? targets.find((t) => t.id === r.targetId) : undefined;
      if (target) steer(r.dir, r.pos, centre(target), p.turnRate * dt);

      const dist = p.speed * dt;
      // The nearest thing in the way: a wall along the segment, or an enemy at one of the sample points.
      const wall = this.world.raycast(r.pos, r.dir, dist + p.radius);
      let stop = wall ? Math.max(0, wall.distance - p.radius) : Infinity;
      const limit = Math.min(stop, dist);
      for (let at = Math.min(HIT_STEP, limit); ; at = Math.min(at + HIT_STEP, limit)) {
        const x = r.pos.x + r.dir.x * at;
        const y = r.pos.y + r.dir.y * at;
        const z = r.pos.z + r.dir.z * at;
        if (targets.some((t) => touches(t, x, y, z, p.radius)) || props.some((t) => touches(t, x, y, z, p.radius))) {
          stop = at;
          break;
        }
        if (at >= limit) break;
      }
      const travelled = Math.min(stop, dist);
      r.pos = { x: r.pos.x + r.dir.x * travelled, y: r.pos.y + r.dir.y * travelled, z: r.pos.z + r.dir.z * travelled };

      if (stop <= dist || r.age >= p.lifetime) {
        events.push(this.explode(r, targets, props, hooks));
      } else {
        alive.push(r);
      }
    }
    this.rockets.length = 0;
    this.rockets.push(...alive);
    return events;
  }

  private explode(r: RocketState, targets: readonly Target[], props: readonly Target[], hooks: RocketHooks): RocketEvent {
    const p = this.params;
    const hits: string[] = [];
    for (const t of props) {
      const m = centre(t);
      const d = Math.hypot(m.x - r.pos.x, m.y - r.pos.y, m.z - r.pos.z) - t.halfWidth;
      if (d <= p.splashRadius) hooks.detonate?.(t.id, r.owner);
    }
    for (const t of targets) {
      const m = centre(t);
      const dx = m.x - r.pos.x;
      const dy = m.y - r.pos.y;
      const dz = m.z - r.pos.z;
      const d = Math.max(0, Math.hypot(dx, dy, dz) - t.halfWidth);
      if (d > p.splashRadius) continue;
      const frac = d / p.splashRadius;
      const flat = Math.hypot(dx, dz);
      hits.push(t.id);
      hooks.blast(
        t.id,
        p.damage * (1 - (1 - p.edgeFalloff) * frac),
        flat > 1e-6 ? dx / flat : Math.sin(r.age),
        flat > 1e-6 ? dz / flat : Math.cos(r.age),
        p.knockback * (1 - 0.5 * frac),
      );
    }
    return { type: 'explosion', pos: { ...r.pos }, radius: p.splashRadius, owner: r.owner, hits };
  }
}

/** Turn the unit vector `dir` toward the point `to` by at most `maxAngle` radians. */
function steer(dir: Vec3, from: Vec3, to: Vec3, maxAngle: number): void {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  let dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  dx /= len;
  dy /= len;
  dz /= len;
  const dot = Math.max(-1, Math.min(1, dir.x * dx + dir.y * dy + dir.z * dz));
  const angle = Math.acos(dot);
  if (angle <= maxAngle) {
    dir.x = dx;
    dir.y = dy;
    dir.z = dz;
    return;
  }
  if (angle > Math.PI - 1e-4) return; // exactly backwards: no unique turn, keep going
  const a = Math.sin(angle - maxAngle) / Math.sin(angle);
  const b = Math.sin(maxAngle) / Math.sin(angle);
  const nx = dir.x * a + dx * b;
  const ny = dir.y * a + dy * b;
  const nz = dir.z * a + dz * b;
  const n = Math.hypot(nx, ny, nz) || 1;
  dir.x = nx / n;
  dir.y = ny / n;
  dir.z = nz / n;
}

function touches(t: Target, x: number, y: number, z: number, radius: number): boolean {
  return (
    Math.abs(x - t.pos.x) <= t.halfWidth + radius &&
    Math.abs(z - t.pos.z) <= t.halfWidth + radius &&
    y >= t.pos.y - radius &&
    y <= t.pos.y + t.height + radius
  );
}

export interface ChainResult {
  /** Enemies struck, in order: the locked one first, then each jump. */
  hits: Target[];
}

/**
 * Chain lightning: the enemy nearest the crosshair (see `pickLockTarget`), then up to `maxTargets - 1` jumps, each to
 * the nearest not-yet-hit enemy within `jumpRadius` of the last one that is not behind a wall.
 */
export function traceChain(
  world: World,
  origin: Vec3,
  dir: Vec3,
  p: ChainParams,
  targets: readonly Target[],
): ChainResult {
  const first = pickLockTarget(world, origin, dir, { lockRange: p.range, lockAngleDegrees: p.lockAngleDegrees }, targets);
  if (!first) return { hits: [] };
  const hits: Target[] = [first];
  while (hits.length < p.maxTargets) {
    const from = centre(hits[hits.length - 1]!);
    let best: Target | null = null;
    let bestD = p.jumpRadius;
    for (const t of targets) {
      if (hits.includes(t)) continue;
      const m = centre(t);
      const d = Math.hypot(m.x - from.x, m.y - from.y, m.z - from.z);
      if (d >= bestD) continue;
      const wall = world.raycast(from, { x: (m.x - from.x) / d, y: (m.y - from.y) / d, z: (m.z - from.z) / d }, d);
      if (wall && wall.distance < d - 0.3) continue;
      best = t;
      bestD = d;
    }
    if (!best) break;
    hits.push(best);
  }
  return { hits };
}

export interface StrikeState {
  id: number;
  owner: string;
  pos: Vec3;
  /** Seconds until it lands. */
  timer: number;
}

export type StrikeEvent =
  | { type: 'strikeStart'; id: number; owner: string; pos: Vec3; radius: number; delay: number }
  | { type: 'strikeHit'; id: number; owner: string; pos: Vec3; radius: number; hits: string[] };

export interface StrikeHooks {
  targets(): Iterable<Target>;
  /** Apply damage, a stun and a shove (horizontal direction and strength) to one enemy. */
  shock(id: string, damage: number, stunTime: number, dirX: number, dirZ: number, knockback: number): void;
}

/** Where a storm strike aimed along `dir` from `origin` would land: the first surface hit within range, or null (sky). */
export function strikePoint(world: World, origin: Vec3, dir: Vec3, p: TempestParams): Vec3 | null {
  const hit = world.raycast(origin, dir, p.range);
  return hit ? { ...hit.point } : null;
}

/** Storm strikes that have been called and are waiting to land. */
export class StrikeSystem {
  readonly strikes: StrikeState[] = [];
  private nextId = 1;

  constructor(readonly params: TempestParams) {}

  toWire(): StrikeWire[] {
    return this.strikes.map((s) => ({ id: s.id, owner: s.owner, pos: [s.pos.x, s.pos.y, s.pos.z], timer: s.timer }));
  }

  call(owner: string, pos: Vec3): StrikeEvent {
    const s: StrikeState = { id: this.nextId++, owner, pos: { ...pos }, timer: this.params.delay };
    this.strikes.push(s);
    return { type: 'strikeStart', id: s.id, owner, pos: { ...pos }, radius: this.params.radius, delay: this.params.delay };
  }

  step(dt: number, hooks: StrikeHooks): StrikeEvent[] {
    const events: StrikeEvent[] = [];
    const p = this.params;
    const targets = [...hooks.targets()];
    const waiting: StrikeState[] = [];
    for (const s of this.strikes) {
      s.timer -= dt;
      if (s.timer > 0) {
        waiting.push(s);
        continue;
      }
      const hits: string[] = [];
      for (const t of targets) {
        const dx = t.pos.x - s.pos.x;
        const dz = t.pos.z - s.pos.z;
        const flat = Math.hypot(dx, dz);
        if (flat > p.radius + t.halfWidth || t.pos.y < s.pos.y - 1.2 || t.pos.y > s.pos.y + 3) continue;
        hits.push(t.id);
        hooks.shock(t.id, p.damage, p.stunTime, flat > 1e-6 ? dx / flat : 0, flat > 1e-6 ? dz / flat : 1, p.knockback);
      }
      events.push({ type: 'strikeHit', id: s.id, owner: s.owner, pos: s.pos, radius: p.radius, hits });
    }
    this.strikes.length = 0;
    this.strikes.push(...waiting);
    return events;
  }
}
