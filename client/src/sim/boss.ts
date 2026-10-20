import type { EnemyState } from './enemy';
import type { BossAttack, EnemyParams } from './params';
import type { Vec3 } from './types';

/** What a boss is doing right now. */
export interface BossState {
  /** Index into the boss's phase list. */
  phase: number;
  mode: 'walk' | 'windup' | 'charge' | 'recover';
  /** The attack being wound up or performed (index into the current phase's attack list), or -1. */
  attack: number;
  timer: number;
  /** Seconds until each attack (keyed `phase:index`) may be chosen again. */
  cooldowns: Record<string, number>;
  /** Direction of the current charge. */
  dirX: number;
  dirZ: number;
  /** Players already struck by the current charge. */
  hit: string[];
}

export function createBossState(): BossState {
  return { phase: 0, mode: 'walk', attack: -1, timer: 0, cooldowns: {}, dirX: 0, dirZ: 1, hit: [] };
}

export interface BossTelegraph {
  kind: BossAttack['kind'];
  pos: Vec3;
  radius: number;
  delay: number;
  dirX: number;
  dirZ: number;
}

/** What the boss needs from the world: hurting players in an area, calling minions, and telling the views. */
export interface BossHooks {
  /** Hurt every player within `radius` of `at` (except ids in `skip`); returns who was hit. */
  area(at: Vec3, radius: number, damage: number, knockback: number, skip: readonly string[]): string[];
  spawn(type: string, pos: Vec3): void;
  /** How many live enemies of this type are in the world (to cap summons). */
  count(type: string): number;
  telegraph(t: BossTelegraph): void;
  strike(info: { kind: BossAttack['kind']; pos: Vec3; radius: number; hits: string[] }): void;
  phase(phase: number): void;
}

export interface BossTarget {
  id: string;
  pos: Vec3;
}

/** Fraction of horizontal velocity lost per second to friction (enemy physics applies it every tick). */
export const KNOCKBACK_FRICTION = 8;

const RECOVER = 0.7;
/** The boss stops this far from its target (m), unless the data says otherwise. */
const STOP_DISTANCE = 2.6;
/** A charging boss hurts a player this close to it. */
const CHARGE_REACH = 1.9;

/** The phase for a health fraction: the last one whose threshold has been reached. */
export function phaseFor(def: EnemyParams, fraction: number): number {
  const phases = def.boss!.phases;
  let ph = 0;
  for (let i = 0; i < phases.length; i++) if (fraction <= phases[i]!.fromFraction) ph = i;
  return ph;
}

const key = (phase: number, i: number) => `${phase}:${i}`;

