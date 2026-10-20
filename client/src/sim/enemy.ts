import { moveAndCollide } from './controller';
import { createBossState, KNOCKBACK_FRICTION, type BossState } from './boss';
import { createHealth, type HealthState } from './health';
import type { EnemyParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

export type AiState = 'idle' | 'chase' | 'windup' | 'recovery' | 'stagger';

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
  aiState: AiState;
  /** Seconds left in the current windup / recovery / stagger. */
  aiTimer: number;
  /** Seconds until this enemy may start another attack. */
  attackCooldown: number;
  /** Seconds left held by a snare (cannot move or attack). */
  snaredTimer: number;
  /** While > 0, hits cannot stagger this enemy. */
  poiseTimer: number;
  /** Boss behaviour state, for enemies whose definition has a `boss` block. */
  boss: BossState | null;
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
    aiState: 'idle',
    aiTimer: 0,
    attackCooldown: 0,
    snaredTimer: 0,
    poiseTimer: def.boss ? 1e9 : 0, // bosses are never staggered by hits
    boss: def.boss ? createBossState() : null,
  };
}

const GRAVITY = 28;

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
    world.active,
  );
  if (r.hitX) e.vel.x = 0;
  if (r.hitZ) e.vel.z = 0;
  e.grounded = r.hitDown;
  if (r.hitDown || r.hitUp) e.vel.y = 0;
}

/** The part of an enemy that clients draw (snapshots) and conformance scenarios record. Same shape as the Python server's. */
export interface EnemyWire {
  id: string;
  type: string;
  pos: [number, number, number];
  vel: [number, number, number];
  facing: number;
  ai: AiState;
  aiTimer: number;
  shield: number;
  core: number;
  snared: number;
  poise: number;
  cooldown: number;
  defeated: number | null;
}

export function enemyWire(e: EnemyState): EnemyWire {
  return {
    id: e.id,
    type: e.typeId,
    pos: [e.pos.x, e.pos.y, e.pos.z],
    vel: [e.vel.x, e.vel.y, e.vel.z],
    facing: e.facing,
    ai: e.aiState,
    aiTimer: e.aiTimer,
    shield: e.health.shield,
    core: e.health.core,
    snared: e.snaredTimer,
    poise: e.poiseTimer,
    cooldown: e.attackCooldown,
    defeated: e.defeatedTimer,
  };
}
