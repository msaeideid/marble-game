import { aimDir } from './aim';
import { moveAndCollide, type PlayerState } from './controller';
import type { HeroParams, LiftParams, PropParams } from './params';
import type { Vec3 } from './types';
import type { World } from './world';

export type PropMode = 'resting' | 'held' | 'thrown' | 'destroyed';

export interface PropState {
  /** Index in the level's prop list; stable, and how props are identified over the network. */
  id: number;
  /** Prop type id (shared/data/props). */
  defId: string;
  /** Centre of the prop's base (like a character's feet). */
  pos: Vec3;
  vel: Vec3;
  mode: PropMode;
  /** Player id carrying it, while held. */
  holder: string | null;
  /** Impacts left before it breaks. */
  hp: number;
  /** Seconds until a destroyed prop reappears at its home. */
  respawn: number;
  home: Vec3;
  /** Enemies already struck by the current throw (not synced). */
  hit: string[];
}

/** The synced part of a prop. This exact shape is in snapshots and in the conformance scenarios. */
export interface PropWire {
  id: number;
  def: string;
  pos: [number, number, number];
  vel: [number, number, number];
  mode: PropMode;
  holder: string | null;
  hp: number;
  respawn: number;
}

export type PropEvent =
  | { type: 'lift'; id: number; by: string }
  | { type: 'throw'; id: number; by: string }
  | { type: 'impact'; id: number; speed: number; hits: string[] }
  | { type: 'propBreak'; id: number }
  | { type: 'propRespawn'; id: number }
  | { type: 'break'; id: number; by: string };

/** What a prop needs to know about the rest of the world while it flies. */
export interface PropHooks {
  /** Where a held prop's base should sit (on top of the carrier's head), or null if the carrier is gone. */
  holderTop(playerId: string): Vec3 | null;
  /** Enemies a thrown prop can hit. Absent on the server until combat is networked. */
  enemies?(): Iterable<{ id: string; pos: Vec3; halfWidth: number; height: number }>;
  hitEnemy?(id: string, damage: number, dirX: number, dirZ: number, knockback: number): void;
}

const GRAVITY = 28;
/** A thrown prop must be moving at least this fast to damage itself on a hard stop. */
const IMPACT_SPEED = 6;
/** ...and at least this fast to smash a breakable wall. */
const WALL_BREAK_SPEED = 8;

export interface CarryScales {
  speedScale: number;
  jumpScale: number;
}

/** Movement penalty for carrying a prop of the given type. */
export function carryScales(def: PropParams | undefined): CarryScales | undefined {
  if (!def) return undefined;
  return { speedScale: def.carrySlow, jumpScale: Math.sqrt(def.carrySlow) };
}

/** The level's lift-and-throw props: lifting, carrying, throwing, landing, breaking, respawning. */
export class PropSystem {
  readonly props: PropState[];

  constructor(
    private readonly world: World,
    readonly defs: Record<string, PropParams>,
  ) {
    this.props = world.propSpawns.map((s, id) => {
      const def = defs[s.type];
      if (!def) throw new Error(`Level prop ${id} has unknown type "${s.type}"`);
      return {
        id,
        defId: s.type,
        pos: { ...s.pos },
        vel: { x: 0, y: 0, z: 0 },
        mode: 'resting' as PropMode,
        holder: null,
        hp: def.hp,
        respawn: 0,
        home: { ...s.pos },
        hit: [],
      };
    });
  }

  byId(id: number): PropState | undefined {
    return this.props[id];
  }

  /** The press of the grab button: throw what you are carrying, otherwise lift the nearest prop in reach. */
  handleGrab(
    playerId: string,
    player: PlayerState,
    hero: HeroParams,
    yaw: number,
    pitch: number,
  ): PropEvent[] {
    const lift = hero.lift;
    if (!lift || player.grabCooldown > 0 || player.charge) return [];
    if (player.carrying) return this.throwHeld(playerId, player, hero, lift, yaw, pitch);
    return this.liftNearest(playerId, player, lift);
  }

  private liftNearest(playerId: string, player: PlayerState, lift: LiftParams): PropEvent[] {
    let best: PropState | null = null;
    let bestD = Infinity;
    for (const pr of this.props) {
      if (pr.mode !== 'resting') continue;
      const half = this.defs[pr.defId]!.size.halfWidth;
      const d = Math.hypot(pr.pos.x - player.pos.x, pr.pos.z - player.pos.z);
      if (d > lift.liftRange + half || Math.abs(pr.pos.y - player.pos.y) > 2.5) continue;
      if (d < bestD) {
        best = pr;
        bestD = d;
      }
    }
    if (!best) return [];
    best.mode = 'held';
    best.holder = playerId;
    best.vel = { x: 0, y: 0, z: 0 };
    player.carrying = { id: best.id, def: best.defId };
    player.grabCooldown = lift.cooldown;
    return [{ type: 'lift', id: best.id, by: playerId }];
  }

  private throwHeld(
    playerId: string,
    player: PlayerState,
    hero: HeroParams,
    lift: LiftParams,
    yaw: number,
    pitch: number,
  ): PropEvent[] {
    const pr = this.props[player.carrying!.id];
    player.carrying = null;
    player.grabCooldown = lift.cooldown;
    if (!pr) return [];
    const def = this.defs[pr.defId]!;
    // Throw along the camera's aim, lifted a little so a level aim still arcs instead of hitting the floor.
    const a = aimDir(yaw, pitch);
    let dx = a.x;
    let dy = Math.max(a.y, 0.1) + 0.15;
    let dz = a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const speed = def.throwSpeed * lift.strength;
    // Start just in front of the thrower at chest height; collision resolves it if that is inside a wall.
    const h = Math.hypot(a.x, a.z) || 1;
    const reach = hero.movement.halfWidth + def.size.halfWidth + 0.15;
    pr.pos = {
      x: player.pos.x + (a.x / h) * reach,
      y: player.pos.y + hero.movement.height * 0.7,
      z: player.pos.z + (a.z / h) * reach,
    };
    pr.vel = { x: dx * speed, y: dy * speed, z: dz * speed };
    pr.mode = 'thrown';
    pr.holder = null;
    pr.hit = [];
    return [{ type: 'throw', id: pr.id, by: playerId }];
  }

