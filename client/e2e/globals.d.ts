/** The debug hook `window.__vanguard` (the Game instance) as the end-to-end tests use it. */
interface VanguardOnline {
  status: string;
  serverId: string | null;
  playerCount: number;
  pingMs: number;
  session: { stats: { corrections: number; acked: number; inputsSent: number; maxError: number; rttMs: number; lastCorrection: unknown; firstCorrection: unknown } };
  remotePlayers(): Record<string, { name: string; state: { pos: number[]; tether: unknown } }>;
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
    players: Map<
      string,
      {
        pos: { x: number; y: number; z: number };
        grounded: boolean;
        tether: unknown;
        energy: number;
        health: { shield: number; core: number };
      }
    >;
    enemies: Map<string, { pos: { x: number; z: number }; defeatedTimer: number | null }>;
  };
  view: {
    engine: { getRenderingCanvas(): HTMLCanvasElement };
    scene: { meshes: unknown[]; getActiveMeshes(): { length: number }; render(): void };
  };
}

interface Window {
  __vanguard: VanguardHook;
}
