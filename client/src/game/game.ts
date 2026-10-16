import swinger from '@shared/data/heroes/swinger.json';
import arena from '@shared/levels/arena.json';
import { InputController } from '../input/inputController';
import { FollowCamera } from '../render/followCamera';
import { buildLevelView } from '../render/levelView';
import { PlayerView } from '../render/playerView';
import { createGameView, type GameView } from '../render/scene';
import type { MovementParams } from '../sim/controller';
import { FixedStepper } from '../sim/fixedStep';
import { Sim } from '../sim/sim';
import type { PlayerIntent } from '../sim/types';
import { World } from '../sim/world';

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
  private frameCount = 0;

  constructor(canvas: HTMLCanvasElement, private readonly hudText: HTMLElement) {
    const movement = swinger.movement as MovementParams;
    const world = new World(arena);
    this.sim = new Sim(world, movement);
    this.sim.addPlayer(LOCAL_ID);

    this.view = createGameView(canvas);
    buildLevelView(this.view.scene, world);
    this.playerView = new PlayerView(this.view.scene, movement.height, movement.halfWidth);
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
      const intent: PlayerIntent = { ...m, yaw: this.input.yaw };
      this.sim.step(stepDt, new Map([[LOCAL_ID, intent]]));
    });

    const me = this.sim.players.get(LOCAL_ID)!;
    this.playerView.update(me, alpha);
    const p = me.prevPos;
    const focus = {
      x: p.x + (me.pos.x - p.x) * alpha,
      y: p.y + (me.pos.y - p.y) * alpha,
      z: p.z + (me.pos.z - p.z) * alpha,
    };
    this.cam.update(focus, this.input.yaw, this.input.pitch, this.sim.world, dt);
    scene.render();

    if (++this.frameCount % 15 === 0) {
      const speed = Math.hypot(me.vel.x, me.vel.z).toFixed(1);
      this.hudText.textContent =
        `VANGUARD prototype · ${engine.getFps().toFixed(0)} fps · speed ${speed} m/s · ` +
        `${me.grounded ? 'grounded' : 'airborne'} · WASD move, Space jump, drag or click to look`;
    }
  }
}
