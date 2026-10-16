import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '../sim/types';
import type { World } from '../sim/world';
import { cameraOffsetDir } from './cameraMath';

const DISTANCE = 7;
const HEIGHT_OFFSET = 1.5; // look at roughly head height
const WALL_MARGIN = 0.3;
const FOLLOW_RATE = 14; // 1/s, exponential smoothing of the look target

/** Third-person orbit camera that stays in front of walls. Angles come from the input controller. */
export class FollowCamera {
  readonly camera: FreeCamera;
  private target: Vec3 | null = null;

  constructor(scene: Scene) {
    this.camera = new FreeCamera('follow', new Vector3(0, 5, -8), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;
    this.camera.fov = 1.0;
    scene.activeCamera = this.camera;
  }

  update(focus: Vec3, yaw: number, pitch: number, world: World, dtSeconds: number): void {
    const want = { x: focus.x, y: focus.y + HEIGHT_OFFSET, z: focus.z };
    if (!this.target) this.target = want;
    const k = 1 - Math.exp(-FOLLOW_RATE * dtSeconds);
    this.target.x += (want.x - this.target.x) * k;
    this.target.y += (want.y - this.target.y) * k;
    this.target.z += (want.z - this.target.z) * k;

    const dir = cameraOffsetDir(yaw, pitch);
    const hit = world.raycast(this.target, dir, DISTANCE + WALL_MARGIN);
    const dist = hit ? Math.max(0.8, hit.distance - WALL_MARGIN) : DISTANCE;

    this.camera.position.set(this.target.x + dir.x * dist, this.target.y + dir.y * dist, this.target.z + dir.z * dist);
    this.camera.setTarget(new Vector3(this.target.x, this.target.y, this.target.z));
  }
}
