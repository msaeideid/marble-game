import { describe, expect, it } from 'vitest';
import { lerpWire, SnapshotBuffer } from '../src/net/interpolation';
import { NetSession, type ServerSnapshot } from '../src/net/session';
import { SIM_DT } from '../src/sim/fixedStep';
import { Sim } from '../src/sim/sim';
import type { PlayerIntent } from '../src/sim/types';
import { toWire, wireDistance, type PlayerWire } from '../src/sim/wire';
import { World } from '../src/sim/world';
import arena from '@shared/levels/arena.json';
import { content, hero, intent } from './helpers';

function newSim(): Sim {
  const sim = new Sim(new World(arena), hero, content.enemies);
  sim.addPlayer('me');
  return sim;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic mix of walking, jumping, swinging and zipping. */
function chaosIntents(n: number, seed: number): PlayerIntent[] {
  const r = rng(seed);
  const out: PlayerIntent[] = [];
  let yaw = r() * 6;
  let swinging = false;
  let current = intent();
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) {
      yaw += (r() - 0.5) * 0.8;
      if (r() < 0.3) swinging = !swinging;
      current = intent({
        moveX: Math.round((r() * 2 - 1) * 10) / 10,
        moveZ: Math.round((r() * 2 - 1) * 10) / 10,
        yaw,
        pitch: Math.round((r() * 1.6 - 0.8) * 100) / 100,
        swingHeld: swinging,
        reelHeld: r() < 0.2,
      });
    }
    out.push({ ...current, jumpPressed: r() < 0.06, zipPressed: r() < 0.02 });
  }
  return out;
}

/**
 * Runs a client (prediction) against an in-process authoritative server with symmetric one-way latency (in ticks),
 * a 15 Hz snapshot rate and one input processed per tick, like the real server.
 */
function run(opts: {
  ticks: number;
  latencyTicks: number;
  seed: number;
  serverEvent?: (server: Sim, tick: number) => void;
  settleTicks?: number;
}) {
  const client = newSim();
  const server = newSim();
  let clock = 0;
  const toServer: { due: number; seq: number; intent: PlayerIntent }[] = [];
  const toClient: { due: number; snap: ServerSnapshot }[] = [];
  const queue: { seq: number; intent: PlayerIntent }[] = [];
  let ack = 0;
  let sendSeq = 0;
  const session = new NetSession(
    client,
    'me',
    (m) => {
      const msg = m as { t: string; seq: number; intent: PlayerIntent };
      sendSeq = msg.seq;
      toServer.push({ due: clock + opts.latencyTicks, seq: msg.seq, intent: { ...intent(), ...msg.intent } });
    },
    () => clock * SIM_DT * 1000,
  );

  const script = chaosIntents(opts.ticks, opts.seed);
  const total = opts.ticks + (opts.settleTicks ?? 0);
  for (let tick = 0; tick < total; tick++) {
    clock = tick;
    if (tick < opts.ticks) {
      const i = script[tick]!;
      client.step(SIM_DT, new Map([['me', i]]));
      session.onLocalStep(i);
    }
    while (toServer.length && toServer[0]!.due <= tick) {
      const m = toServer.shift()!;
      queue.push({ seq: m.seq, intent: m.intent });
    }
    opts.serverEvent?.(server, tick);
    const next = queue.shift();
    if (next) {
      server.step(SIM_DT, new Map([['me', next.intent]]));
      ack = next.seq;
    }
    if (tick % 2 === 0) {
      toClient.push({
        due: tick + opts.latencyTicks,
        snap: { t: 'snap', tick, players: { me: { name: 'me', ack, state: toWire(server.players.get('me')!) } } },
      });
    }
    while (toClient.length && toClient[0]!.due <= tick) session.onSnapshot(toClient.shift()!.snap);
  }
  return { client, server, session, sendSeq };
}

