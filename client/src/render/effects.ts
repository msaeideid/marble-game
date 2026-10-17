import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
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

interface Chunk {
  mesh: Mesh;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  age: number;
}

/** Short-lived visual effects. Pure eye candy; nothing here affects the sim. */
export class Effects {
  private slashes: Slash[] = [];
  private chunks: Chunk[] = [];
  private debrisMat: StandardMaterial | null = null;

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

  /** A burst of tumbling chunks where a wall was smashed. */
  debris(min: Vec3, max: Vec3, color: Color3): void {
    if (!this.debrisMat) {
      this.debrisMat = new StandardMaterial('debris', this.scene);
      this.debrisMat.specularColor = Color3.Black();
    }
    this.debrisMat.diffuseColor = color;
    this.debrisMat.emissiveColor = color.scale(0.3);
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    for (let i = 0; i < 14; i++) {
      const mesh = CreateBox('chunk', { size: 0.3 + Math.random() * 0.4 }, this.scene);
      mesh.material = this.debrisMat;
      mesh.position.set(
        min.x + Math.random() * (max.x - min.x),
        min.y + Math.random() * (max.y - min.y),
        min.z + Math.random() * (max.z - min.z),
      );
      const away = Math.atan2(mesh.position.x - cx, mesh.position.z - cz) + (Math.random() - 0.5);
      const speed = 3 + Math.random() * 5;
      this.chunks.push({
        mesh,
        vx: Math.sin(away) * speed,
        vy: 3 + Math.random() * 5,
        vz: Math.cos(away) * speed,
        spin: (Math.random() - 0.5) * 10,
        age: 0,
      });
    }
  }

  update(dt: number): void {
    for (const c of this.chunks) {
      c.age += dt;
      c.vy -= 22 * dt;
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y = Math.max(0.15, c.mesh.position.y + c.vy * dt);
      c.mesh.position.z += c.vz * dt;
      c.mesh.rotation.x += c.spin * dt;
      c.mesh.rotation.z += c.spin * dt * 0.7;
      c.mesh.scaling.setAll(Math.max(0.01, 1 - Math.max(0, c.age - 0.5) / 0.5));
    }
    this.chunks = this.chunks.filter((c) => {
      if (c.age < 1.0) return true;
      c.mesh.dispose();
      return false;
    });

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
