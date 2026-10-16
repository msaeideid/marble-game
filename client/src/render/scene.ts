import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

export interface GameView {
  engine: Engine;
  scene: Scene;
}

function flat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = Color3.Black();
  return m;
}

/** S0: an empty bright low-poly scene that proves rendering + deployment work. */
export function createGameView(canvas: HTMLCanvasElement): GameView {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.55, 0.78, 0.95, 1);

  const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.1, 22, new Vector3(0, 2, 0), scene);
  camera.attachControl(canvas, true);

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.85;
  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.4), scene);
  sun.intensity = 0.6;

  const ground = MeshBuilder.CreateGround('ground', { width: 60, height: 60 }, scene);
  ground.material = flat(scene, 'ground', new Color3(0.45, 0.75, 0.45));

  const colors = [new Color3(0.9, 0.4, 0.4), new Color3(0.4, 0.6, 0.95), new Color3(0.95, 0.8, 0.35)];
  for (let i = 0; i < 9; i++) {
    const h = 4 + ((i * 7) % 5) * 3;
    const b = MeshBuilder.CreateBox(`bld${i}`, { width: 4, depth: 4, height: h }, scene);
    b.position.set(-12 + (i % 3) * 12, h / 2, -12 + Math.floor(i / 3) * 12);
    b.material = flat(scene, `m${i}`, colors[i % 3]!);
  }

  window.addEventListener('resize', () => engine.resize());
  return { engine, scene };
}
