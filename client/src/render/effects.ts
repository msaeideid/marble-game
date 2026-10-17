import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh';
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

interface Beam {
  mesh: Mesh;
  age: number;
  life: number;
}

interface Blast {
  mesh: Mesh;
  mat: StandardMaterial;
  age: number;
  radius: number;
}

interface Puff {
  mesh: InstancedMesh;
  age: number;
  life: number;
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
  private beams: Beam[] = [];
  private blasts: Blast[] = [];
  private puffs: Puff[] = [];
  private beamMat: StandardMaterial | null = null;
  private puffSource: Mesh | null = null;
  private sparkSource: Mesh | null = null;
  private readonly tmpDir = new Vector3();
  private readonly tmpQuat = new Quaternion();

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

  /** A short bright line from `from` to `to`: one laser bolt. It thins out and vanishes in a tenth of a second. */
  laser(from: Vec3, to: Vec3): void {
    this.tmpDir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = this.tmpDir.length();
    if (len < 1e-3) return;
    this.tmpDir.scaleInPlace(1 / len);
    if (!this.beamMat) {
      this.beamMat = new StandardMaterial('beam', this.scene);
      this.beamMat.disableLighting = true;
      this.beamMat.emissiveColor = new Color3(0.45, 1, 1);
    }
    const mesh = CreateCylinder('beam', { height: 1, diameter: 0.2, tessellation: 6 }, this.scene);
    mesh.material = this.beamMat;
    mesh.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), this.tmpDir, this.tmpQuat).clone();
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    mesh.scaling.y = len;
    this.beams.push({ mesh, age: 0, life: 0.1 });
  }

  /** A fireball that swells to `radius` and fades, with a spray of sparks. */
  explosion(pos: Vec3, radius: number): void {
    const mat = new StandardMaterial('blast', this.scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(1, 0.62, 0.2);
    mat.alpha = 0.85;
    const mesh = CreateSphere('blast', { diameter: 2, segments: 8 }, this.scene);
    mesh.material = mat;
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.scaling.setAll(0.2);
    this.blasts.push({ mesh, mat, age: 0, radius });
    this.debris(
      { x: pos.x - 0.3, y: pos.y - 0.3, z: pos.z - 0.3 },
      { x: pos.x + 0.3, y: pos.y + 0.3, z: pos.z + 0.3 },
      new Color3(1, 0.7, 0.25),
    );
  }

  /** A quick bright flash where a bolt lands. */
  spark(pos: Vec3): void {
    if (!this.sparkSource) {
      const mat = new StandardMaterial('spark', this.scene);
      mat.disableLighting = true;
      mat.emissiveColor = new Color3(0.6, 1, 1);
      this.sparkSource = CreateSphere('spark-source', { diameter: 0.9, segments: 4 }, this.scene);
      this.sparkSource.material = mat;
      this.sparkSource.isVisible = false;
    }
    const mesh = this.sparkSource.createInstance('spark');
    mesh.position.set(pos.x, pos.y, pos.z);
    this.puffs.push({ mesh, age: 0, life: 0.14 });
  }

  /** A small smoke puff (used for rocket trails and jet exhaust). */
  puff(pos: Vec3, life = 0.35): void {
    if (!this.puffSource) {
      const mat = new StandardMaterial('puff', this.scene);
      mat.disableLighting = true;
      mat.emissiveColor = new Color3(1, 0.8, 0.5);
      this.puffSource = CreateSphere('puff-source', { diameter: 0.34, segments: 4 }, this.scene);
      this.puffSource.material = mat;
      this.puffSource.isVisible = false;
    }
    const mesh = this.puffSource.createInstance('puff');
    mesh.position.set(pos.x, pos.y, pos.z);
    this.puffs.push({ mesh, age: 0, life });
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
    for (const b of this.beams) {
      b.age += dt;
      const t = Math.min(1, b.age / b.life);
      b.mesh.scaling.x = b.mesh.scaling.z = 1 - t;
    }
    this.beams = this.beams.filter((b) => {
      if (b.age < b.life) return true;
      b.mesh.dispose();
      return false;
    });

    for (const b of this.blasts) {
      b.age += dt;
      const t = Math.min(1, b.age / 0.35);
      b.mesh.scaling.setAll(Math.max(0.05, b.radius * (1 - (1 - t) * (1 - t)) * 0.9));
      b.mat.alpha = 0.85 * (1 - t);
    }
    this.blasts = this.blasts.filter((b) => {
      if (b.age < 0.35) return true;
      b.mesh.dispose();
      b.mat.dispose();
      return false;
    });

    for (const q of this.puffs) {
      q.age += dt;
      q.mesh.scaling.setAll(Math.max(0.02, 1 - q.age / q.life));
    }
    this.puffs = this.puffs.filter((q) => {
      if (q.age < q.life) return true;
      q.mesh.dispose();
      return false;
    });

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
