import { createEnemy, stepEnemyPhysics, type EnemyState } from './enemy';
import { meleeTargets, stepMelee } from './combat';
import { createPlayerState, stepPlayer, type PlayerState } from './controller';
import { trySpend } from './energy';
import { applyDamage, regenHealth } from './health';
import type { EnemyParams, HeroParams } from './params';
import { NEUTRAL_INTENT, type PlayerIntent, type Vec3 } from './types';
import type { World } from './world';

/** Things that happened this tick. Views use them for effects; netcode will broadcast them. */
export type SimEvent =
  | { type: 'melee'; attacker: string; step: number; hits: string[] }
  | { type: 'damage'; target: string; source: string | null; amount: number; shieldLost: number; coreLost: number }
  | { type: 'defeated'; id: string }
  | { type: 'respawn'; id: string };

/** The authoritative-style game simulation. No rendering, DOM or engine imports. */
export class Sim {
  tick = 0;
  readonly players = new Map<string, PlayerState>();
  readonly enemies = new Map<string, EnemyState>();
  /** Events from the most recent `step`. */
  events: SimEvent[] = [];
  private nextEnemyId = 1;

  constructor(
    readonly world: World,
    readonly hero: HeroParams,
    readonly enemyDefs: Record<string, EnemyParams> = {},
  ) {}

  addPlayer(id: string): PlayerState {
    const state = createPlayerState(this.world.spawn, this.hero);
    this.players.set(id, state);
    return state;
  }

  spawnEnemy(typeId: string, pos: Vec3): EnemyState {
    const def = this.enemyDefs[typeId];
    if (!def) throw new Error(`Unknown enemy type "${typeId}"`);
    const id = `enemy-${this.nextEnemyId++}`;
    const enemy = createEnemy(id, def, pos);
    this.enemies.set(id, enemy);
    return enemy;
  }

  /** Advance every entity one fixed tick using the intents supplied this tick. */
  step(dt: number, intents: ReadonlyMap<string, PlayerIntent>): void {
    this.events = [];
    for (const [id, player] of this.players) {
      if (player.defeatedTimer !== null) {
        player.defeatedTimer -= dt;
        if (player.defeatedTimer <= 0) this.respawn(id);
        continue;
      }
      const intent = intents.get(id) ?? NEUTRAL_INTENT;
      stepPlayer(player, intent, this.hero, this.world, dt);
      this.stepPlayerMelee(id, player, intent, dt);
      regenHealth(player.health, this.hero.health, dt);
      if (player.pos.y < this.world.killY) this.respawn(id);
    }

    for (const [id, enemy] of this.enemies) {
      const def = this.enemyDefs[enemy.typeId]!;
      if (enemy.defeatedTimer !== null) {
        enemy.defeatedTimer -= dt;
        if (enemy.defeatedTimer <= 0) this.enemies.delete(id);
        continue;
      }
      stepEnemyPhysics(enemy, def, this.world, dt);
      regenHealth(enemy.health, def.health, dt);
    }
    this.tick++;
  }

  private stepPlayerMelee(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    const melee = this.hero.melee;
    const hitStep = stepMelee(player.melee, intent.attackPressed, melee, dt, (cost) =>
      trySpend(player, cost, this.hero.energy),
    );
    if (hitStep === null) return;

    const step = melee.steps[hitStep]!;
    const live = [...this.enemies.values()]
      .filter((e) => e.defeatedTimer === null)
      .map((e) => ({ e, pos: e.pos, halfWidth: this.enemyDefs[e.typeId]!.move.halfWidth }));
    const struck = meleeTargets(player.pos, intent.yaw, melee, live);
    for (const { e } of struck) {
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      e.vel.x += (dx / d) * step.knockback;
      e.vel.z += (dz / d) * step.knockback;
      this.damageEnemy(e, step.damage, id);
    }
    this.events.push({ type: 'melee', attacker: id, step: hitStep, hits: struck.map((s) => s.e.id) });
  }

  damageEnemy(enemy: EnemyState, amount: number, sourceId: string | null): void {
    if (enemy.defeatedTimer !== null) return;
    const def = this.enemyDefs[enemy.typeId]!;
    const r = applyDamage(enemy.health, amount, def.health);
    this.events.push({ type: 'damage', target: enemy.id, source: sourceId, amount, shieldLost: r.shieldLost, coreLost: r.coreLost });
    if (r.defeated) {
      enemy.defeatedTimer = def.powerDownTime;
      this.events.push({ type: 'defeated', id: enemy.id });
    }
  }

  damagePlayer(id: string, amount: number, sourceId: string | null): void {
    const player = this.players.get(id);
    if (!player || player.defeatedTimer !== null) return;
    const r = applyDamage(player.health, amount, this.hero.health);
    this.events.push({ type: 'damage', target: id, source: sourceId, amount, shieldLost: r.shieldLost, coreLost: r.coreLost });
    if (r.defeated) {
      player.defeatedTimer = this.hero.respawnDelay;
      player.tether = null;
      player.zip = null;
      this.events.push({ type: 'defeated', id });
    }
  }

  /** Reset in place so references held by views and tests stay valid. */
  private respawn(id: string): void {
    const state = this.players.get(id);
    if (!state) return;
    Object.assign(state, createPlayerState(this.world.spawn, this.hero));
    this.events.push({ type: 'respawn', id });
  }
}
