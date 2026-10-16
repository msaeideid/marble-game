import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '../sim/types';

const ARC = 0.34;

interface Slash {
  mesh: Mesh;
  mat: StandardMaterial;
  age: number;
  life: number;
  startScale: number;
}

/** Short-lived visual effects. Pure eye candy; nothing here affects the sim. */
export class Effects {
  private slashes: Slash[] = [];

  constructor(private readonly scene: Scene) {}

  /** A flat arc in front of the player showing where a strike swept. `step` 0..2 grows and warms the colour. */
  slash(pos: Vec3, yaw: number, step: number, range: number): void {
    const radius = range * (0.9 + step * 0.1);
    const mesh = CreateDisc(
      'slash',
      { radius, arc: ARC, tessellation: 28, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    );
    const mat = new StandardMaterial('slash-mat', this.scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.emissiveColor = step >= 2 ? new Color3(1, 0.7, 0.2) : new Color3(1, 1, 1);
    mat.alpha = 0.7;
    mesh.material = mat;
    mesh.rotation.x = Math.PI / 2;
    // After laying the disc flat its arc spans from +X toward +Z, centred `arc * PI` radians from +X.
    // Babylon's Y rotation of r moves a heading from angle c to c - r, so r = c - (PI/2 - yaw) centres it on `yaw`.
    mesh.rotation.y = yaw + ARC * Math.PI - Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 1.0, pos.z);
    this.slashes.push({ mesh, mat, age: 0, life: step >= 2 ? 0.22 : 0.15, startScale: 0.7 });
  }

  update(dt: number): void {
    for (const s of this.slashes) {
      s.age += dt;
      const t = Math.min(1, s.age / s.life);
      const scale = s.startScale + (1 - s.startScale) * t;
      s.mesh.scaling.set(scale, scale, scale);
      s.mat.alpha = 0.7 * (1 - t);
    }
    this.slashes = this.slashes.filter((s) => {
      if (s.age < s.life) return true;
      s.mesh.dispose();
      s.mat.dispose();
      return false;
    });
  }
}
