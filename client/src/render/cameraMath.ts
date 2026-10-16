import { aimDir } from '../sim/aim';
import type { Vec3 } from '../sim/types';

/** Unit vector from the look target toward where the camera sits, for a given yaw and elevation. */
export function cameraOffsetDir(yaw: number, pitch: number): Vec3 {
  const a = aimDir(yaw, pitch);
  return { x: -a.x, y: -a.y, z: -a.z };
}
