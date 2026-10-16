import arena from '@shared/levels/arena.json';
import { content, getHero } from '../data';
import { InputController } from '../input/inputController';
import { EnemyView } from '../render/enemyView';
import { FollowCamera } from '../render/followCamera';
import { buildLevelView } from '../render/levelView';
import { PlayerView } from '../render/playerView';
import { createGameView, type GameView } from '../render/scene';
import { aimDir } from '../sim/aim';
import { handPos } from '../sim/controller';
import { FixedStepper } from '../sim/fixedStep';
import { Sim, type SimEvent } from '../sim/sim';
import { pickSwingAnchor } from '../sim/swing';
import type { PlayerIntent } from '../sim/types';
import { World } from '../sim/world';
import { Hud } from '../ui/hud';

const LOCAL_ID = 'local';
const SIM_DT = 1 / 30;

/** Wires sim + input + rendering together for the single-player prototype. */
export class Game {
  readonly view: GameView;
  readonly sim: Sim;
  readonly input: InputController;
  private readonly stepper = new FixedStepper(SIM_DT);
  private readonly playerView: PlayerView;
  private readonly enemyViews = new Map<string, EnemyView>();
  private readonly cam: FollowCamera;
  private readonly hud = new Hud();
  private readonly hero = getHero('hero.swinger');
  private frameCount = 0;
  private bannerTimer = 0;
  private bannerText: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const world = new World(arena);
    this.sim = new Sim(world, this.hero, content.enemies, { waves: true });
    this.sim.addPlayer(LOCAL_ID);

    this.view = createGameView(canvas);
    buildLevelView(this.view.scene, world);
    const m = this.hero.movement;
    this.playerView = new PlayerView(this.view.scene, m.height, m.halfWidth, this.hero.swing.handHeight);
    this.cam = new FollowCamera(this.view.scene);
    this.input = new InputController(canvas);
  }

  start(): void {
    this.view.engine.runRenderLoop(() => this.frame(this.view.engine.getDeltaTime() / 1000));
  }

  /** One display frame: sample input, advance the sim in fixed steps, render. Public so tests can drive it. */
  frame(dt: number): void {
    const { engine, scene } = this.view;
    this.input.pollLook(dt);

    const events: SimEvent[] = [];
    const alpha = this.stepper.advance(dt, (stepDt) => {
      const m = this.input.sample();
      const intent: PlayerIntent = { ...m, yaw: this.input.yaw, pitch: this.input.pitch };
      this.sim.step(stepDt, new Map([[LOCAL_ID, intent]]));
      events.push(...this.sim.events);
    });

    const me = this.sim.players.get(LOCAL_ID)!;
    this.syncEnemies(events, alpha, dt);
    const aimAnchor = this.previewAnchor();
    this.playerView.update(me, alpha, me.tether || me.zip ? null : aimAnchor);
    const p = me.prevPos;
    const focus = {
      x: p.x + (me.pos.x - p.x) * alpha,
      y: p.y + (me.pos.y - p.y) * alpha,
      z: p.z + (me.pos.z - p.z) * alpha,
    };
    this.cam.update(focus, this.input.yaw, this.input.pitch, this.sim.world, dt);
    scene.render();

    this.hud.setEnergy(me.energy, this.hero.energy.max);
    this.hud.setHealth(me.health.shield, this.hero.health.shield.max, me.health.core, this.hero.health.core.max);
    this.hud.setAimValid(aimAnchor !== null);
    this.hud.setSnareReady(me.snareCooldown <= 0 && me.energy >= this.hero.snare.cost);
    for (const ev of events) {
      if (ev.type === 'wave') {
        this.bannerText = `Wave ${ev.wave}`;
        this.bannerTimer = 2;
      }
      if (ev.type === 'damage' && ev.target === LOCAL_ID) this.hud.hurtFlash();
    }
    this.hud.tick(dt);
    this.bannerTimer = Math.max(0, this.bannerTimer - dt);
    this.hud.setBanner(
      me.defeatedTimer !== null
        ? `Down! Back at base in ${Math.ceil(me.defeatedTimer)}…`
        : this.bannerTimer > 0
          ? this.bannerText
          : null,
    );

    if (++this.frameCount % 15 === 0) {
      const speed = Math.hypot(me.vel.x, me.vel.y, me.vel.z).toFixed(1);
      const mode = me.zip ? 'zipping' : me.tether ? 'swinging' : me.grounded ? 'grounded' : 'airborne';
      this.hud.setStatus(`${engine.getFps().toFixed(0)} fps · speed ${speed} m/s · ${mode}`);
    }
  }

  private syncEnemies(events: readonly SimEvent[], alpha: number, dt: number): void {
    const { scene } = this.view;
    for (const e of this.sim.enemies.values()) {
      let v = this.enemyViews.get(e.id);
      if (!v) {
        v = new EnemyView(scene, e.id, content.enemies[e.typeId]!);
        this.enemyViews.set(e.id, v);
      }
    }
    for (const ev of events) {
      if (ev.type === 'damage') this.enemyViews.get(ev.target)?.hit();
    }
    for (const [id, v] of this.enemyViews) {
      const e = this.sim.enemies.get(id);
      if (!e) {
        v.dispose();
        this.enemyViews.delete(id);
      } else {
        v.update(e, alpha, dt);
      }
    }
  }

  /** Where a swing would attach right now, for the aim marker and crosshair colour. */
  private previewAnchor() {
    const me = this.sim.players.get(LOCAL_ID)!;
    return pickSwingAnchor(
      this.sim.world,
      handPos(me, this.hero),
      aimDir(this.input.yaw, this.input.pitch),
      this.hero.swing.maxRange,
    );
  }
}