  /** A carrier was defeated or left: whatever they held drops where they stood. */
  dropHeldBy(playerId: string, at: Vec3): void {
    for (const pr of this.props) {
      if (pr.mode === 'held' && pr.holder === playerId) {
        pr.mode = 'resting';
        pr.holder = null;
        pr.pos = { ...at };
        pr.vel = { x: 0, y: 0, z: 0 };
      }
    }
  }

  step(dt: number, hooks: PropHooks): PropEvent[] {
    const events: PropEvent[] = [];
    for (const pr of this.props) {
      const def = this.defs[pr.defId]!;
      switch (pr.mode) {
        case 'held': {
          const top = pr.holder ? hooks.holderTop(pr.holder) : null;
          if (top) pr.pos = top;
          else {
            pr.mode = 'resting';
            pr.holder = null;
          }
          break;
        }
        case 'destroyed': {
          pr.respawn -= dt;
          if (pr.respawn <= 0) {
            pr.mode = 'resting';
            pr.pos = { ...pr.home };
            pr.vel = { x: 0, y: 0, z: 0 };
            pr.hp = def.hp;
            events.push({ type: 'propRespawn', id: pr.id });
          }
          break;
        }
        case 'resting': {
          // Settle onto whatever is underneath (a prop dropped in mid-air falls; one on the ground stays put).
          pr.vel.y -= GRAVITY * dt;
          const r = moveAndCollide(pr.pos, { x: 0, y: pr.vel.y * dt, z: 0 }, def.size, this.world.active);
          if (r.hitDown || r.hitUp) pr.vel.y = 0;
          if (pr.pos.y < this.world.killY) this.destroy(pr, def, events);
          break;
        }
        case 'thrown':
          this.stepThrown(pr, def, dt, hooks, events);
          break;
      }
    }
    return events;
  }

  private destroy(pr: PropState, def: PropParams, events: PropEvent[]): void {
    pr.mode = 'destroyed';
    pr.respawn = def.respawnTime;
    pr.vel = { x: 0, y: 0, z: 0 };
    pr.holder = null;
    events.push({ type: 'propBreak', id: pr.id });
  }

  private stepThrown(pr: PropState, def: PropParams, dt: number, hooks: PropHooks, events: PropEvent[]): void {
    pr.vel.y -= GRAVITY * dt;
    const speedBefore = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z);
    const r = moveAndCollide(
      pr.pos,
      { x: pr.vel.x * dt, y: pr.vel.y * dt, z: pr.vel.z * dt },
      def.size,
      this.world.active,
    );

    // Enemies in the way take the hit; the prop loses some of its force and a hit point.
    const struck: string[] = [];
    if (hooks.enemies && hooks.hitEnemy) {
      for (const e of hooks.enemies()) {
        if (pr.hit.includes(e.id)) continue;
        const overlap =
          Math.abs(e.pos.x - pr.pos.x) < def.size.halfWidth + e.halfWidth &&
          Math.abs(e.pos.z - pr.pos.z) < def.size.halfWidth + e.halfWidth &&
          pr.pos.y < e.pos.y + e.height &&
          pr.pos.y + def.size.height > e.pos.y;
        if (!overlap) continue;
        pr.hit.push(e.id);
        struck.push(e.id);
        const h = Math.hypot(pr.vel.x, pr.vel.z) || 1;
        hooks.hitEnemy(e.id, def.throwDamage, pr.vel.x / h, pr.vel.z / h, def.throwKnockback);
        pr.hp -= 1;
        pr.vel.x *= 0.35;
        pr.vel.z *= 0.35;
      }
    }

    const blocked = r.hitX || r.hitZ || r.hitUp || r.hitDown;
    if (blocked && speedBefore >= WALL_BREAK_SPEED) {
      for (const c of r.sideHits) {
        if (c.breakable !== undefined && c.breakable <= def.breakPower && this.world.breakCollider(c.id)) {
          events.push({ type: 'break', id: c.id, by: `prop:${pr.id}` });
        }
      }
    }
    if (blocked || pr.hp <= 0) {
      if (blocked && speedBefore >= IMPACT_SPEED) pr.hp -= 1;
      events.push({ type: 'impact', id: pr.id, speed: speedBefore, hits: struck });
      pr.vel = { x: 0, y: 0, z: 0 };
      if (pr.hp <= 0) this.destroy(pr, def, events);
      else pr.mode = 'resting';
    } else if (struck.length > 0) {
      events.push({ type: 'impact', id: pr.id, speed: speedBefore, hits: struck });
    }
    if (pr.mode === 'thrown' && pr.pos.y < this.world.killY) this.destroy(pr, def, events);
  }

  toWire(): PropWire[] {
    return this.props.map((p) => ({
      id: p.id,
      def: p.defId,
      pos: [p.pos.x, p.pos.y, p.pos.z],
      vel: [p.vel.x, p.vel.y, p.vel.z],
      mode: p.mode,
      holder: p.holder,
      hp: p.hp,
      respawn: p.respawn,
    }));
  }
}
