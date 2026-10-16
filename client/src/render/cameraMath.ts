import type { Vec3 } from '../sim/types';

/** Unit vector from the look target toward where the camera sits, for a given yaw and elevation. */
export function cameraOffsetDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
