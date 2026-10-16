import { createGameView } from './render/scene';
import { FixedStepper } from './sim/fixedStep';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const view = createGameView(canvas);
const stepper = new FixedStepper(1 / 30);

let simTicks = 0;
view.engine.runRenderLoop(() => {
  stepper.advance(view.engine.getDeltaTime() / 1000, () => {
    simTicks++;
  });
  view.scene.render();
});

(window as unknown as { __vanguard: object }).__vanguard = { view, ticks: () => simTicks };
