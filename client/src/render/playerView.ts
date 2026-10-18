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
  /** Jet flames (METALHEAD), shown while flying. */
  private readonly flames: Mesh[] = [];

  constructor(
    scene: Scene,
    private readonly height: number,
    halfWidth: number,
    private readonly handHeight: number,
    color?: Color3,
    private readonly style = 'default',
  ) {
    const flyer = style === 'hero.flyer';
    const storm = style === 'hero.storm';
    color ??= flyer ? new Color3(0.62, 0.7, 0.82) : storm ? new Color3(0.5, 0.35, 0.85) : new Color3(0.2, 0.75, 0.9);
    this.body = CreateCapsule('hero-body', { height, radius: halfWidth }, scene);
    this.body.material = flat(scene, 'hero', color);

    const nose = CreateBox('hero-nose', { width: 0.2, height: 0.2, depth: 0.35 }, scene);
    nose.material = flat(scene, 'hero-nose', new Color3(1, 0.9, 0.3));
    nose.parent = this.body;
    nose.position.set(0, this.height * 0.2, halfWidth + 0.1);

    if (storm) {
      // Conductor gauntlets: glowing yellow fists, a bright chest bolt, and a hover glow while gliding.
      const glowMat = flat(scene, 'hero-gauntlet', new Color3(1, 0.9, 0.3));
      glowMat.emissiveColor = new Color3(1, 0.9, 0.3);
      for (const dx of [-1, 1]) {
        const fist = CreateSphere('hero-gauntlet', { diameter: 0.42, segments: 6 }, scene);
        fist.material = glowMat;
        fist.parent = this.body;
        fist.position.set(dx * (halfWidth + 0.18), this.height * 0.02, 0.12);
      }
      const bolt = CreateBox('hero-emblem', { width: 0.22, height: 0.4, depth: 0.06 }, scene);
      bolt.material = glowMat;
      bolt.parent = this.body;
      bolt.position.set(0, this.height * 0.08, halfWidth + 0.02);
      const halo = CreateCylinder('hero-halo', { height: 0.05, diameter: 1.5, tessellation: 20 }, scene);
      const haloMat = flat(scene, 'hero-halo', new Color3(0.9, 0.95, 0.4));
      haloMat.emissiveColor = new Color3(0.9, 0.95, 0.4);
      haloMat.alpha = 0.5;
      halo.material = haloMat;
      halo.parent = this.body;
      halo.position.set(0, -this.height / 2 + 0.02, 0);
      halo.isVisible = false;
      this.flames.push(halo);
    }
    if (flyer) {
      const visor = CreateBox('hero-visor', { width: 0.52, height: 0.14, depth: 0.12 }, scene);
      visor.material = flat(scene, 'hero-visor', new Color3(0.08, 0.12, 0.25));
      visor.parent = this.body;
      visor.position.set(0, this.height * 0.28, halfWidth - 0.02);
      const pack = CreateBox('hero-pack', { width: 0.55, height: 0.7, depth: 0.28 }, scene);
      pack.material = flat(scene, 'hero-pack', new Color3(0.35, 0.38, 0.46));
      pack.parent = this.body;
      pack.position.set(0, this.height * 0.08, -halfWidth - 0.12);
      const flameMat = flat(scene, 'hero-flame', new Color3(1, 0.55, 0.15));
      flameMat.emissiveColor = new Color3(1, 0.6, 0.2);
      for (const dx of [-0.16, 0.16]) {
        const flame = CreateCylinder('hero-flame', { height: 0.7, diameterTop: 0.22, diameterBottom: 0, tessellation: 6 }, scene);
        flame.material = flameMat;
        flame.parent = this.body;
        flame.position.set(dx, this.height * 0.08 - 0.7, -halfWidth - 0.12);
        flame.isVisible = false;
        this.flames.push(flame);
      }
    }

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

  update(state: PlayerState, alpha: number, aimAnchor: Vec3 | null, clock = 0, offset?: Vec3): void {
    const { pos, prevPos } = state;
    const x = prevPos.x + (pos.x - prevPos.x) * alpha + (offset?.x ?? 0);
    const y = prevPos.y + (pos.y - prevPos.y) * alpha + (offset?.y ?? 0);
    const z = prevPos.z + (pos.z - prevPos.z) * alpha + (offset?.z ?? 0);
    this.body.position.set(x, y + this.height / 2, z);
    this.body.rotation.y = state.facing;
    if (this.flames.length > 0) {
      // Lean into the flight direction and flicker the jets.
      const lean = state.flying ? Math.min(1, Math.hypot(state.vel.x, state.vel.z) / 11) * 0.45 : 0;
      this.body.rotation.x += (lean - this.body.rotation.x) * 0.25;
      for (const [i, f] of this.flames.entries()) {
        f.isVisible = state.flying;
        if (this.style === 'hero.storm') f.scaling.setAll(0.9 + 0.15 * Math.sin(clock * 14));
        else f.scaling.y = 0.8 + 0.4 * Math.abs(Math.sin(clock * 38 + i * 1.7));
      }
    }
    // Blink while spawn-protected; hide while down.
    this.body.setEnabled(state.defeatedTimer === null && (state.invulnerable <= 0 || Math.floor(clock * 12) % 2 === 0));

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

  dispose(): void {
    this.body.dispose();
    this.rope.dispose();
    this.marker.dispose();
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
