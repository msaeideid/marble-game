import { createEnemy, stepEnemyPhysics, type EnemyState } from './enemy';
import { aimDir } from './aim';
import { stepEnemyAi } from './ai';
import { meleeTargets, pickSnareTarget, stepMelee } from './combat';
import { createPlayerState, handPos, stepPlayer, type PlayerState } from './controller';
import { trySpend } from './energy';
import { carryScales, PropSystem, type PropEvent, type PropWire } from './props';
import { applyDamage, regenHealth } from './health';
import type { EnemyParams, HeroParams, PropParams } from './params';
import { NEUTRAL_INTENT, type PlayerIntent, type Vec3 } from './types';
import {
  pickLockTarget,
  RocketSystem,
  StrikeSystem,
  strikePoint,
  traceChain,
  traceLaser,
  type RocketEvent,
  type StrikeEvent,
  type Target,
} from './weapons';
import type { World } from './world';

/** Things that happened this tick. Views use them for effects; netcode will broadcast them. */
export type SimEvent =
  | { type: 'melee'; attacker: string; step: number; yaw: number; hits: string[] }
  | { type: 'damage'; target: string; source: string | null; amount: number; shieldLost: number; coreLost: number }
  | { type: 'defeated'; id: string }
  | { type: 'respawn'; id: string }
  | { type: 'snare'; source: string; target: string }
  | { type: 'enemyAttack'; id: string; target: string }
  | { type: 'wave'; wave: number }
  | { type: 'break'; id: number; by: string }
  | { type: 'charge'; id: string; hits: string[] }
  | { type: 'laser'; owner: string; from: Vec3; to: Vec3; hit: string | null }
  | RocketEvent
  | StrikeEvent
  | { type: 'chain'; owner: string; points: Vec3[]; hits: string[] }
  | PropEvent;

/** The authoritative-style game simulation. No rendering, DOM or engine imports. */
export class Sim {
  tick = 0;
  readonly players = new Map<string, PlayerState>();
  readonly enemies = new Map<string, EnemyState>();
  /** Events from the most recent `step`. */
  events: SimEvent[] = [];
  private nextEnemyId = 1;
  private wave = 0;
  private waveTimer = 0;
  /** Lift-and-throw props; null when the level has none or props are turned off (online clients draw the server's). */
  readonly propSystem: PropSystem | null;
  private readonly propDefs: Record<string, PropParams>;
  /** Homing rockets in flight; null for heroes without the rocket kit. */
  readonly rocketSystem: RocketSystem | null;
  /** Storm strikes waiting to land; null for heroes without the storm kit. */
  readonly strikeSystem: StrikeSystem | null;

