import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { PropParams } from '../sim/params';
import type { PropMode, PropWire } from '../sim/props';
import type { Vec3 } from '../sim/types';

function flat(scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial('prop', scene);
  m.diffuseColor = color;
  m.emissiveColor = color.scale(0.3);
  m.specularColor = Color3.Black();
  return m;
}

/** One prop's meshes: a recognisable low-poly car, crate or dumpster built from boxes. */
class PropMesh {
  readonly root: TransformNode;
  /** Smoothed position, so 15-30 Hz updates look fluid at 60 fps. */
  readonly shown: Vec3 = { x: 0, y: 0, z: 0 };
  mode: PropMode = 'resting';
  initialised = false;

  constructor(scene: Scene, readonly def: PropParams) {
    this.root = new TransformNode(`prop-${def.id}`, scene);
    const color = new Color3(def.color[0]!, def.color[1]!, def.color[2]!);
    const dark = color.scale(0.6);
    const { halfWidth: hw, height } = def.size;
    const part = (w: number, h: number, d: number, y: number, c: Color3, z = 0) => {
      const b = CreateBox('part', { width: w, height: h, depth: d }, scene);
      b.material = flat(scene, c);
      b.parent = this.root;
      b.position.set(0, y + h / 2, z);
      return b;
    };
    if (def.look === 'car') {
      part(hw * 2, height * 0.5, hw * 2, height * 0.12, color); // body
      part(hw * 1.5, height * 0.38, hw * 1.1, height * 0.62, color.scale(0.85), -hw * 0.1); // cabin
      part(hw * 2.05, height * 0.14, hw * 2.05, 0, new Color3(0.15, 0.15, 0.18)); // wheels/chassis
    } else if (def.look === 'dumpster') {
      part(hw * 2, height * 0.85, hw * 1.4, 0, color);
      part(hw * 2.1, height * 0.15, hw * 1.5, height * 0.85, dark); // lid
    } else {
      part(hw * 2, height, hw * 2, 0, color);
      part(hw * 2.05, height * 0.12, hw * 2.05, height * 0.44, dark); // band
    }
  }

  dispose(): void {
    this.root.dispose();
  }
}

export interface PropTransition {
  prev: PropMode;
  cur: PropMode;
  wire: PropWire;
  def: PropParams;
}

/** Draws the level's props from their synced state and reports mode changes (for sound and debris). */
export class PropViews {
  private readonly meshes = new Map<number, PropMesh>();

  constructor(
    private readonly scene: Scene,
    private readonly defs: Record<string, PropParams>,
  ) {}

  /**
   * @param wires every prop's state
   * @param holderTop where a held prop should sit (on its carrier's head, using the carrier's smoothed position)
   */
  update(
    wires: readonly PropWire[],
    dt: number,
    holderTop: (playerId: string) => Vec3 | null,
  ): PropTransition[] {
    const transitions: PropTransition[] = [];
    for (const w of wires) {
      const def = this.defs[w.def];
      if (!def) continue;
      let m = this.meshes.get(w.id);
      if (!m) {
        m = new PropMesh(this.scene, def);
        this.meshes.set(w.id, m);
      }
      if (m.initialised && m.mode !== w.mode) transitions.push({ prev: m.mode, cur: w.mode, wire: w, def });
      m.mode = w.mode;

      let target: Vec3 = { x: w.pos[0], y: w.pos[1], z: w.pos[2] };
      if (w.mode === 'held' && w.holder) target = holderTop(w.holder) ?? target;
      if (!m.initialised || w.mode === 'held' || w.mode === 'destroyed') {
        m.shown.x = target.x;
        m.shown.y = target.y;
        m.shown.z = target.z;
        m.initialised = true;
      } else {
        const k = 1 - Math.exp(-35 * dt);
        m.shown.x += (target.x - m.shown.x) * k;
        m.shown.y += (target.y - m.shown.y) * k;
        m.shown.z += (target.z - m.shown.z) * k;
      }
      m.root.setEnabled(w.mode !== 'destroyed');
      m.root.position.set(m.shown.x, m.shown.y, m.shown.z);
      // Tumble while flying; sit square otherwise.
      if (w.mode === 'thrown') m.root.rotation.x += dt * 6;
      else {
        m.root.rotation.x *= Math.exp(-12 * dt);
      }
    }
    return transitions;
  }
}
