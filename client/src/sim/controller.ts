import { aimDir } from './aim';
import { createMelee, type MeleeState } from './combat';
import { drain, regen, trySpend } from './energy';
import { createHealth, type HealthState } from './health';
import type { BoxSize, HeroParams } from './params';
import {
  pickSwingAnchor,
  pickZipAnchor,
  removeOutwardVelocity,
  ropeLimitedDelta,
} from './swing';
import type { Collider, PlayerIntent, Vec3 } from './types';
import type { World } from './world';

export interface Tether {
  anchor: Vec3;
  length: number;
  /** The rope shortens toward this length (auto-reel on attach, manual reel while held). */
  targetLength: number;
}

export interface Zip {
  anchor: Vec3;
  timeLeft: number;
}

/** A charge in progress: a straight-line rush that breaks weak walls. */
export interface Charge {
  timeLeft: number;
  dirX: number;
  dirZ: number;
}

export interface PlayerState {
  /** Position of the centre of the feet. */
  pos: Vec3;
  /** Position at the start of the last tick (for render interpolation). */
  prevPos: Vec3;
  vel: Vec3;
  grounded: boolean;
  coyote: number;
  jumpBuffer: number;
  /** Heading the character faces, radians. */
  facing: number;
  energy: number;
  energyDelay: number;
  tether: Tether | null;
  zip: Zip | null;
  swingHeldPrev: boolean;
  charge: Charge | null;
  /** Seconds until the charge can be used again. */
  chargeCooldown: number;
  /** Enemies already struck by the current charge (so one rush hits each enemy once). Not synced. */
  chargeHits: string[];
  health: HealthState;
  /** Seconds until respawn while defeated, otherwise null. */
  defeatedTimer: number | null;
  melee: MeleeState;
  /** Seconds until the snare can be used again. */
  snareCooldown: number;
  /** While > 0 the player takes no damage (spawn protection). */
  invulnerable: number;
}

export function createPlayerState(spawn: Vec3, hero: HeroParams): PlayerState {
  return {
    pos: { ...spawn },
    prevPos: { ...spawn },
    vel: { x: 0, y: 0, z: 0 },
    grounded: false,
    coyote: 0,
    jumpBuffer: 0,
    facing: 0,
    energy: hero.energy.max,
    energyDelay: 0,
    tether: null,
    zip: null,
    swingHeldPrev: false,
    charge: null,
    chargeCooldown: 0,
    chargeHits: [],
    health: createHealth(hero.health),
    defeatedTimer: null,
    melee: createMelee(),
    snareCooldown: 0,
    invulnerable: hero.respawnInvulnerable,
  };
}

/** Longest distance moved in one collision substep; keeps fast movers from tunnelling. */
const MAX_SUBSTEP = 0.4;
const EPS = 1e-6;

export interface MoveResult {
  hitDown: boolean;
  hitUp: boolean;
  hitX: boolean;
  hitZ: boolean;
  /** Colliders that blocked sideways movement this move (each listed once). */
  sideHits: Collider[];
}

/**
 * Moves an upright box (centred on its feet) by `delta`, one axis at a time, pushing it out of
 * colliders it enters. Mutates `pos`.
 */
export function moveAndCollide(
  pos: Vec3,
  delta: Vec3,
  p: BoxSize,
  colliders: readonly Collider[],
): MoveResult {
  const res: MoveResult = { hitDown: false, hitUp: false, hitX: false, hitZ: false, sideHits: [] };
  const largest = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
  const steps = Math.max(1, Math.ceil(largest / MAX_SUBSTEP));
  const sx = delta.x / steps;
  const sy = delta.y / steps;
  const sz = delta.z / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += sx;
    if (sx !== 0 && pushOut('x', sx, pos, p, colliders, res.sideHits)) res.hitX = true;
    pos.z += sz;
    if (sz !== 0 && pushOut('z', sz, pos, p, colliders, res.sideHits)) res.hitZ = true;
    pos.y += sy;
    if (sy !== 0 && pushOut('y', sy, pos, p, colliders, null)) {
      if (sy < 0) res.hitDown = true;
      else res.hitUp = true;
    }
  }
  return res;
}

