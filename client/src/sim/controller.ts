import type { Collider, PlayerIntent, Vec3 } from './types';

export interface MovementParams {
  runSpeed: number;
  groundAccel: number;
  airAccel: number;
  gravity: number;
  jumpSpeed: number;
  maxFallSpeed: number;
  coyoteTime: number;
  jumpBufferTime: number;
  halfWidth: number;
  height: number;
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
}

export function createPlayerState(spawn: Vec3): PlayerState {
  return {
    pos: { ...spawn },
    prevPos: { ...spawn },
    vel: { x: 0, y: 0, z: 0 },
    grounded: false,
    coyote: 0,
    jumpBuffer: 0,
    facing: 0,
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
}

/**
 * Moves an upright box (centred on its feet) by `delta`, one axis at a time, pushing it out of
 * colliders it enters. Mutates `pos`.
 */
export function moveAndCollide(
  pos: Vec3,
  delta: Vec3,
  p: MovementParams,
  colliders: readonly Collider[],
): MoveResult {
  const res: MoveResult = { hitDown: false, hitUp: false, hitX: false, hitZ: false };
  const largest = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
  const steps = Math.max(1, Math.ceil(largest / MAX_SUBSTEP));
  const sx = delta.x / steps;
  const sy = delta.y / steps;
  const sz = delta.z / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += sx;
    if (sx !== 0 && pushOut('x', sx, pos, p, colliders)) res.hitX = true;
    pos.z += sz;
    if (sz !== 0 && pushOut('z', sz, pos, p, colliders)) res.hitZ = true;
    pos.y += sy;
    if (sy !== 0 && pushOut('y', sy, pos, p, colliders)) {
      if (sy < 0) res.hitDown = true;
      else res.hitUp = true;
    }
  }
  return res;
}

function overlaps(pos: Vec3, p: MovementParams, c: Collider): boolean {
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
function pushOut(axis: 'x' | 'y' | 'z', d: number, pos: Vec3, p: MovementParams, colliders: readonly Collider[]): boolean {
  let hit = false;
  for (const c of colliders) {
    if (!overlaps(pos, p, c)) continue;
    hit = true;
    if (axis === 'y') {
      pos.y = d < 0 ? c.max.y : c.min.y - p.height;
    } else {
      pos[axis] = d > 0 ? c.min[axis] - p.halfWidth : c.max[axis] + p.halfWidth;
    }
  }
  return hit;
}

/** Advance one player by one fixed tick. Pure function of (state, intent, params, colliders, dt). */
export function stepPlayer(
  s: PlayerState,
  intent: PlayerIntent,
  p: MovementParams,
  colliders: readonly Collider[],
  dt: number,
): void {
  s.prevPos = { ...s.pos };

  // Camera-relative stick -> world-space wish velocity.
  let mx = Math.max(-1, Math.min(1, intent.moveX));
  let mz = Math.max(-1, Math.min(1, intent.moveZ));
  const mag = Math.hypot(mx, mz);
  if (mag > 1) {
    mx /= mag;
    mz /= mag;
  }
  const sin = Math.sin(intent.yaw);
  const cos = Math.cos(intent.yaw);
  const wishX = (mz * sin + mx * cos) * p.runSpeed;
  const wishZ = (mz * cos - mx * sin) * p.runSpeed;

  const accel = (s.grounded ? p.groundAccel : p.airAccel) * dt;
  const dx = wishX - s.vel.x;
  const dz = wishZ - s.vel.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 0) {
    const k = Math.min(1, accel / dist);
    s.vel.x += dx * k;
    s.vel.z += dz * k;
  }

  // Jump with coyote time and input buffering.
  s.coyote = s.grounded ? p.coyoteTime : Math.max(0, s.coyote - dt);
  s.jumpBuffer = intent.jumpPressed ? p.jumpBufferTime : Math.max(0, s.jumpBuffer - dt);
  if (s.jumpBuffer > 0 && s.coyote > 0) {
    s.vel.y = p.jumpSpeed;
    s.jumpBuffer = 0;
    s.coyote = 0;
    s.grounded = false;
  }

  s.vel.y = Math.max(s.vel.y - p.gravity * dt, -p.maxFallSpeed);

  const r = moveAndCollide(s.pos, { x: s.vel.x * dt, y: s.vel.y * dt, z: s.vel.z * dt }, p, colliders);
  if (r.hitX) s.vel.x = 0;
  if (r.hitZ) s.vel.z = 0;
  if (r.hitDown) {
    s.vel.y = 0;
    s.grounded = true;
  } else {
    s.grounded = false;
    if (r.hitUp && s.vel.y > 0) s.vel.y = 0;
  }

  if (Math.hypot(s.vel.x, s.vel.z) > 0.5) s.facing = Math.atan2(s.vel.x, s.vel.z);
}
