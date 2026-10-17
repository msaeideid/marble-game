import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { RocketState } from '../sim/weapons';
import type { Effects } from './effects';

function flat(scene: Scene, name: string, color: Color3, glow = 0.35): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.emissiveColor = color.scale(glow);
  m.specularColor = Color3.Black();
  return m;
}

/** Draws the rockets in flight, smoothed between sim ticks, with a smoke trail. */
export class RocketViews {
  private readonly meshes = new Map<number, Mesh>();
  private readonly body: StandardMaterial;
  private readonly tip: StandardMaterial;
  private readonly tmpDir = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private trailClock = 0;

  constructor(
    private readonly scene: Scene,
    private readonly effects: Effects,
  ) {
    this.body = flat(scene, 'rocket-body', new Color3(0.92, 0.94, 1), 0.5);
    this.tip = flat(scene, 'rocket-tip', new Color3(1, 0.4, 0.2), 0.7);
  }

  update(rockets: readonly RocketState[], alpha: number, dt: number): void {
    const live = new Set<number>();
    this.trailClock += dt;
    const emit = this.trailClock >= 0.025;
    if (emit) this.trailClock = 0;
    for (const r of rockets) {
      live.add(r.id);
      let m = this.meshes.get(r.id);
      if (!m) {
        m = CreateCylinder(
          `rocket-${r.id}`,
          { height: 0.8, diameterTop: 0.1, diameterBottom: 0.2, tessellation: 6 },
          this.scene,
        );
        m.material = this.body;
        m.rotationQuaternion = new Quaternion();
        const nose = CreateCylinder(
          'rocket-nose',
          { height: 0.28, diameterTop: 0, diameterBottom: 0.2, tessellation: 6 },
          this.scene,
        );
        nose.material = this.tip;
        nose.parent = m;
        nose.position.y = 0.54;
        this.meshes.set(r.id, m);
      }
      const x = r.prevPos.x + (r.pos.x - r.prevPos.x) * alpha;
      const y = r.prevPos.y + (r.pos.y - r.prevPos.y) * alpha;
      const z = r.prevPos.z + (r.pos.z - r.prevPos.z) * alpha;
      m.position.set(x, y, z);
      this.tmpDir.set(r.dir.x, r.dir.y, r.dir.z);
      Quaternion.FromUnitVectorsToRef(Vector3.Up(), this.tmpDir, this.tmpQuat);
      m.rotationQuaternion!.copyFrom(this.tmpQuat);
      if (emit) this.effects.puff({ x: x - r.dir.x * 0.5, y: y - r.dir.y * 0.5, z: z - r.dir.z * 0.5 }, 0.3);
    }
    for (const [id, m] of this.meshes) {
      if (!live.has(id)) {
        m.dispose(false, false); // the shared materials stay
        this.meshes.delete(id);
      }
    }
  }
}