function overlaps(pos: Vec3, p: BoxSize, c: Collider): boolean {
  return (
    pos.x + p.halfWidth > c.min.x + EPS &&
    pos.x - p.halfWidth < c.max.x - EPS &&
    pos.y + p.height > c.min.y + EPS &&
    pos.y < c.max.y - EPS &&
    pos.z + p.halfWidth > c.min.z + EPS &&
    pos.z - p.halfWidth < c.max.z - EPS
  );
}

/** Resolves overlaps along one axis. Returns true if the box was pushed back. */
function pushOut(
  axis: 'x' | 'y' | 'z',
  d: number,
  pos: Vec3,
  p: BoxSize,
  colliders: readonly Collider[],
  sideHits: Collider[] | null,
): boolean {
  let hit = false;
  for (const c of colliders) {
    if (!overlaps(pos, p, c)) continue;
    hit = true;
    if (axis === 'y') {
      pos.y = d < 0 ? c.max.y : c.min.y - p.height;
    } else {
      pos[axis] = d > 0 ? c.min[axis] - p.halfWidth : c.max[axis] + p.halfWidth;
      if (sideHits && !sideHits.includes(c)) sideHits.push(c);
    }
  }
  return hit;
}

/** Where the character's hands are: the origin for aiming tethers, snares and zips. */
export function handPos(s: PlayerState, hero: HeroParams): Vec3 {
  return { x: s.pos.x, y: s.pos.y + hero.movement.handHeight, z: s.pos.z };
}

function releaseTether(s: PlayerState, swing: NonNullable<HeroParams['swing']>): void {
  s.tether = null;
  const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  if (speed > 6) {
    const k = swing.releaseBoost / speed;
    s.vel.x += s.vel.x * k;
    s.vel.y += s.vel.y * k;
    s.vel.z += s.vel.z * k;
  }
}

/** Largest speed any hero may reach; keeps falling and launches bounded even without a swing ability. */
const DEFAULT_MAX_SPEED = 60;

/**
 * Advance one player by one fixed tick. Deterministic given (state, intent, hero, world, dt).
 * Returns the colliders this player broke this tick (charging through weak walls), so callers can emit events.
 */