  /** With `waves` on, the level's enemy spawns are (re)populated whenever the arena is cleared. */
  constructor(
    readonly world: World,
    readonly hero: HeroParams,
    readonly enemyDefs: Record<string, EnemyParams> = {},
    private readonly opts: { waves?: boolean; props?: boolean; propDefs?: Record<string, PropParams> } = {},
  ) {
    this.propDefs = opts.propDefs ?? {};
    this.rocketSystem = hero.rockets ? new RocketSystem(world, hero.rockets) : null;
    this.strikeSystem = hero.tempest ? new StrikeSystem(hero.tempest) : null;
    this.propSystem =
      opts.props !== false && world.propSpawns.length > 0 && opts.propDefs ? new PropSystem(world, this.propDefs) : null;
  }

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
      const carry = player.carrying ? carryScales(this.propDefs[player.carrying.def]) : undefined;
      for (const c of stepPlayer(player, intent, this.hero, this.world, dt, carry)) {
        this.events.push({ type: 'break', id: c.id, by: id });
      }
      this.stepCharge(id, player);
      if (this.propSystem && intent.grabPressed) {
        this.events.push(...this.propSystem.handleGrab(id, player, this.hero, intent.yaw, intent.pitch));
      }
      // Hands are full: no striking while carrying.
      this.stepPlayerMelee(id, player, player.carrying ? { ...intent, attackPressed: false } : intent, dt);
      this.stepPlayerSnare(id, player, intent, dt);
      this.stepPlayerLaser(id, player, intent, dt);
      this.stepPlayerRockets(id, player, intent, dt);
      this.stepPlayerChain(id, player, intent, dt);
      this.stepPlayerStorm(id, player, intent, dt);
      regenHealth(player.health, this.hero.health, dt);
      player.invulnerable = Math.max(0, player.invulnerable - dt);
      this.applyBaseRegen(player, dt);
      if (player.pos.y < this.world.killY) this.respawn(id);
    }

    const targets = [...this.players]
      .filter(([, p]) => p.defeatedTimer === null)
      .map(([pid, p]) => ({ id: pid, pos: p.pos }));
    const crowd = [...this.enemies.values()];
    for (const [id, enemy] of this.enemies) {
      const def = this.enemyDefs[enemy.typeId]!;
      if (enemy.defeatedTimer !== null) {
        enemy.defeatedTimer -= dt;
        if (enemy.defeatedTimer <= 0) this.enemies.delete(id);
        continue;
      }
      stepEnemyAi(enemy, def, targets, crowd, dt, {
        attack: (targetId) => this.enemyHitsPlayer(enemy, def, targetId),
      });
      stepEnemyPhysics(enemy, def, this.world, dt);
      regenHealth(enemy.health, def.health, dt);
    }
    this.stepWaves(dt);
    this.stepProps(dt);
    this.stepRockets(dt);
    this.stepStrikes(dt);
    this.tick++;
  }

  private stepProps(dt: number): void {
    if (!this.propSystem) return;
    this.events.push(
      ...this.propSystem.step(dt, {
        holderTop: (pid) => {
          const p = this.players.get(pid);
          if (!p || p.defeatedTimer !== null) return null;
          return { x: p.pos.x, y: p.pos.y + this.hero.movement.height + 0.05, z: p.pos.z };
        },
        enemies: () =>
          [...this.enemies.values()]
            .filter((e) => e.defeatedTimer === null)
            .map((e) => {
              const m = this.enemyDefs[e.typeId]!.move;
              return { id: e.id, pos: e.pos, halfWidth: m.halfWidth, height: m.height };
            }),
        hitEnemy: (id, damage, dirX, dirZ, knockback) => {
          const e = this.enemies.get(id);
          if (!e) return;
          e.vel.x += dirX * knockback;
          e.vel.z += dirZ * knockback;
          this.damageEnemy(e, damage, 'prop');
          if (e.defeatedTimer === null) {
            e.aiState = 'stagger'; // a car to the face always knocks them off balance
            e.aiTimer = this.enemyDefs[e.typeId]!.staggerTime;
          }
        },
      }),
    );
  }

  /** The synced state of every prop (for snapshots and conformance checks). */
  get propWires(): PropWire[] {
    return this.propSystem?.toWire() ?? [];
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
    this.events.push({ type: 'melee', attacker: id, step: hitStep, yaw: intent.yaw, hits: struck.map((s) => s.e.id) });
  }

  /**
   * Standing on the base pad refills shield and energy fast and core health slowly, but only out of combat
   * (after the normal damage-regen delay has passed), so the pad is a place to recover, not to tank.
   */
  private applyBaseRegen(player: PlayerState, dt: number): void {
    const base = this.world.base;
    if (!base || !this.world.isOnBase(player.pos)) return;
    const h = this.hero;
    const outOfCombat = player.health.shieldDelay <= 0;
    if (outOfCombat) {
      player.health.shield = Math.min(h.health.shield.max, player.health.shield + base.regenPerSecond * dt);
      player.health.core = Math.min(h.health.core.max, player.health.core + base.regenPerSecond * 0.25 * dt);
    }
    player.energy = Math.min(h.energy.max, player.energy + base.regenPerSecond * 2 * dt);
  }

  get currentWave(): number {
    return this.wave;
  }

  /** A charging hero bowls over each enemy it runs into, once per charge. */
  private stepCharge(id: string, player: PlayerState): void {
    const charge = this.hero.charge;
    if (!charge || !player.charge) return;
    const struck: string[] = [];
    for (const e of this.enemies.values()) {
      if (e.defeatedTimer !== null || player.chargeHits.includes(e.id)) continue;
      const half = this.enemyDefs[e.typeId]!.move.halfWidth;
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const ahead = dx * player.charge.dirX + dz * player.charge.dirZ > -0.5; // not behind the rusher
      if (!ahead || Math.hypot(dx, dz) > charge.hitRadius + half || Math.abs(e.pos.y - player.pos.y) > 2) continue;
      player.chargeHits.push(e.id);
      struck.push(e.id);
      e.vel.x += player.charge.dirX * charge.knockback;
      e.vel.z += player.charge.dirZ * charge.knockback;
      this.damageEnemy(e, charge.damage, id);
      e.aiState = 'stagger'; // a charge always knocks the enemy off balance, poise or not
      e.aiTimer = this.enemyDefs[e.typeId]!.staggerTime;
    }
    if (struck.length > 0) this.events.push({ type: 'charge', id, hits: struck });
  }

  /** Holding fire shoots a bolt every `fireInterval`, each costing a little energy from the shared pool. */
  private stepPlayerLaser(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    player.laserCooldown = Math.max(0, player.laserCooldown - dt);
    const p = this.hero.laser;
    if (!p || !intent.fireHeld || player.laserCooldown > 0 || player.carrying) return;
    if (!trySpend(player, p.shotCost, this.hero.energy)) return;
    player.laserCooldown = p.fireInterval;
    const origin = handPos(player, this.hero);
    const shot = traceLaser(this.world, origin, aimDir(intent.yaw, intent.pitch), p, this.liveTargets());
    if (shot.hit) {
      const e = this.enemies.get(shot.hit.id);
      // A steady beam wears enemies down without stunning them, so they keep coming and you have to keep moving.
      if (e) this.damageEnemy(e, p.damage, id, { stagger: false });
    }
    this.events.push({ type: 'laser', owner: id, from: origin, to: shot.end, hit: shot.hit?.id ?? null });
  }

  private stepPlayerRockets(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    player.rocketCooldown = Math.max(0, player.rocketCooldown - dt);
    const p = this.hero.rockets;
    if (!p || !this.rocketSystem || !intent.rocketPressed || player.rocketCooldown > 0 || player.carrying) return;
    if (!trySpend(player, p.cost, this.hero.energy)) return;
    player.rocketCooldown = p.cooldown;
    const hand = handPos(player, this.hero);
    const dir = aimDir(intent.yaw, intent.pitch);
    const lock = pickLockTarget(this.world, hand, dir, p, this.liveTargets());
    const muzzle = { x: hand.x + dir.x * 0.8, y: hand.y + dir.y * 0.8, z: hand.z + dir.z * 0.8 };
    this.events.push(this.rocketSystem.launch(id, muzzle, dir, lock?.id ?? null));
  }

  /** Chain lightning: shock the enemy under the crosshair and the ones near it. No target, no cost. */
  private stepPlayerChain(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    player.chainCooldown = Math.max(0, player.chainCooldown - dt);
    const p = this.hero.chain;
    if (!p || !intent.chainPressed || player.chainCooldown > 0 || player.carrying) return;
    const hand = handPos(player, this.hero);
    const { hits } = traceChain(this.world, hand, aimDir(intent.yaw, intent.pitch), p, this.liveTargets());
    if (hits.length === 0 || !trySpend(player, p.cost, this.hero.energy)) return;
    player.chainCooldown = p.cooldown;
    const points: Vec3[] = [hand];
    hits.forEach((t, i) => {
      points.push({ x: t.pos.x, y: t.pos.y + t.height / 2, z: t.pos.z });
      const e = this.enemies.get(t.id);
      if (!e) return;
      this.damageEnemy(e, p.damage * p.damageFalloff ** i, id, { stagger: false });
      this.stun(e, p.stunTime);
    });
    this.events.push({ type: 'chain', owner: id, points, hits: hits.map((t) => t.id) });
  }

  /** Storm strike: call lightning down on the spot you aim at (the sky does nothing). */
  private stepPlayerStorm(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    player.stormCooldown = Math.max(0, player.stormCooldown - dt);
    const p = this.hero.tempest;
    if (!p || !this.strikeSystem || !intent.stormPressed || player.stormCooldown > 0 || player.carrying) return;
    const at = strikePoint(this.world, handPos(player, this.hero), aimDir(intent.yaw, intent.pitch), p);
    if (!at || !trySpend(player, p.cost, this.hero.energy)) return;
    player.stormCooldown = p.cooldown;
    this.events.push(this.strikeSystem.call(id, at));
  }

  private stepStrikes(dt: number): void {
    if (!this.strikeSystem) return;
    this.events.push(
      ...this.strikeSystem.step(dt, {
        targets: () => this.liveTargets(),
        shock: (eid, damage, stunTime, dirX, dirZ, knockback) => {
          const e = this.enemies.get(eid);
          if (!e) return;
          e.vel.x += dirX * knockback;
          e.vel.z += dirZ * knockback;
          this.damageEnemy(e, damage, 'storm', { stagger: false });
          this.stun(e, stunTime);
        },
      }),
    );
  }

  /** Shock an enemy still: it cannot move or attack for `seconds`, even if it had poise. */
  private stun(e: EnemyState, seconds: number): void {
    if (e.defeatedTimer !== null) return;
    e.aiTimer = e.aiState === 'stagger' ? Math.max(e.aiTimer, seconds) : seconds;
    e.aiState = 'stagger';
  }

  private stepRockets(dt: number): void {
    if (!this.rocketSystem) return;
    this.events.push(
      ...this.rocketSystem.step(dt, {
        targets: () => this.liveTargets(),
        blast: (eid, amount, dirX, dirZ, knockback) => {
          const e = this.enemies.get(eid);
          if (!e) return;
          e.vel.x += dirX * knockback;
          e.vel.z += dirZ * knockback;
          this.damageEnemy(e, amount, 'rocket');
          if (e.defeatedTimer === null) {
            e.aiState = 'stagger'; // a rocket always knocks them off balance
            e.aiTimer = this.enemyDefs[e.typeId]!.staggerTime;
          }
        },
      }),
    );
  }

  /** Enemies a weapon can hit right now. */
  liveTargets(): Target[] {
    const out: Target[] = [];
    for (const e of this.enemies.values()) {
      if (e.defeatedTimer !== null) continue;
      const m = this.enemyDefs[e.typeId]!.move;
      out.push({ id: e.id, pos: e.pos, halfWidth: m.halfWidth, height: m.height });
    }
    return out;
  }

  private stepPlayerSnare(id: string, player: PlayerState, intent: PlayerIntent, dt: number): void {
    player.snareCooldown = Math.max(0, player.snareCooldown - dt);
    const p = this.hero.snare;
    if (!p || !intent.snarePressed || player.snareCooldown > 0) return;
    const candidates = [...this.enemies.values()]
      .filter((e) => e.defeatedTimer === null)
      .map((e) => {
        const move = this.enemyDefs[e.typeId]!.move;
        return { e, pos: e.pos, halfWidth: move.halfWidth, height: move.height };
      });
    const origin = handPos(player, this.hero);
    const hit = pickSnareTarget(this.world, origin, aimDir(intent.yaw, intent.pitch), p, candidates);
    if (!hit || !trySpend(player, p.cost, this.hero.energy)) return;
    player.snareCooldown = p.cooldown;
    hit.e.snaredTimer = p.duration;
    if (hit.e.aiState === 'windup') hit.e.aiState = 'chase';
    this.events.push({ type: 'snare', source: id, target: hit.e.id });
  }

  private enemyHitsPlayer(enemy: EnemyState, def: EnemyParams, targetId: string): void {
    const player = this.players.get(targetId);
    if (!player || player.defeatedTimer !== null) return;
    const dx = player.pos.x - enemy.pos.x;
    const dz = player.pos.z - enemy.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    player.vel.x += (dx / d) * def.attack.knockback;
    player.vel.z += (dz / d) * def.attack.knockback;
    this.events.push({ type: 'enemyAttack', id: enemy.id, target: targetId });
    this.damagePlayer(targetId, def.attack.damage, enemy.id);
  }

  private stepWaves(dt: number): void {
    const spawns = this.world.enemySpawns;
    if (!this.opts.waves || spawns.length === 0) return;
    if (this.enemies.size > 0) {
      this.waveTimer = this.world.waveDelay;
      return;
    }
    this.waveTimer -= dt;
    if (this.waveTimer > 0 && this.wave > 0) return;
    this.wave++;
    const count = Math.min(5, spawns.length + this.wave - 1);
    for (let i = 0; i < count; i++) {
      const s = spawns[i % spawns.length]!;
      const ring = Math.floor(i / spawns.length);
      this.spawnEnemy(s.type, { x: s.pos.x + ring * 1.6, y: s.pos.y, z: s.pos.z });
    }
    this.events.push({ type: 'wave', wave: this.wave });
  }

  damageEnemy(enemy: EnemyState, amount: number, sourceId: string | null, opts: { stagger?: boolean } = {}): void {
    if (enemy.defeatedTimer !== null) return;
    const def = this.enemyDefs[enemy.typeId]!;
    const r = applyDamage(enemy.health, amount, def.health);
    this.events.push({ type: 'damage', target: enemy.id, source: sourceId, amount, shieldLost: r.shieldLost, coreLost: r.coreLost });
    if (r.defeated) {
      enemy.defeatedTimer = def.powerDownTime;
      this.events.push({ type: 'defeated', id: enemy.id });
    } else if (amount > 0 && opts.stagger !== false && enemy.aiState !== 'stagger' && enemy.poiseTimer <= 0) {
      enemy.aiState = 'stagger';
      enemy.aiTimer = def.staggerTime;
    }
  }

  damagePlayer(id: string, amount: number, sourceId: string | null): void {
    const player = this.players.get(id);
    if (!player || player.defeatedTimer !== null || player.invulnerable > 0) return;
    const r = applyDamage(player.health, amount, this.hero.health);
    this.events.push({ type: 'damage', target: id, source: sourceId, amount, shieldLost: r.shieldLost, coreLost: r.coreLost });
    if (r.defeated) {
      player.defeatedTimer = this.hero.respawnDelay;
      player.tether = null;
      player.zip = null;
      player.flying = false;
      this.propSystem?.dropHeldBy(id, player.pos);
      player.carrying = null;
      this.events.push({ type: 'defeated', id });
    }
  }

  /** Reset in place so references held by views and tests stay valid. */
  private respawn(id: string): void {
    const state = this.players.get(id);
    if (!state) return;
    this.propSystem?.dropHeldBy(id, state.pos);
    Object.assign(state, createPlayerState(this.world.spawn, this.hero));
    this.events.push({ type: 'respawn', id });
  }
}
