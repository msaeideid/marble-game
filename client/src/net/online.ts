import { createEnemy, type EnemyWire } from '../sim/enemy';
import type { EnemyParams } from '../sim/params';
import type { PlayerState } from '../sim/controller';
import type { PropWire } from '../sim/props';
import type { Sim, SimEvent } from '../sim/sim';
import type { PlayerIntent } from '../sim/types';
import type { RocketState } from '../sim/weapons';
import type { CombatWire } from '../sim/wire';
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

/** Replace every occurrence of the server's name for us with the local sim's id, so events read like solo events. */
export function remapEvent(ev: SimEvent, from: string, to: string): SimEvent {
  const out: Record<string, unknown> = { ...ev };
  for (const [k, v] of Object.entries(out)) {
    if (v === from) out[k] = to;
    else if (Array.isArray(v) && v.includes(from)) out[k] = v.map((x) => (x === from ? to : x));
  }
  return out as unknown as SimEvent;
}

/** Make `sim.enemies` match the given server enemies exactly (creating, updating and removing as needed). */
export function mirrorEnemies(sim: Sim, wires: readonly EnemyWire[], defs: Record<string, EnemyParams>): void {
  const live = new Set<string>();
  for (const w of wires) {
    const def = defs[w.type];
    if (!def) continue;
    live.add(w.id);
    let e = sim.enemies.get(w.id);
    if (!e) {
      e = createEnemy(w.id, def, { x: w.pos[0], y: w.pos[1], z: w.pos[2] });
      sim.enemies.set(w.id, e);
    }
    e.pos = { x: w.pos[0], y: w.pos[1], z: w.pos[2] };
    e.prevPos = { ...e.pos };
    e.vel = { x: w.vel[0], y: w.vel[1], z: w.vel[2] };
    e.facing = w.facing;
    e.aiState = w.ai;
    e.aiTimer = w.aiTimer;
    e.health.shield = w.shield;
    e.health.core = w.core;
    e.snaredTimer = w.snared;
    e.poiseTimer = w.poise;
    e.attackCooldown = w.cooldown;
    e.defeatedTimer = w.defeated;
  }
  for (const id of [...sim.enemies.keys()]) if (!live.has(id)) sim.enemies.delete(id);
}

/** Copy the server's view of our health, cooldowns and defeat timer onto the local player (they are not predicted). */
export function applyCombat(s: PlayerState, c: CombatWire): void {
  s.health.shield = c.shield;
  s.health.core = c.core;
  s.defeatedTimer = c.defeated;
  s.invulnerable = c.invulnerable;
  s.snareCooldown = c.cooldowns.snare;
  s.laserCooldown = c.cooldowns.laser;
  s.rocketCooldown = c.cooldowns.rocket;
  s.chainCooldown = c.cooldowns.chain;
  s.stormCooldown = c.cooldowns.storm;
}

/** Connection + prediction + remote-player interpolation for one online session. */
export class OnlineClient {
  status: OnlineStatus = 'connecting';
  serverId: string | null = null;
  playerCount = 1;
  /** The server's wave number. */
  wave = 0;
  /** Events waiting to be shown: ours at once, other people's after the interpolation delay so they line up with what is drawn. */
  private events: { at: number; mine: boolean; ev: SimEvent }[] = [];
  readonly session: NetSession;
  readonly buffer = new SnapshotBuffer(100);
  private readonly conn: Connection;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Round trip measured by ping/pong (independent of gameplay inputs), ms. */
  pingMs = 0;

  constructor(
    private readonly sim: Sim,
    private readonly localSimId: string,
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
        this.wave = snap.wave ?? this.wave;
        const mine = this.serverId ? snap.players[this.serverId] : undefined;
        const local = this.sim.players.get(this.localSimId);
        if (mine?.combat && local) applyCombat(local, mine.combat);
        for (const raw of snap.events ?? []) {
          const ev = this.serverId ? remapEvent(raw, this.serverId, this.localSimId) : raw;
          const mine = Object.values(ev).some((v) => v === this.localSimId);
          this.events.push({ at: performance.now(), mine, ev });
        }
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

  /** Everything that happened (hits, shots, blasts...) since the last call, in order, with our own id as the local id. */
  takeEvents(): SimEvent[] {
    const now = performance.now();
    const out: SimEvent[] = [];
    const keep: typeof this.events = [];
    for (const e of this.events) {
      if (e.mine || now - e.at >= this.buffer.delayMs) out.push(e.ev);
      else keep.push(e);
    }
    this.events = keep;
    return out;
  }

  /**
   * Make the local sim's enemy list mirror the server's (smoothed), so the views, health bars, lock-on ring and damage
   * numbers work exactly as they do in solo play. The online sim never runs enemy logic itself.
   */
  mirrorEnemies(defs: Record<string, EnemyParams>): void {
    mirrorEnemies(this.sim, this.buffer.sampleEnemies(performance.now()), defs);
  }

  /** Rockets in flight as the server last described them, smoothed. */
  rocketStates(): RocketState[] {
    return this.buffer.sampleRockets(performance.now()).map((r) => {
      const pos = { x: r.pos[0], y: r.pos[1], z: r.pos[2] };
      return { id: r.id, owner: r.owner, pos, prevPos: { ...pos }, dir: { x: r.dir[0], y: r.dir[1], z: r.dir[2] }, age: 0, targetId: r.target };
    });
  }

  /** Props as the server last described them, smoothed. */
  propWires(): PropWire[] {
    return this.buffer.sampleProps(performance.now());
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
