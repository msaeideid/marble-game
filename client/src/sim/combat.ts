import type { MeleeParams, SnareParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

export interface MeleeState {
  phase: 'idle' | 'windup' | 'recovery';
  timer: number;
  /** Index of the combo step currently being performed (or last performed). */
  step: number;
  /** While > 0, the next attack continues the combo. */
  comboTimer: number;
  /** A press remembered for this many more seconds. */
  buffer: number;
}

export function createMelee(): MeleeState {
  return { phase: 'idle', timer: 0, step: 0, comboTimer: 0, buffer: 0 };
}

/**
 * Advance the melee state machine one tick. Returns the combo step whose hit lands this tick, or null.
 * `spend` is asked for the ability's energy cost when an attack starts; returning false cancels the start.
 */
export function stepMelee(
  m: MeleeState,
  pressed: boolean,
  p: MeleeParams,
  dt: number,
  spend: (cost: number) => boolean,
): number | null {
  m.buffer = pressed ? p.inputBuffer : Math.max(0, m.buffer - dt);
  if (m.phase !== 'windup') m.comboTimer = Math.max(0, m.comboTimer - dt);

  if (m.phase === 'idle' && m.buffer > 0) {
    m.buffer = 0;
    if (p.cost === 0 || spend(p.cost)) {
      m.step = m.comboTimer > 0 ? (m.step + 1) % p.steps.length : 0;
      m.phase = 'windup';
      m.timer = p.windup;
    }
  }

  let hit: number | null = null;
  if (m.phase === 'windup') {
    m.timer -= dt;
    if (m.timer <= 0) {
      hit = m.step;
      m.phase = 'recovery';
      m.timer = p.recovery;
      m.comboTimer = p.comboWindow + p.recovery;
    }
  } else if (m.phase === 'recovery') {
    m.timer -= dt;
    if (m.timer <= 0) m.phase = 'idle';
  }
  return hit;
}

export interface Hittable {
  pos: Vec3;
  halfWidth: number;
}

/** Targets inside the attacker's frontal arc. `yaw` is the attack heading (0 = +Z). */
export function meleeTargets<T extends Hittable>(
  attacker: Vec3,
  yaw: number,
  p: MeleeParams,
  candidates: Iterable<T>,
): T[] {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const minCos = Math.cos((p.arcDegrees * Math.PI) / 360);
  const out: T[] = [];
  for (const c of candidates) {
    const dx = c.pos.x - attacker.x;
    const dz = c.pos.z - attacker.z;
    const dist = Math.hypot(dx, dz);
    if (dist > p.range + c.halfWidth) continue;
    if (Math.abs(c.pos.y - attacker.y) > p.verticalReach) continue;
    if (dist > 0.05 && (dx * fx + dz * fz) / dist < minCos) continue;
    out.push(c);
  }
  return out;
}

export interface Snareable extends Hittable {
  height: number;
}

/**
 * The enemy a snare would catch: the nearest one within `radius` of the aim ray (up to `range`) that has a
 * clear line of sight. `dir` must be a unit vector.
 */
export function pickSnareTarget<T extends Snareable>(
  world: World,
  origin: Vec3,
  dir: Vec3,
  p: SnareParams,
  candidates: Iterable<T>,
): T | null {
  let best: T | null = null;
  let bestT = Infinity;
  for (const c of candidates) {
    const cx = c.pos.x - origin.x;
    const cy = c.pos.y + c.height / 2 - origin.y;
    const cz = c.pos.z - origin.z;
    const t = cx * dir.x + cy * dir.y + cz * dir.z;
    if (t < 0 || t > p.range || t >= bestT) continue;
    const off2 = cx * cx + cy * cy + cz * cz - t * t;
    if (off2 > p.radius * p.radius) continue;
    const wall = world.raycast(origin, dir, t);
    if (wall && wall.distance < t - 0.5) continue;
    best = c;
    bestT = t;
  }
  return best;
}
