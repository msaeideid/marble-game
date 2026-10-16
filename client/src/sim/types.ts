/**
 * Sim conventions (identical to Babylon's): +Y is up, +Z is forward at yaw 0, +X is right.
 * Forward for a yaw is (sin yaw, 0, cos yaw); right is (cos yaw, 0, -sin yaw).
 * Units are metres and seconds.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export type ColliderKind = 'ground' | 'building' | 'crate';

export interface Collider extends Aabb {
  kind: ColliderKind;
}

/** What a controller (human, AI or network client) asks the character to do this tick. */
export interface PlayerIntent {
  /** Stick/strafe input in [-1,1]; +x is right. */
  moveX: number;
  /** Stick/forward input in [-1,1]; +z is forward. */
  moveZ: number;
  /** Camera heading the stick is relative to, in radians. */
  yaw: number;
  /** Camera elevation in radians (positive = camera above, looking down). Aim comes from yaw + pitch. */
  pitch: number;
  /** True only on the tick the jump button went down. */
  jumpPressed: boolean;
  /** Swing button is held (a quick tap between ticks still counts for one tick). */
  swingHeld: boolean;
  /** Reel-in button is held. */
  reelHeld: boolean;
  /** True only on the tick the zip button went down. */
  zipPressed: boolean;
  /** True only on the tick the attack button went down. */
  attackPressed: boolean;
}

export const NEUTRAL_INTENT: PlayerIntent = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jumpPressed: false,
  swingHeld: false,
  reelHeld: false,
  zipPressed: false,
  attackPressed: false,
};

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
