import { Engine } from '@babylonjs/core/Engines/engine';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

export interface GameView {
  engine: Engine;
  scene: Scene;
}

/** Engine, scene, sky and lights. Everything bright and flat for the low-poly look. */
export function createGameView(canvas: HTMLCanvasElement): GameView {
  const engine = new Engine(canvas, true, { stencil: false });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.55, 0.78, 0.95, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = new Color3(0.55, 0.78, 0.95);
  scene.fogStart = 120;
  scene.fogEnd = 320;

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.85;
  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.4), scene);
  sun.intensity = 0.6;

  window.addEventListener('resize', () => engine.resize());
  return { engine, scene };
}
