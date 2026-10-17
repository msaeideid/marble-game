import { Color3 } from '@babylonjs/core/Maths/math.color';
import '@babylonjs/core/Meshes/instancedMesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ColliderKind } from '../sim/types';
import type { World } from '../sim/world';

const PALETTE: Record<ColliderKind, Color3[]> = {
  ground: [new Color3(0.5, 0.78, 0.5)],
  building: [
    new Color3(0.93, 0.45, 0.45),
    new Color3(0.4, 0.62, 0.95),
    new Color3(0.98, 0.78, 0.35),
    new Color3(0.62, 0.5, 0.9),
  ],
  crate: [new Color3(1, 0.65, 0.25)],
  // Breakable walls: tier 1 is warm brick, tier 2 is dark reinforced concrete.
  wall: [new Color3(0.85, 0.45, 0.3), new Color3(0.38, 0.4, 0.46)],
};

function flatMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = Color3.Black();
  return m;
}

/** Draws the sim's collider boxes as flat-shaded instances (S1 greybox; real art replaces this later). */
export interface LevelView {
  /** Show or hide each collider's mesh so it matches `world.broken`. Cheap to call every frame. */
  sync(world: World): void;
}

export function buildLevelView(scene: Scene, world: World): LevelView {
  const instances: ReturnType<Mesh['createInstance']>[] = [];
  let shownVersion = -1;
  const sources = new Map<string, Mesh>();
  const sourceFor = (kind: ColliderKind, variant: number): Mesh => {
    const key = `${kind}:${variant}`;
    let mesh = sources.get(key);
    if (!mesh) {
      mesh = CreateBox(`src-${key}`, { size: 1 }, scene);
      mesh.material = flatMaterial(scene, `mat-${key}`, PALETTE[kind][variant]!);
      mesh.isVisible = false;
      sources.set(key, mesh);
    }
    return mesh;
  };

  world.colliders.forEach((c, i) => {
    const variant = c.kind === 'wall' ? Math.min((c.breakable ?? 1) - 1, 1) : i % PALETTE[c.kind].length;
    const inst = sourceFor(c.kind, variant).createInstance(`c${i}`);
    inst.scaling.set(c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z);
    inst.position.set((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
    inst.freezeWorldMatrix();
    instances[c.id] = inst;
  });

  return {
    sync(w: World): void {
      if (w.brokenVersion === shownVersion) return;
      shownVersion = w.brokenVersion;
      for (const c of w.colliders) instances[c.id]?.setEnabled(!w.broken.has(c.id));
    },
  };
}

/** The base pad: a glowing disc (visual only; the sim's `World.base` does the healing). */
export function buildBaseView(scene: Scene, world: World): void {
  const base = world.base;
  if (!base) return;
  const mat = new StandardMaterial('base-pad', scene);
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(0.3, 0.95, 0.9);
  mat.alpha = 0.55;
  const pad = CreateCylinder('base-pad', { height: 0.04, diameter: base.radius * 2, tessellation: 40 }, scene);
  pad.material = mat;
  pad.position.set(base.pos.x, base.pos.y + 0.03, base.pos.z);

  const ringMat = new StandardMaterial('base-ring', scene);
  ringMat.disableLighting = true;
  ringMat.emissiveColor = new Color3(1, 1, 1);
  const ring = CreateCylinder('base-ring', { height: 0.05, diameter: base.radius * 2 + 0.5, tessellation: 40 }, scene);
  ring.material = ringMat;
  ring.position.set(base.pos.x, base.pos.y + 0.02, base.pos.z);
}
