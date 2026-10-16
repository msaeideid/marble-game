import type { EnemyState } from './enemy';
import type { EnemyParams } from './params';
import type { Vec3 } from './types';

export interface AiTarget {
  id: string;
  pos: Vec3;
}

/** How far (m) a target may drift out of range during a windup and still be hit (generous = readable). */
const HIT_LENIENCY = 0.6;
/** Largest vertical gap (m) at which a thug can start or land an attack. */
const MAX_VERTICAL_REACH = 1.6;
const SEPARATION_RADIUS = 1.3;

export interface AiHooks {
  /** The enemy's attack landed on this target. */
  attack: (targetId: string) => void;
}

/**
 * One tick of thug behaviour: idle -> chase -> windup (telegraph) -> recovery -> chase.
 * A hit sends it to `stagger` (see Sim.damageEnemy), which cancels any windup. A snare freezes it.
 * Sets horizontal velocity directly while it is in control; knockback decays through physics otherwise.
 */
export function stepEnemyAi(
  e: EnemyState,
  def: EnemyParams,
  targets: readonly AiTarget[],
  neighbours: readonly EnemyState[],
  dt: number,
  hooks: AiHooks,
): void {
  e.attackCooldown = Math.max(0, e.attackCooldown - dt);
  e.poiseTimer = Math.max(0, e.poiseTimer - dt);

  if (e.snaredTimer > 0) {
    e.snaredTimer = Math.max(0, e.snaredTimer - dt);
    e.vel.x = 0;
    e.vel.z = 0;
    return;
  }

  if (e.aiState === 'stagger') {
    e.aiTimer -= dt;
    if (e.aiTimer <= 0) {
      e.aiState = 'chase';
      e.poiseTimer = def.poiseTime;
    }
    return;
  }

  const target = nearest(e, targets, def.aggroRange);
  if (!target) {
    e.aiState = 'idle';
    return;
  }
  if (e.aiState === 'idle') e.aiState = 'chase';

  const dx = target.pos.x - e.pos.x;
  const dz = target.pos.z - e.pos.z;
  const dist = Math.hypot(dx, dz);
  const dy = Math.abs(target.pos.y - e.pos.y);
  if (dist > 0.01) e.facing = Math.atan2(dx, dz);

  switch (e.aiState) {
    case 'chase': {
      if (dist <= def.attack.range && dy <= MAX_VERTICAL_REACH && e.attackCooldown <= 0) {
        e.aiState = 'windup';
        e.aiTimer = def.attack.windup;
        e.vel.x = 0;
        e.vel.z = 0;
        break;
      }
      steer(e, def, dx, dz, dist, neighbours);
      break;
    }
    case 'windup': {
      e.vel.x = 0;
      e.vel.z = 0;
      e.aiTimer -= dt;
      if (e.aiTimer <= 0) {
        if (dist <= def.attack.range + HIT_LENIENCY && dy <= MAX_VERTICAL_REACH + 0.2) hooks.attack(target.id);
        e.aiState = 'recovery';
        e.aiTimer = def.attack.recovery;
        e.attackCooldown = def.attack.cooldown;
      }
      break;
    }
    case 'recovery': {
      e.vel.x = 0;
      e.vel.z = 0;
      e.aiTimer -= dt;
      if (e.aiTimer <= 0) e.aiState = 'chase';
      break;
    }
    default:
      break;
  }
}

function nearest(e: EnemyState, targets: readonly AiTarget[], range: number): AiTarget | null {
  let best: AiTarget | null = null;
  let bestDist = range;
  for (const t of targets) {
    const d = Math.hypot(t.pos.x - e.pos.x, t.pos.z - e.pos.z);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** Walk toward the target, stopping just inside attack range and shoving apart from crowding neighbours. */
function steer(
  e: EnemyState,
  def: EnemyParams,
  dx: number,
  dz: number,
  dist: number,
  neighbours: readonly EnemyState[],
): void {
  let vx = 0;
  let vz = 0;
  if (dist > def.attack.range * 0.85) {
    vx = (dx / dist) * def.move.speed;
    vz = (dz / dist) * def.move.speed;
  }
  for (const n of neighbours) {
    if (n === e || n.defeatedTimer !== null) continue;
    const sx = e.pos.x - n.pos.x;
    const sz = e.pos.z - n.pos.z;
    const d = Math.hypot(sx, sz);
    if (d > 0 && d < SEPARATION_RADIUS) {
      const push = ((SEPARATION_RADIUS - d) / SEPARATION_RADIUS) * def.move.speed;
      vx += (sx / d) * push;
      vz += (sz / d) * push;
    }
  }
  const speed = Math.hypot(vx, vz);
  const max = def.move.speed;
  if (speed > max) {
    vx = (vx / speed) * max;
    vz = (vz / speed) * max;
  }
  e.vel.x = vx;
  e.vel.z = vz;
}