/** One tick of boss behaviour: walk at the nearest player, pick an attack, telegraph it, then do it. */
export function stepBossAi(
  e: EnemyState,
  def: EnemyParams,
  targets: readonly BossTarget[],
  dt: number,
  hooks: BossHooks,
): void {
  const b = e.boss!;
  const boss = def.boss!;
  // Physics bleeds some velocity every tick; ask for a little more so the speeds in the data are the speeds you see.
  const keep = Math.max(0.1, 1 - KNOCKBACK_FRICTION * dt);
  e.attackCooldown = Math.max(0, e.attackCooldown - dt);

  if (e.snaredTimer > 0) {
    e.snaredTimer = Math.max(0, e.snaredTimer - dt);
    e.vel.x = 0;
    e.vel.z = 0;
    return;
  }
  if (e.aiState === 'stagger') {
    // Stunned (stuns are shortened by `resist.stun` when they are applied).
    e.aiTimer -= dt;
    e.vel.x = 0;
    e.vel.z = 0;
    if (e.aiTimer <= 0) e.aiState = 'chase';
    return;
  }

  for (const k of Object.keys(b.cooldowns)) b.cooldowns[k] = Math.max(0, b.cooldowns[k]! - dt);

  const max = def.health.shield.max + def.health.core.max;
  const phase = phaseFor(def, (e.health.shield + e.health.core) / max);
  if (phase !== b.phase) {
    b.phase = phase;
    hooks.phase(phase);
  }
  const current = boss.phases[b.phase]!;

  let target: BossTarget | null = null;
  let best = def.aggroRange;
  for (const t of targets) {
    const d = Math.hypot(t.pos.x - e.pos.x, t.pos.z - e.pos.z);
    if (d <= best) {
      target = t;
      best = d;
    }
  }
  if (!target) {
    e.aiState = 'idle';
    e.vel.x = 0;
    e.vel.z = 0;
    return;
  }
  if (e.aiState === 'idle') e.aiState = 'chase';
  const dx = target.pos.x - e.pos.x;
  const dz = target.pos.z - e.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 0.01 && b.mode !== 'charge') e.facing = Math.atan2(dx, dz);

  switch (b.mode) {
    case 'walk': {
      for (const [i, a] of current.attacks.entries()) {
        if ((b.cooldowns[key(b.phase, i)] ?? 0) > 0) continue;
        const ready =
          (a.kind === 'slam' && dist <= (a.range ?? 5)) ||
          (a.kind === 'charge' && dist >= 6 && dist <= 24) ||
          (a.kind === 'summon' && hooks.count(a.enemy ?? '') < (a.count ?? 2) * 2);
        if (!ready) continue;
        b.mode = 'windup';
        b.attack = i;
        b.timer = a.windup;
        b.dirX = dx / (dist || 1);
        b.dirZ = dz / (dist || 1);
        e.vel.x = 0;
        e.vel.z = 0;
        hooks.telegraph({
          kind: a.kind,
          pos: { ...e.pos },
          radius: a.kind === 'slam' ? (a.radius ?? 5) : a.kind === 'charge' ? CHARGE_REACH : 0,
          delay: a.windup,
          dirX: b.dirX,
          dirZ: b.dirZ,
        });
        return;
      }
      const stop = def.attack.range > 0 ? Math.max(def.attack.range, STOP_DISTANCE) : STOP_DISTANCE;
      const speed = (def.move.speed * current.speed) / keep;
      e.vel.x = dist > stop ? (dx / dist) * speed : 0;
      e.vel.z = dist > stop ? (dz / dist) * speed : 0;
      return;
    }
    case 'windup': {
      e.vel.x = 0;
      e.vel.z = 0;
      b.timer -= dt;
      if (b.timer > 0) return;
      const a = current.attacks[b.attack]!;
      b.cooldowns[key(b.phase, b.attack)] = a.cooldown;
      if (a.kind === 'slam') {
        const hits = hooks.area(e.pos, a.radius ?? 5, a.damage ?? 20, a.knockback ?? 10, []);
        hooks.strike({ kind: 'slam', pos: { ...e.pos }, radius: a.radius ?? 5, hits });
        b.mode = 'recover';
        b.timer = RECOVER;
      } else if (a.kind === 'summon') {
        const n = a.count ?? 2;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2 + e.pos.x;
          hooks.spawn(a.enemy!, { x: e.pos.x + Math.sin(ang) * 3.2, y: e.pos.y + 0.5, z: e.pos.z + Math.cos(ang) * 3.2 });
        }
        hooks.strike({ kind: 'summon', pos: { ...e.pos }, radius: 0, hits: [] });
        b.mode = 'recover';
        b.timer = RECOVER;
      } else {
        b.mode = 'charge';
        b.timer = a.duration ?? 1;
        b.hit = [];
        e.facing = Math.atan2(b.dirX, b.dirZ);
      }
      return;
    }
    case 'charge': {
      const a = current.attacks[b.attack]!;
      e.vel.x = (b.dirX * (a.speed ?? 14)) / keep;
      e.vel.z = (b.dirZ * (a.speed ?? 14)) / keep;
      // The boss is big: it hurts anyone its body touches, not just its centre.
      const hits = hooks.area(e.pos, CHARGE_REACH + def.move.halfWidth, a.damage ?? 20, a.knockback ?? 12, b.hit);
      if (hits.length > 0) {
        b.hit.push(...hits);
        hooks.strike({ kind: 'charge', pos: { ...e.pos }, radius: CHARGE_REACH + def.move.halfWidth, hits });
      }
      b.timer -= dt;
      if (b.timer <= 0) {
        b.mode = 'recover';
        b.timer = RECOVER;
      }
      return;
    }
    case 'recover': {
      e.vel.x = 0;
      e.vel.z = 0;
      b.timer -= dt;
      if (b.timer <= 0) b.mode = 'walk';
      return;
    }
  }
}
