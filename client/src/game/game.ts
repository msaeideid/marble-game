import swingerData from '@shared/data/heroes/swinger.json';
import arena from '@shared/levels/arena.json';
import { InputController } from '../input/inputController';
import { FollowCamera } from '../render/followCamera';
import { buildLevelView } from '../render/levelView';
import { PlayerView } from '../render/playerView';
import { createGameView, type GameView } from '../render/scene';
import { aimDir } from '../sim/aim';
import { handPos } from '../sim/controller';
import { FixedStepper } from '../sim/fixedStep';
import type { HeroParams } from '../sim/params';
import { Sim } from '../sim/sim';
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
  private readonly cam: FollowCamera;
  private readonly hud = new Hud();
  private readonly hero = swingerData as HeroParams;
  private frameCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    const world = new World(arena);
    this.sim = new Sim(world, this.hero);
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

    const alpha = this.stepper.advance(dt, (stepDt) => {
      const m = this.input.sample();
      const intent: PlayerIntent = { ...m, yaw: this.input.yaw, pitch: this.input.pitch };
      this.sim.step(stepDt, new Map([[LOCAL_ID, intent]]));
    });

    const me = this.sim.players.get(LOCAL_ID)!;
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
    this.hud.setAimValid(aimAnchor !== null);

    if (++this.frameCount % 15 === 0) {
      const speed = Math.hypot(me.vel.x, me.vel.y, me.vel.z).toFixed(1);
      const mode = me.zip ? 'zipping' : me.tether ? 'swinging' : me.grounded ? 'grounded' : 'airborne';
      this.hud.setStatus(`${engine.getFps().toFixed(0)} fps · speed ${speed} m/s · ${mode}`);
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