export function stepPlayer(
  s: PlayerState,
  intent: PlayerIntent,
  hero: HeroParams,
  world: World,
  dt: number,
): Collider[] {
  const p = hero.movement;
  const swing = hero.swing;
  const zipP = hero.zip;
  const chargeP = hero.charge;
  const broken: Collider[] = [];
  s.prevPos = { ...s.pos };
  const aim = aimDir(intent.yaw, intent.pitch);

  // ---- tether and zip state changes (heroes with a swing kit) ----
  if (swing) {
    if (intent.swingHeld && !s.swingHeldPrev && !s.zip && !s.tether && !s.charge) {
      const hand = handPos(s, hero);
      const anchor = pickSwingAnchor(world, hand, aim, swing.maxRange);
      if (anchor && trySpend(s, swing.attachCost, hero.energy)) {
        const length = Math.hypot(anchor.x - hand.x, anchor.y - hand.y, anchor.z - hand.z);
        const groundY = world.raycast(hand, { x: 0, y: -1, z: 0 }, 300)?.point.y ?? s.pos.y;
        const clearLength = anchor.y - groundY - swing.arcClearance;
        const targetLength = Math.max(swing.minLength, Math.min(length, clearLength));
        s.tether = { anchor, length, targetLength };
      }
    }
    if (!intent.swingHeld && s.tether) releaseTether(s, swing);
    s.swingHeldPrev = intent.swingHeld;
  }

  if (zipP && swing && intent.zipPressed && !s.zip && !s.charge) {
    const hand = handPos(s, hero);
    const anchor = pickZipAnchor(world, hand, aim, p.handHeight, zipP);
    if (anchor && trySpend(s, zipP.cost, hero.energy)) {
      s.tether = null;
      s.zip = { anchor, timeLeft: zipP.maxDuration };
    }
  }

  if (swing && s.tether) {
    const t = s.tether;
    let cost = swing.drainPerSecond;
    if (intent.reelHeld) {
      cost += swing.reelDrainPerSecond;
      t.targetLength = Math.max(swing.minLength, t.targetLength - swing.reelSpeed * dt);
    }
    if (t.length > t.targetLength) {
      const rate = intent.reelHeld ? swing.reelSpeed : swing.autoReelSpeed;
      t.length = Math.max(t.targetLength, t.length - rate * dt);
      // Pull the player along the rope too, so the yank carries momentum instead of just teleporting.
      const hand = handPos(s, hero);
      const dx = t.anchor.x - hand.x;
      const dy = t.anchor.y - hand.y;
      const dz = t.anchor.z - hand.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const inward = (s.vel.x * dx + s.vel.y * dy + s.vel.z * dz) / d;
      if (inward < rate) {
        const k = (rate - inward) * Math.min(1, swing.pullGain * dt);
        s.vel.x += (dx / d) * k;
        s.vel.y += (dy / d) * k;
        s.vel.z += (dz / d) * k;
      }
    }
    if (!drain(s, cost * dt, hero.energy)) releaseTether(s, swing);
  }

  // ---- charge (heroes with a charge kit) ----
  s.chargeCooldown = Math.max(0, s.chargeCooldown - dt);
  if (chargeP && intent.chargePressed && !s.charge && s.chargeCooldown <= 0 && !s.tether && !s.zip) {
    if (trySpend(s, chargeP.cost, hero.energy)) {
      // Rush in the direction the camera faces (horizontal only).
      s.charge = { timeLeft: chargeP.duration, dirX: Math.sin(intent.yaw), dirZ: Math.cos(intent.yaw) };
      s.chargeCooldown = chargeP.cooldown;
      s.chargeHits = [];
    }
  }

  // ---- horizontal control ----
  let mx = Math.max(-1, Math.min(1, intent.moveX));
  let mz = Math.max(-1, Math.min(1, intent.moveZ));
  const mag = Math.hypot(mx, mz);
  if (mag > 1) {
    mx /= mag;
    mz /= mag;
  }
  const sin = Math.sin(intent.yaw);
  const cos = Math.cos(intent.yaw);
  const wishX = mz * sin + mx * cos; // world-space wish direction scaled by stick magnitude (<= 1)
  const wishZ = mz * cos - mx * sin;

  if (s.charge && chargeP) {
    s.vel.x = s.charge.dirX * chargeP.speed;
    s.vel.z = s.charge.dirZ * chargeP.speed;
  } else if (s.zip) {
    // Zip overrides velocity entirely.
  } else if (swing && s.tether) {
    s.vel.x += wishX * swing.airControl * dt;
    s.vel.z += wishZ * swing.airControl * dt;
  } else if (s.grounded) {
    const tx = wishX * p.runSpeed;
    const tz = wishZ * p.runSpeed;
    const dx = tx - s.vel.x;
    const dz = tz - s.vel.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0) {
      const k = Math.min(1, (p.groundAccel * dt) / dist);
      s.vel.x += dx * k;
      s.vel.z += dz * k;
    }
  } else {
    // Air control only adds speed toward the wish direction, so swing momentum is never bled off.
    const wishMag = Math.hypot(wishX, wishZ);
    if (wishMag > 0) {
      const ux = wishX / wishMag;
      const uz = wishZ / wishMag;
      const wishSpeed = wishMag * p.runSpeed;
      const add = wishSpeed - (s.vel.x * ux + s.vel.z * uz);
      if (add > 0) {
        const a = Math.min(add, p.airAccel * dt);
        s.vel.x += ux * a;
        s.vel.z += uz * a;
      }
    }
  }

  // ---- jump ----
  s.coyote = s.grounded ? p.coyoteTime : Math.max(0, s.coyote - dt);
  s.jumpBuffer = intent.jumpPressed ? p.jumpBufferTime : Math.max(0, s.jumpBuffer - dt);
  if (!s.zip && !s.charge && s.jumpBuffer > 0 && s.coyote > 0) {
    s.vel.y = p.jumpSpeed;
    s.jumpBuffer = 0;
    s.coyote = 0;
    s.grounded = false;
  }

  // ---- gravity / zip pull ----
  if (s.zip && zipP) {
    const hand = handPos(s, hero);
    const dx = s.zip.anchor.x - hand.x;
    const dy = s.zip.anchor.y - hand.y;
    const dz = s.zip.anchor.z - hand.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    s.vel.x = (dx / d) * zipP.speed;
    s.vel.y = (dy / d) * zipP.speed;
    s.vel.z = (dz / d) * zipP.speed;
  } else {
    s.vel.y = Math.max(s.vel.y - p.gravity * dt, -p.maxFallSpeed);
  }

  const maxSpeed = swing?.maxSpeed ?? DEFAULT_MAX_SPEED;
  const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  if (!s.zip && !s.charge && speed > maxSpeed) {
    const k = maxSpeed / speed;
    s.vel.x *= k;
    s.vel.y *= k;
    s.vel.z *= k;
  }

  // ---- move ----
  let delta: Vec3 = { x: s.vel.x * dt, y: s.vel.y * dt, z: s.vel.z * dt };
  if (swing && s.tether) delta = ropeLimitedDelta(handPos(s, hero), delta, s.tether.anchor, s.tether.length);
  const r = moveAndCollide(s.pos, delta, p, world.active);
  if (r.hitX) s.vel.x = 0;
  if (r.hitZ) s.vel.z = 0;
  if (r.hitDown) {
    s.vel.y = 0;
    s.grounded = true;
  } else {
    s.grounded = false;
    if (r.hitUp && s.vel.y > 0) s.vel.y = 0;
  }

  // ---- post-move: rope, zip arrival, charge impacts ----
  if (swing && s.tether) {
    const hand = handPos(s, hero);
    removeOutwardVelocity(s.vel, hand, s.tether.anchor, s.tether.length);
    const to = {
      x: s.tether.anchor.x - hand.x,
      y: s.tether.anchor.y - hand.y,
      z: s.tether.anchor.z - hand.z,
    };
    const dist = Math.hypot(to.x, to.y, to.z);
    const blocked = world.raycast(hand, to, dist - swing.ropeClearTolerance);
    if (blocked) releaseTether(s, swing);
  }

  if (s.zip && zipP) {
    s.zip.timeLeft -= dt;
    const hand = handPos(s, hero);
    const dist = Math.hypot(s.zip.anchor.x - hand.x, s.zip.anchor.y - hand.y, s.zip.anchor.z - hand.z);
    if (dist <= zipP.arriveDistance || s.zip.timeLeft <= 0) {
      s.zip = null;
      s.vel.x *= zipP.exitKeep;
      s.vel.y = s.vel.y * zipP.exitKeep + zipP.popSpeed;
      s.vel.z *= zipP.exitKeep;
    }
  }

  if (s.charge && chargeP) {
    let stopped = false;
    for (const c of r.sideHits) {
      if (c.breakable !== undefined && c.breakable <= chargeP.breakPower) {
        if (world.breakCollider(c.id)) broken.push(c);
      } else {
        stopped = true; // a wall that will not break ends the rush
      }
    }
    s.charge.timeLeft -= dt;
    if (stopped || s.charge.timeLeft <= 0) s.charge = null;
  }

  if (!s.tether && !s.zip) regen(s, hero.energy, dt);

  if (Math.hypot(s.vel.x, s.vel.z) > 0.5) s.facing = Math.atan2(s.vel.x, s.vel.z);
  return broken;
}
