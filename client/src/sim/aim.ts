import type { Vec3 } from './types';

/**
 * Unit view direction for a camera heading (yaw) and elevation (pitch).
 * Positive pitch means the camera sits above the character looking down, so negative pitch looks up.
 */
export function aimDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: -Math.sin(pitch), z: Math.cos(yaw) * cp };
}
