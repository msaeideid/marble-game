import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { EnemyState } from '../sim/enemy';
import type { EnemyParams } from '../sim/params';

const BASE = new Color3(0.9, 0.35, 0.35);
const FLASH = new Color3(1, 1, 1);
const WINDUP = new Color3(1, 0.65, 0.15);
const SNARED = new Color3(0.4, 0.85, 1);
const DOWN = new Color3(0.6, 0.6, 0.7);

/** Placeholder enemy: a red capsule that flashes white when hit and shrinks away when powered down. */
export class EnemyView {
  private readonly mesh: Mesh;
  private readonly mat: StandardMaterial;
  private readonly base: Color3;
  private flash = 0;
  private clock = 0;

  constructor(scene: Scene, readonly id: string, private readonly def: EnemyParams) {
    this.mat = new StandardMaterial(`enemy-${id}`, scene);
    this.mat.specularColor = Color3.Black();
    this.base = def.look ? new Color3(def.look.color[0]!, def.look.color[1]!, def.look.color[2]!) : BASE;
    this.mat.diffuseColor = this.base;
    this.mat.emissiveColor = this.base.scale(0.35);
    this.mesh = CreateCapsule(`enemy-${id}`, { height: def.move.height, radius: def.move.halfWidth }, scene);
    this.mesh.material = this.mat;
  }

  hit(): void {
    this.flash = 0.12;
  }

  update(e: EnemyState, alpha: number, dt: number): void {
    const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
    const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
    const z = e.prevPos.z + (e.pos.z - e.prevPos.z) * alpha;
    this.clock += dt;
    // Windup pulses and grows so the attack is clearly telegraphed.
    const telegraph = e.aiState === 'windup' ? 1.08 + 0.1 * Math.sin(this.clock * 40) : 1;
    const scale =
      e.defeatedTimer === null ? telegraph : Math.max(0.01, e.defeatedTimer / this.def.powerDownTime);
    this.mesh.scaling.setAll(scale);
    this.mesh.position.set(x, y + (this.def.move.height / 2) * scale, z);
    this.mesh.rotation.y = e.facing;

    this.flash = Math.max(0, this.flash - dt);
    let c = this.base;
    if (e.defeatedTimer !== null) c = DOWN;
    else if (this.flash > 0) c = FLASH;
    else if (e.snaredTimer > 0) c = SNARED;
    else if (e.aiState === 'windup') c = WINDUP;
    this.mat.diffuseColor = c;
    this.mat.emissiveColor = c.scale(0.35);
  }

  dispose(): void {
    this.mesh.dispose();
    this.mat.dispose();
  }
}
