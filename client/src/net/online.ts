import type { Sim } from '../sim/sim';
import type { PlayerIntent } from '../sim/types';
import { Connection, type LagSimulation } from './connection';
import { SnapshotBuffer, type RemoteSample } from './interpolation';
import { NetSession, type ServerSnapshot } from './session';

export type OnlineStatus = 'connecting' | 'online' | 'full' | 'closed';

export interface OnlineOptions {
  url: string;
  name: string;
  lag: LagSimulation;
}

/** Reads `?server=ws://host:8000/ws&lag=80&jitter=20&name=Bo` from the page URL. Null means solo play. */
export function onlineOptionsFromUrl(search: string): OnlineOptions | null {
  const q = new URLSearchParams(search);
  const server = q.get('server');
  if (!server) return null;
  const name = (q.get('name') ?? '').slice(0, 16);
  const hero = q.get('hero') ?? 'hero.swinger';
  const url = `${server}${server.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}&hero=${encodeURIComponent(hero)}`;
  return {
    url,
    name,
    lag: { lagMs: Number(q.get('lag') ?? 0) || 0, jitterMs: Number(q.get('jitter') ?? 0) || 0 },
  };
}

/** Connection + prediction + remote-player interpolation for one online session. */
export class OnlineClient {
  status: OnlineStatus = 'connecting';
  serverId: string | null = null;
  playerCount = 1;
  readonly session: NetSession;
  readonly buffer = new SnapshotBuffer(100);
  private readonly conn: Connection;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Round trip measured by ping/pong (independent of gameplay inputs), ms. */
  pingMs = 0;

  constructor(
    private readonly sim: Sim,
    localSimId: string,
    opts: OnlineOptions,
  ) {
    this.conn = new Connection(opts.url, opts.lag, {
      onMessage: (m) => this.onMessage(m),
      onClose: () => {
        this.status = this.status === 'full' ? 'full' : 'closed';
        if (this.pingTimer) clearInterval(this.pingTimer);
      },
    });
    this.session = new NetSession(sim, localSimId, (m) => {
      if (this.status === 'online') this.conn.send(m);
    });
    this.pingTimer = setInterval(() => {
      if (this.status === 'online') this.conn.send({ t: 'ping', c: performance.now() });
    }, 1000);
  }

  /** True once the server has welcomed us; the local sim waits for this so no inputs are lost. */
  get ready(): boolean {
    return this.status === 'online';
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.t) {
      case 'welcome':
        this.serverId = String(m.id);
        this.sim.world.unionBroken((m.broken as number[] | undefined) ?? []);
        this.session.bindServerId(this.serverId);
        this.status = 'online';
        break;
      case 'full':
        this.status = 'full';
        break;
      case 'snap': {
        const snap = m as unknown as ServerSnapshot;
        this.playerCount = Object.keys(snap.players).length;
        this.buffer.push(performance.now(), snap);
        this.session.onSnapshot(snap);
        break;
      }
      case 'pong':
        this.pingMs = performance.now() - Number(m.c);
        break;
      default:
        break;
    }
  }

  onLocalStep(intent: PlayerIntent): void {
    this.session.onLocalStep(intent);
  }

  remotePlayers(): Record<string, RemoteSample> {
    return this.buffer.sample(performance.now(), this.serverId ?? undefined);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.conn.close();
  }

  describe(): string {
    if (this.status !== 'online') return `net: ${this.status}`;
    const s = this.session.stats;
    return (
      `net: ${this.playerCount} player${this.playerCount === 1 ? '' : 's'} · ping ${this.pingMs.toFixed(0)} ms` +
      ` · corrections ${s.corrections} (last err ${s.lastError.toExponential(1)})`
    );
  }
}