describe('prediction and reconciliation', () => {
  it('needs no corrections when client and server run the same rules, even at 200 ms round trip', () => {
    const { session, client } = run({ ticks: 600, latencyTicks: 6, seed: 11 });
    expect(session.stats.corrections).toBe(0);
    expect(session.stats.maxError).toBeLessThan(1e-6);
    expect(session.stats.acked).toBeGreaterThan(550);
    // ...and the player really moved around, so this is not a trivially still scenario.
    const p = client.players.get('me')!;
    expect(Math.hypot(p.pos.x, p.pos.z)).toBeGreaterThan(1);
  });

  it('stays exact across several different input patterns and latencies', () => {
    for (const [seed, latency] of [
      [1, 1],
      [2, 3],
      [3, 9],
      [4, 15],
    ] as const) {
      const { session } = run({ ticks: 400, latencyTicks: latency, seed });
      expect(session.stats.corrections, `seed ${seed} latency ${latency}`).toBe(0);
    }
  });

  it('rewinds and replays when the server disagrees, then converges to the server state', () => {
    const { session, client, server } = run({
      ticks: 400,
      latencyTicks: 6,
      seed: 5,
      settleTicks: 40,
      serverEvent: (srv, tick) => {
        // Server-only events the client cannot predict (think: knocked back by an enemy), at several moments so at
        // least one lands while the player is free to be pushed (a zip, for instance, overrides velocity).
        if (tick % 40 === 20 && tick < 300) {
          const v = srv.players.get('me')!.vel;
          v.x += 12;
          v.y += 5;
        }
      },
    });
    expect(session.stats.corrections).toBeGreaterThanOrEqual(1);
    expect(session.stats.maxError).toBeGreaterThan(0.1);
    // After everything has been acknowledged the client's state equals the server's.
    const c: PlayerWire = toWire(client.players.get('me')!);
    const s: PlayerWire = toWire(server.players.get('me')!);
    expect(wireDistance(c, s)).toBeLessThan(1e-6);
  });

  it('reports a round-trip time close to the simulated latency', () => {
    const { session } = run({ ticks: 300, latencyTicks: 6, seed: 9 });
    const expectedMs = 2 * 6 * SIM_DT * 1000; // 400 ms
    expect(session.stats.rttMs).toBeGreaterThan(expectedMs * 0.8);
    expect(session.stats.rttMs).toBeLessThan(expectedMs * 1.6);
  });

  it('eases the visual offset away after a correction', () => {
    const { session } = run({
      ticks: 200,
      latencyTicks: 4,
      seed: 6,
      serverEvent: (srv, tick) => {
        if (tick === 100) srv.players.get('me')!.vel.z += 15;
      },
    });
    session.renderOffset.x = 2;
    session.renderOffset.z = -3;
    session.update(0.5);
    expect(Math.hypot(session.renderOffset.x, session.renderOffset.z)).toBeLessThan(0.05);
  });

  it('ignores snapshots that do not include us', () => {
    const sim = newSim();
    const session = new NetSession(sim, 'me', () => {});
    expect(() => session.onSnapshot({ t: 'snap', tick: 1, players: {} })).not.toThrow();
    expect(session.stats.corrections).toBe(0);
  });
});

describe('remote player interpolation', () => {
  const state = (x: number, facing = 0): PlayerWire => ({
    ...toWire(newSim().players.get('me')!),
    pos: [x, 0, 0],
    facing,
  });
  const snap = (x: number, extra: Record<string, number> = {}): ServerSnapshot => ({
    t: 'snap',
    tick: 0,
    players: {
      other: { name: 'Bo', ack: 0, state: state(x) },
      me: { name: 'me', ack: 0, state: state(99) },
      ...Object.fromEntries(Object.entries(extra).map(([id, px]) => [id, { name: id, ack: 0, state: state(px) }])),
    },
  });

  it('blends between the two snapshots around (now - delay)', () => {
    const buf = new SnapshotBuffer(100);
    buf.push(1000, snap(0));
    buf.push(1066, snap(10));
    const mid = buf.sample(1033 + 100, 'me').other!;
    expect(mid.state.pos[0]).toBeGreaterThan(4);
    expect(mid.state.pos[0]).toBeLessThan(6);
    expect(mid.name).toBe('Bo');
  });

  it('excludes the local player', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, snap(1));
    expect(Object.keys(buf.sample(500, 'me'))).toEqual(['other']);
  });

  it('holds the last known position instead of extrapolating when data runs out', () => {
    const buf = new SnapshotBuffer(100);
    buf.push(1000, snap(0));
    buf.push(1066, snap(10));
    expect(buf.sample(5000, 'me').other!.state.pos[0]).toBe(10);
    expect(buf.sample(0, 'me').other!.state.pos[0]).toBe(0);
  });

  it('shows a player who joined mid-stream at their first known position', () => {
    const buf = new SnapshotBuffer(100);
    buf.push(1000, snap(0));
    buf.push(1066, snap(10, { late: 7 }));
    expect(buf.sample(1033 + 100, 'me').late!.state.pos[0]).toBe(7);
  });

  it('interpolates the facing angle the short way round', () => {
    const a = state(0, Math.PI - 0.1);
    const b = state(0, -Math.PI + 0.1);
    const mid = lerpWire(a, b, 0.5);
    expect(Math.abs(Math.abs(mid.facing) - Math.PI)).toBeLessThan(0.01);
  });

  it('prunes old snapshots', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 400; i++) buf.push(i * 66, snap(i));
    expect(buf.size).toBeLessThan(60);
  });
});
