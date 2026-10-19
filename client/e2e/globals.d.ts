/** The debug hook `window.__vanguard` (the Game instance) as the end-to-end tests use it. */
interface VanguardOnline {
  status: string;
  serverId: string | null;
  playerCount: number;
  pingMs: number;
  session: { stats: { corrections: number; acked: number; inputsSent: number; maxError: number; rttMs: number; lastCorrection: unknown; firstCorrection: unknown } };
  propWires(): { id: number; def: string; mode: string; holder: string | null; pos: number[] }[];
  remotePlayers(): Record<string, { name: string; hero: string; state: { pos: number[]; tether: unknown; charge: unknown } }>;
}

interface VanguardHook {
  paused: boolean;
  setPaused(p: boolean): void;
  frame(dt: number): void;
  input: { yaw: number; pitch: number };
  online: VanguardOnline | null;
  sim: {
    tick: number;
    currentWave: number;
    propWires: { id: number; def: string; mode: string; holder: string | null; pos: number[] }[];
    world: { broken: Set<number>; active: { id: number }[] };
    players: Map<
      string,
      {
        pos: { x: number; y: number; z: number };
        grounded: boolean;
        tether: unknown;
        energy: number;
        carrying: { id: number; def: string } | null;
        flying: boolean;
        defeatedTimer: number | null;
        invulnerable: number;
        vel: { x: number; y: number; z: number };
        health: { shield: number; core: number };
      }
    >;
    enemies: Map<
      string,
      { id: string; pos: { x: number; z: number }; defeatedTimer: number | null; snaredTimer: number; aiState: string; health: { core: number; shield: number } }
    >;
    spawnEnemy(type: string, pos: { x: number; y: number; z: number }): { id: string; snaredTimer: number; aiState: string; health: { core: number; shield: number }; defeatedTimer: number | null };
    rocketSystem: { rockets: { id: number }[] } | null;
    volatileTargets(): { id: string; pos: { x: number; y: number; z: number }; height: number }[];
    events: { type: string; combo?: boolean; owner?: string; thrower?: string | null }[];
    step(dt: number, intents: Map<string, unknown>): void;
    strikeSystem: { strikes: { id: number }[] } | null;
  };
  view: {
    engine: { getRenderingCanvas(): HTMLCanvasElement };
    scene: { meshes: unknown[]; getActiveMeshes(): { length: number }; render(): void };
  };
}

interface Window {
  __vanguard: VanguardHook;
}
