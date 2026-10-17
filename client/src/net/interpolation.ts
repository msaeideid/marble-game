import type { PlayerWire } from '../sim/wire';
import type { ServerSnapshot } from './session';

interface Stamped {
  /** Local clock time (ms) when the snapshot arrived. */
  at: number;
  players: ServerSnapshot['players'];
}

export interface RemoteSample {
  name: string;
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
    this.snaps.push({ at, players: snap.players });
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
      out[id] = { name: pb.name, state: pa ? lerpWire(pa.state, pb.state, t) : pb.state };
    }
    return out;
  }

  get size(): number {
    return this.snaps.length;
  }
}
