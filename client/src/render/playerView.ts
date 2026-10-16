import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { PlayerState } from '../sim/controller';
import type { Vec3 } from '../sim/types';

function flat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.emissiveColor = color.scale(0.35);
  m.specularColor = Color3.Black();
  return m;
}

/** Placeholder hero: a capsule with a nose so facing is readable, plus the tether line and aim marker. */
export class PlayerView {
  private readonly body: Mesh;
  private readonly rope: Mesh;
  private readonly marker: Mesh;
  private readonly markerOk: StandardMaterial;
  private readonly markerNo: StandardMaterial;
  private readonly tmpDir = new Vector3();
  private readonly tmpQuat = new Quaternion();

  constructor(
    scene: Scene,
    private readonly height: number,
    halfWidth: number,
    private readonly handHeight: number,
  ) {
    this.body = CreateCapsule('hero-body', { height, radius: halfWidth }, scene);
    this.body.material = flat(scene, 'hero', new Color3(0.2, 0.75, 0.9));

    const nose = CreateBox('hero-nose', { width: 0.2, height: 0.2, depth: 0.35 }, scene);
    nose.material = flat(scene, 'hero-nose', new Color3(1, 0.9, 0.3));
    nose.parent = this.body;
    nose.position.set(0, this.height * 0.2, halfWidth + 0.1);

    this.rope = CreateCylinder('rope', { height: 1, diameter: 0.07, tessellation: 6 }, scene);
    this.rope.material = flat(scene, 'rope', new Color3(1, 1, 1));
    this.rope.rotationQuaternion = new Quaternion();
    this.rope.isVisible = false;

    this.markerOk = flat(scene, 'marker-ok', new Color3(0.3, 1, 0.5));
    this.markerNo = flat(scene, 'marker-no', new Color3(1, 0.4, 0.4));
    this.marker = CreateSphere('anchor-marker', { diameter: 0.5, segments: 6 }, scene);
    this.marker.material = this.markerOk;
    this.marker.isVisible = false;
  }

  update(state: PlayerState, alpha: number, aimAnchor: Vec3 | null): void {
    const { pos, prevPos } = state;
    const x = prevPos.x + (pos.x - prevPos.x) * alpha;
    const y = prevPos.y + (pos.y - prevPos.y) * alpha;
    const z = prevPos.z + (pos.z - prevPos.z) * alpha;
    this.body.position.set(x, y + this.height / 2, z);
    this.body.rotation.y = state.facing;

    const attached = state.tether?.anchor ?? state.zip?.anchor ?? null;
    if (attached) {
      this.drawRope(x, y + this.handHeight, z, attached);
      this.rope.isVisible = true;
    } else {
      this.rope.isVisible = false;
    }

    const shown = attached ?? aimAnchor;
    this.marker.isVisible = shown !== null;
    if (shown) {
      this.marker.position.set(shown.x, shown.y, shown.z);
      this.marker.material = attached || aimAnchor ? this.markerOk : this.markerNo;
    }
  }

  private drawRope(hx: number, hy: number, hz: number, anchor: Vec3): void {
    this.tmpDir.set(anchor.x - hx, anchor.y - hy, anchor.z - hz);
    const len = this.tmpDir.length();
    if (len < 1e-4) return;
    this.tmpDir.scaleInPlace(1 / len);
    this.rope.position.set((hx + anchor.x) / 2, (hy + anchor.y) / 2, (hz + anchor.z) / 2);
    this.rope.scaling.y = len;
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), this.tmpDir, this.tmpQuat);
    this.rope.rotationQuaternion!.copyFrom(this.tmpQuat);
  }
}
