import type { EnemyWire } from '../sim/enemy';
import type { PropWire } from '../sim/props';
import type { RocketWire } from '../sim/weapons';
import type { PlayerWire } from '../sim/wire';
import type { ServerSnapshot } from './session';

interface Stamped {
  /** Local clock time (ms) when the snapshot arrived. */
  at: number;
  players: ServerSnapshot['players'];
  props: PropWire[];
  enemies: EnemyWire[];
  rockets: RocketWire[];
}

export interface RemoteSample {
  name: string;
  /** Which hero they play (decides their size and look). */
  hero: string;
  state: PlayerWire;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Blend two states of the same player. Smooth values interpolate; everything discrete comes from `b`. */
export function lerpWire(a: PlayerWire, b: PlayerWire, t: number): PlayerWire {
  return {
    ...b,
    pos: [lerp(a.pos[0], b.pos[0], t), lerp(a.pos[1], b.pos[1], t), lerp(a.pos[2], b.pos[2], t)],
    vel: [lerp(a.vel[0], b.vel[0], t), lerp(a.vel[1], b.vel[1], t), lerp(a.vel[2], b.vel[2], t)],
    facing: lerpAngle(a.facing, b.facing, t),
  };
}

/**
 * Remote players are drawn slightly in the past (`delayMs`) so there are normally two snapshots to blend between,
 * which hides the 15 Hz update rate and network jitter. We never extrapolate: if data runs out the player holds
 * their last known position.
 */
export class SnapshotBuffer {
  private snaps: Stamped[] = [];

  constructor(readonly delayMs = 100) {}

  push(at: number, snap: ServerSnapshot): void {
    this.snaps.push({ at, players: snap.players, props: snap.props ?? [], enemies: snap.enemies ?? [], rockets: snap.rockets ?? [] });
    while (this.snaps.length > 2 && this.snaps[1]!.at < at - 2000) this.snaps.shift();
  }

  sample(now: number, excludeId?: string): Record<string, RemoteSample> {
    const out: Record<string, RemoteSample> = {};
    if (this.snaps.length === 0) return out;
    const renderAt = now - this.delayMs;
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i]!.at > renderAt) i--;
    const a = this.snaps[i]!;
    const b = this.snaps[Math.min(i + 1, this.snaps.length - 1)]!;
    const span = b.at - a.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderAt - a.at) / span)) : 1;
    for (const [id, pb] of Object.entries(b.players)) {
      if (id === excludeId) continue;
      const pa = a.players[id];
      out[id] = { name: pb.name, hero: pb.hero ?? 'hero.swinger', state: pa ? lerpWire(pa.state, pb.state, t) : pb.state };
    }
    return out;
  }

  /** The two snapshots around (now - delay) and how far between them to blend. */
  private around(now: number): { a: Stamped; b: Stamped; t: number } | null {
    if (this.snaps.length === 0) return null;
    const renderAt = now - this.delayMs;
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i]!.at > renderAt) i--;
    const a = this.snaps[i]!;
    const b = this.snaps[Math.min(i + 1, this.snaps.length - 1)]!;
    const span = b.at - a.at;
    return { a, b, t: span > 0 ? Math.min(1, Math.max(0, (renderAt - a.at) / span)) : 1 };
  }

  /** Enemies at (now - delay): positions and facing blend between snapshots, everything else comes from the later one. */
  sampleEnemies(now: number): EnemyWire[] {
    const w = this.around(now);
    if (!w) return [];
    return w.b.enemies.map((eb) => {
      const ea = w.a.enemies.find((e) => e.id === eb.id);
      if (!ea) return eb;
      return {
        ...eb,
        pos: [lerp(ea.pos[0], eb.pos[0], w.t), lerp(ea.pos[1], eb.pos[1], w.t), lerp(ea.pos[2], eb.pos[2], w.t)],
        facing: lerpAngle(ea.facing, eb.facing, w.t),
      };
    });
  }

  /** Rockets at (now - delay), blended the same way. */
  sampleRockets(now: number): RocketWire[] {
    const w = this.around(now);
    if (!w) return [];
    return w.b.rockets.map((rb) => {
      const ra = w.a.rockets.find((r) => r.id === rb.id);
      if (!ra) return rb;
      return { ...rb, pos: [lerp(ra.pos[0], rb.pos[0], w.t), lerp(ra.pos[1], rb.pos[1], w.t), lerp(ra.pos[2], rb.pos[2], w.t)] };
    });
  }

  /** Props at (now - delay): positions blend between the two snapshots, everything else comes from the later one. */
  sampleProps(now: number): PropWire[] {
    if (this.snaps.length === 0) return [];
    const renderAt = now - this.delayMs;
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i]!.at > renderAt) i--;
    const a = this.snaps[i]!;
    const b = this.snaps[Math.min(i + 1, this.snaps.length - 1)]!;
    const span = b.at - a.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderAt - a.at) / span)) : 1;
    return b.props.map((pb) => {
      const pa = a.props.find((p) => p.id === pb.id);
      if (!pa || pa.mode === 'destroyed' || pb.mode === 'destroyed') return pb;
      return {
        ...pb,
        pos: [lerp(pa.pos[0], pb.pos[0], t), lerp(pa.pos[1], pb.pos[1], t), lerp(pa.pos[2], pb.pos[2], t)],
      };
    });
  }

  get size(): number {
    return this.snaps.length;
  }
}
