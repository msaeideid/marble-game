import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { PlayerState } from '../sim/controller';

/** Placeholder hero: a capsule with a nose so facing is readable. Interpolates between sim ticks. */
export class PlayerView {
  private readonly body: Mesh;

  constructor(scene: Scene, private readonly height: number, halfWidth: number) {
    const mat = new StandardMaterial('hero', scene);
    mat.diffuseColor = new Color3(0.2, 0.75, 0.9);
    mat.specularColor = Color3.Black();
    this.body = CreateCapsule('hero-body', { height, radius: halfWidth }, scene);
    this.body.material = mat;

    const nose = CreateBox('hero-nose', { width: 0.2, height: 0.2, depth: 0.35 }, scene);
    const noseMat = new StandardMaterial('hero-nose', scene);
    noseMat.diffuseColor = new Color3(1, 0.9, 0.3);
    noseMat.specularColor = Color3.Black();
    nose.material = noseMat;
    nose.parent = this.body;
    nose.position.set(0, this.height * 0.2, halfWidth + 0.1);
  }

  update(state: PlayerState, alpha: number): void {
    const { pos, prevPos } = state;
    this.body.position.set(
      prevPos.x + (pos.x - prevPos.x) * alpha,
      prevPos.y + (pos.y - prevPos.y) * alpha + this.height / 2,
      prevPos.z + (pos.z - prevPos.z) * alpha,
    );
    this.body.rotation.y = state.facing;
  }
}
