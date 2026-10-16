import { moveAndCollide } from './controller';
import { createHealth, type HealthState } from './health';
import type { EnemyParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

export interface EnemyState {
  id: string;
  typeId: string;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  facing: number;
  grounded: boolean;
  health: HealthState;
  /** Seconds left of the "power down" animation after defeat, otherwise null. */
  defeatedTimer: number | null;
}

export function createEnemy(id: string, def: EnemyParams, pos: Vec3): EnemyState {
  return {
    id,
    typeId: def.id,
    pos: { ...pos },
    prevPos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    facing: 0,
    grounded: false,
    health: createHealth(def.health),
    defeatedTimer: null,
  };
}

const GRAVITY = 28;
/** Fraction of horizontal knockback speed lost per second. */
const KNOCKBACK_FRICTION = 8;

/** Gravity, knockback decay and collision for one enemy. AI steering (S4) adds to `vel` before this runs. */
export function stepEnemyPhysics(e: EnemyState, def: EnemyParams, world: World, dt: number): void {
  e.prevPos = { ...e.pos };
  e.vel.y -= GRAVITY * dt;
  const decay = Math.max(0, 1 - KNOCKBACK_FRICTION * dt);
  e.vel.x *= decay;
  e.vel.z *= decay;
  const r = moveAndCollide(
    e.pos,
    { x: e.vel.x * dt, y: e.vel.y * dt, z: e.vel.z * dt },
    def.move,
    world.colliders,
  );
  if (r.hitX) e.vel.x = 0;
  if (r.hitZ) e.vel.z = 0;
  e.grounded = r.hitDown;
  if (r.hitDown || r.hitUp) e.vel.y = 0;
}
