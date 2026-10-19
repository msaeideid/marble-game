import { SIM_DT } from '../sim/fixedStep';
import type { Sim } from '../sim/sim';
import type { PlayerIntent, Vec3 } from '../sim/types';
import type { EnemyWire } from '../sim/enemy';
import type { PropWire } from '../sim/props';
import type { SimEvent } from '../sim/sim';
import type { RocketWire, StrikeWire } from '../sim/weapons';
import { applyWire, toWire, wireDistance, type CombatWire, type PlayerWire } from '../sim/wire';

/** One message from the server (15 Hz). `ack` is the last input of ours the server has simulated. */
export interface ServerSnapshot {
  t: 'snap';
  tick: number;
  /** Ids of every wall smashed so far (the world's authoritative breakage). */
  broken?: number[];
  /** Every lift-and-throw prop's state (server-authoritative; clients just draw them). */
  props?: PropWire[];
  /** Every enemy, rocket in flight and pending storm strike (server-authoritative; clients just draw them). */
  enemies?: EnemyWire[];
  rockets?: RocketWire[];
  strikes?: StrikeWire[];
  wave?: number;
  /** What happened since the previous snapshot (hits, shots, blasts...), in order. */
  events?: SimEvent[];
  players: Record<string, { name: string; hero?: string; ack: number; state: PlayerWire; combat?: CombatWire }>;
}

/** Every field the server reads from an intent: movement, and the buttons for all abilities. */
export function wireIntent(i: PlayerIntent) {
  return {
    moveX: i.moveX,
    moveZ: i.moveZ,
    yaw: i.yaw,
    pitch: i.pitch,
    jumpPressed: i.jumpPressed,
    swingHeld: i.swingHeld,
    reelHeld: i.reelHeld,
    zipPressed: i.zipPressed,
    chargePressed: i.chargePressed,
    grabPressed: i.grabPressed,
    jumpHeld: i.jumpHeld,
    descendHeld: i.descendHeld,
    attackPressed: i.attackPressed,
    snarePressed: i.snarePressed,
    fireHeld: i.fireHeld,
    rocketPressed: i.rocketPressed,
    chainPressed: i.chainPressed,
    stormPressed: i.stormPressed,
  };
}

export interface NetStats {
  inputsSent: number;
  acked: number;
  /** Times the server disagreed with our prediction and we had to rewind and replay. */
  corrections: number;
  /** Largest and latest prediction error (metres, or the largest state difference). */
  maxError: number;
  lastError: number;
  /** Smoothed round-trip time in ms, measured from input send to the ack that covers it. */
  rttMs: number;
  /** Details of the most recent correction, for debugging: the acked input and which fields disagreed. */
  lastCorrection: { ack: number; error: number; pending: number } | null;
  /** The very first disagreement, with both states, so a mismatch can be diagnosed. */
  firstCorrection: { ack: number; predicted: PlayerWire; server: PlayerWire } | null;
}

/** Prediction errors smaller than this are floating-point noise; we do not rewind for them. */
const ERROR_EPSILON = 1e-6;
/** How fast the visual smoothing of a correction fades (1/s). */
const OFFSET_DECAY = 12;

/**
 * Client-side prediction with server reconciliation for the local player.
 *
 * Every local sim tick: the input is applied locally at once (so controls feel instant) and sent with a sequence
 * number. When a snapshot arrives we compare the server's state at the acknowledged input with what we predicted
 * for it. If they match we do nothing; if not we adopt the server's state and replay the inputs it has not yet
 * seen. The sim code is shared, so with identical rules the prediction is normally exact.
 */
export class NetSession {
  readonly stats: NetStats = { inputsSent: 0, acked: 0, corrections: 0, maxError: 0, lastError: 0, rttMs: 0, lastCorrection: null, firstCorrection: null };
  /** Visual-only offset that hides a correction snap by easing the render position back to the truth. */
  readonly renderOffset: Vec3 = { x: 0, y: 0, z: 0 };

  private seq = 0;
  /** The id the server knows us by in snapshots (the sim may key the local player differently). */
  private serverId: string;
  private pending: { seq: number; intent: PlayerIntent }[] = [];
  private predicted = new Map<number, PlayerWire>();
  private sentAt = new Map<number, number>();

  constructor(
    private readonly sim: Sim,
    private readonly localId: string,
    private readonly send: (msg: object) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.serverId = localId;
  }

  bindServerId(id: string): void {
    this.serverId = id;
  }

  /** Call right after `sim.step` advanced the local player using `intent`. */
  onLocalStep(intent: PlayerIntent): void {
    const seq = ++this.seq;
    this.pending.push({ seq, intent });
    this.predicted.set(seq, toWire(this.sim.players.get(this.localId)!));
    this.sentAt.set(seq, this.now());
    this.stats.inputsSent++;
    this.send({ t: 'input', seq, intent: wireIntent(intent) });
  }

  onSnapshot(snap: ServerSnapshot): void {
    // Walls other players smashed arrive here. Breakage only ever grows, so this never undoes our own prediction.
    if (snap.broken) this.sim.world.unionBroken(snap.broken);
    const mine = snap.players[this.serverId];
    if (!mine) return;
    const ack = mine.ack;
    if (ack > this.stats.acked) {
      const sent = this.sentAt.get(ack);
      if (sent !== undefined) {
        const rtt = this.now() - sent;
        this.stats.rttMs = this.stats.rttMs === 0 ? rtt : this.stats.rttMs * 0.8 + rtt * 0.2;
      }
      this.stats.acked = ack;
    }

    const predictedAtAck = this.predicted.get(ack);
    this.pending = this.pending.filter((p) => p.seq > ack);
    for (const seq of [...this.predicted.keys()]) if (seq < ack) this.predicted.delete(seq);
    for (const seq of [...this.sentAt.keys()]) if (seq < ack) this.sentAt.delete(seq);
    if (ack === 0 || !predictedAtAck) return;

    const err = wireDistance(predictedAtAck, mine.state);
    this.stats.lastError = Number.isFinite(err) ? err : 1e9;
    this.stats.maxError = Math.max(this.stats.maxError, this.stats.lastError);
    if (err <= ERROR_EPSILON) return;

    this.stats.lastCorrection = { ack, error: this.stats.lastError, pending: this.pending.length };
    this.stats.firstCorrection ??= { ack, predicted: predictedAtAck, server: mine.state };
    this.reconcile(mine.state, snap.broken);
  }

  private reconcile(authoritative: PlayerWire, broken: number[] | undefined): void {
    const local = this.sim.players.get(this.localId)!;
    // Adopt the server's world too: a wall we only *predicted* breaking is un-broken until the replay re-breaks it.
    if (broken) this.sim.world.setBroken(broken);
    const before = { ...local.pos };
    applyWire(local, authoritative);
    for (const p of this.pending) {
      this.sim.step(SIM_DT, new Map([[this.localId, p.intent]]));
      this.predicted.set(p.seq, toWire(local));
    }
    this.renderOffset.x += before.x - local.pos.x;
    this.renderOffset.y += before.y - local.pos.y;
    this.renderOffset.z += before.z - local.pos.z;
    this.stats.corrections++;
  }

  /** Ease the visual offset toward zero. Call once per rendered frame. */
  update(dtSeconds: number): void {
    const k = Math.exp(-OFFSET_DECAY * dtSeconds);
    this.renderOffset.x *= k;
    this.renderOffset.y *= k;
    this.renderOffset.z *= k;
  }
}
