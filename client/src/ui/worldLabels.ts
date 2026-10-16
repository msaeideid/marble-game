import type { Engine } from '@babylonjs/core/Engines/engine';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '../sim/types';

interface FloatingNumber {
  el: HTMLElement;
  pos: Vec3;
  age: number;
}

/** HTML elements pinned to world positions: enemy health bars and floating damage numbers. */
export class WorldLabels {
  private readonly bars = new Map<string, { el: HTMLElement; fill: HTMLElement }>();
  private numbers: FloatingNumber[] = [];
  private readonly tmp = new Vector3();

  constructor(
    private readonly root: HTMLElement,
    private readonly scene: Scene,
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  /** CSS-pixel screen position of a world point, or null if it is behind the camera. */
  project(pos: Vec3): { x: number; y: number } | null {
    const cam = this.scene.activeCamera;
    if (!cam) return null;
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    Vector3.ProjectToRef(
      this.tmp.set(pos.x, pos.y, pos.z),
      Matrix.IdentityReadOnly,
      this.scene.getTransformMatrix(),
      cam.viewport.toGlobal(w, h),
      this.tmp,
    );
    if (this.tmp.z < 0 || this.tmp.z > 1) return null;
    const k = this.canvas.clientWidth / w;
    return { x: this.tmp.x * k, y: this.tmp.y * k };
  }

  setBar(id: string, above: Vec3, fraction: number, held: boolean): void {
    let bar = this.bars.get(id);
    if (!bar) {
      const el = document.createElement('div');
      el.className = 'enemy-bar';
      const fill = document.createElement('div');
      el.appendChild(fill);
      this.root.appendChild(el);
      bar = { el, fill };
      this.bars.set(id, bar);
    }
    const p = this.project(above);
    if (!p) {
      bar.el.style.display = 'none';
      return;
    }
    bar.el.style.display = 'block';
    bar.el.style.transform = `translate(${p.x - 20}px, ${p.y}px)`;
    bar.fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    bar.el.classList.toggle('held', held);
  }

  hideBar(id: string): void {
    const bar = this.bars.get(id);
    if (bar) bar.el.style.display = 'none';
  }

  removeBar(id: string): void {
    const bar = this.bars.get(id);
    if (bar) {
      bar.el.remove();
      this.bars.delete(id);
    }
  }

  barIds(): string[] {
    return [...this.bars.keys()];
  }

  damageNumber(pos: Vec3, text: string, big = false): void {
    const el = document.createElement('div');
    el.className = big ? 'dmg-number big' : 'dmg-number';
    el.textContent = text;
    this.root.appendChild(el);
    this.numbers.push({ el, pos: { x: pos.x + (Math.random() - 0.5) * 0.6, y: pos.y, z: pos.z }, age: 0 });
  }

  update(dt: number): void {
    for (const n of this.numbers) {
      n.age += dt;
      const p = this.project({ x: n.pos.x, y: n.pos.y + n.age * 1.6, z: n.pos.z });
      if (!p) {
        n.el.style.display = 'none';
        continue;
      }
      n.el.style.display = 'block';
      n.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      n.el.style.opacity = String(Math.max(0, 1 - n.age / 0.8));
    }
    this.numbers = this.numbers.filter((n) => {
      if (n.age < 0.8) return true;
      n.el.remove();
      return false;
    });
  }
}
