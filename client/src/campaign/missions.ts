import type { Sim, SimEvent } from '../sim/sim';
import type { EnemyState } from '../sim/enemy';
import type { Vec3 } from '../sim/types';

/** Shapes of shared/data/missions/*.json (validated against shared/schemas/mission.schema.json by the tests). */
export type DoAction = 'move' | 'jump' | 'strike' | 'special' | 'fly' | 'swing';

export type Objective = { id: string; text: string } & (
  | { kind: 'do'; action: DoAction; amount: number }
  | { kind: 'defeat'; count: number; enemyType?: string }
  | { kind: 'reach'; pos: number[]; radius: number }
  | { kind: 'survive'; seconds: number }
  | { kind: 'boss'; tag: string; /** Health fraction (0..1) at which the boss escapes and the mission ends. */ escapeAt?: number }
);

export type Trigger = { start: true } | { objective: string; event: 'start' | 'complete' } | { complete: true };

export interface SpawnGroup {
  when: { start: true } | { objective: string; event: 'start' | 'complete' };
  enemies: { type: string; pos: number[]; count?: number; spread?: number; tag?: string }[];
}

export interface DialogueLine {
  when: Trigger;
  speaker: string;
  text: string;
}

export interface MissionData {
  id: string;
  title: string;
  chapter: string;
  kind: 'story' | 'challenge';
  level: string;
  summary: string;
  requires: { missions?: string[]; level?: number; flags?: string[] };
  /** Seconds allowed (challenges). Running out fails the mission. */
  timeLimit?: number;
  /** Taking any damage fails the mission. */
  noDamage?: boolean;
  objectives: Objective[];
  spawns: SpawnGroup[];
  dialogue: DialogueLine[];
  reward: { scrap: number; xp: number; flags?: string[] };
}

export type MissionStatus = 'active' | 'complete' | 'failed';

export type MissionEvent =
  | { type: 'objectiveStart'; index: number; text: string }
  | { type: 'objectiveDone'; index: number }
  | { type: 'dialogue'; speaker: string; text: string }
  | { type: 'bossEscape'; tag: string; id: string }
  | { type: 'missionComplete'; escaped: boolean }
  | { type: 'missionFailed'; reason: 'time' | 'damage' }
  | { type: 'loot'; scrap: number; xp: number };

/** Enough of the enemy data to price a kill. */
export interface RewardTable {
  [enemyType: string]: { reward?: { scrap: number; xp: number } } | undefined;
}

/** A tick-to-tick step this far in one go is a teleport (respawn), not walking. */
const TELEPORT = 5;

function offsets(i: number, spread: number): { x: number; z: number } {
  // A small deterministic grid around the spawn point: 0, +1, -1, +2, -2 across, then the next row.
  const col = i % 5;
  const across = col === 0 ? 0 : col % 2 === 1 ? Math.ceil(col / 2) : -(col / 2);
  return { x: across * spread, z: Math.floor(i / 5) * spread };
}

/**
 * Runs one mission against a sim: spawns enemies, watches events and the local player, advances the objective list, and
 * collects the loot. Pure (no rendering or DOM) so it is testable and can be ported to the server later.
 */
export class MissionRunner {
  status: MissionStatus = 'active';
  /** Index of the objective being worked on (== objectives.length once complete). */
  index = 0;
  /** Seconds since the mission started. */
  elapsed = 0;
  /** Scrap and XP earned from defeated enemies so far. */
  readonly loot = { scrap: 0, xp: 0 };
  /** Set when a boss escaped instead of being defeated. */
  escaped = false;
  /** What happened since the last `take()`, for the UI. */
  private pending: MissionEvent[] = [];
  private readonly tags = new Map<string, string>();
  private started = false;
  private objectiveStartedAt = 0;
  // counters for the current objective
  private kills = 0;
  private moved = 0;
  private jumps = 0;
  private strikes = 0;
  private specials = 0;
  private flown = 0;
  private swings = 0;
  private prev: { x: number; z: number; grounded: boolean; tether: boolean; zip: boolean } | null = null;

  constructor(
    readonly mission: MissionData,
    private readonly sim: Sim,
    private readonly localId: string,
    private readonly rewards: RewardTable,
  ) {}

  get objective(): Objective | undefined {
    return this.mission.objectives[this.index];
  }

  /** How far along the current objective is, as [done, target] (for the HUD). */
  progress(): [number, number] {
    const o = this.objective;
    if (!o) return [1, 1];
    switch (o.kind) {
      case 'do':
        return [Math.min(o.amount, this.doValue(o.action)), o.amount];
      case 'defeat':
        return [Math.min(o.count, this.kills), o.count];
      case 'survive':
        return [Math.min(o.seconds, this.elapsed - this.objectiveStartedAt), o.seconds];
      case 'reach': {
        const p = this.sim.players.get(this.localId);
        const d = p ? Math.hypot(p.pos.x - o.pos[0]!, p.pos.z - o.pos[2]!) : Infinity;
        return [d <= o.radius ? 1 : 0, 1];
      }
      case 'boss': {
        const b = this.bossOf(o.tag);
        return [b ? 0 : 1, 1];
      }
    }
  }

  /** Seconds left on the clock for a timed mission, or null. */
  timeLeft(): number | null {
    return this.mission.timeLimit ? Math.max(0, this.mission.timeLimit - this.elapsed) : null;
  }

  /** The tagged boss, if it is in the world and not yet down. */
  bossOf(tag: string): EnemyState | undefined {
    const id = this.tags.get(tag);
    const e = id ? this.sim.enemies.get(id) : undefined;
    return e && e.defeatedTimer === null ? e : undefined;
  }

  /** The point the HUD should mark, if the current objective is to reach somewhere. */
  marker(): Vec3 | null {
    const o = this.objective;
    return o?.kind === 'reach' ? { x: o.pos[0]!, y: o.pos[1]!, z: o.pos[2]! } : null;
  }

  /** Everything that happened since the last call. */
  take(): MissionEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Call once after every `sim.step`, with that step's events. */
  update(events: readonly SimEvent[], dt: number): void {
    if (this.status !== 'active') return;
    if (!this.started) this.begin();
    this.elapsed += dt;
    const me = this.sim.players.get(this.localId);

    for (const ev of events) this.onEvent(ev);
    if (this.status !== 'active') return;
    if (me) this.watchPlayer(me, dt);

    // An objective may complete as soon as the next one starts (e.g. "reach" while already standing there).
    for (let guard = 0; guard < this.mission.objectives.length && this.status === 'active' && this.isDone(); guard++) {
      this.complete();
    }

    if (this.status === 'active' && this.mission.timeLimit && this.elapsed >= this.mission.timeLimit) {
      this.fail('time');
    }
  }

  // ---------------------------------------------------------------- internals

  private begin(): void {
    this.started = true;
    this.spawnFor({ start: true });
    this.say({ start: true });
    this.startObjective();
  }

  private startObjective(): void {
    const o = this.objective;
    this.objectiveStartedAt = this.elapsed;
    this.kills = this.moved = this.jumps = this.strikes = this.specials = this.flown = this.swings = 0;
    if (!o) return;
    this.pending.push({ type: 'objectiveStart', index: this.index, text: o.text });
    this.spawnFor({ objective: o.id, event: 'start' });
    this.say({ objective: o.id, event: 'start' });
  }

  private complete(): void {
    const o = this.objective!;
    this.pending.push({ type: 'objectiveDone', index: this.index });
    this.spawnFor({ objective: o.id, event: 'complete' });
    this.say({ objective: o.id, event: 'complete' });
    this.index++;
    if (this.index >= this.mission.objectives.length) {
      this.status = 'complete';
      this.say({ complete: true });
      this.pending.push({ type: 'missionComplete', escaped: this.escaped });
    } else {
      this.startObjective();
    }
  }

  private fail(reason: 'time' | 'damage'): void {
    this.status = 'failed';
    this.pending.push({ type: 'missionFailed', reason });
  }

  private spawnFor(when: SpawnGroup['when']): void {
    for (const g of this.mission.spawns) {
      if (!sameTrigger(g.when, when)) continue;
      for (const e of g.enemies) {
        const n = e.count ?? 1;
        for (let i = 0; i < n; i++) {
          const off = offsets(i, e.spread ?? 1.6);
          const enemy = this.sim.spawnEnemy(e.type, { x: e.pos[0]! + off.x, y: e.pos[1]!, z: e.pos[2]! + off.z });
          if (e.tag && i === 0) this.tags.set(e.tag, enemy.id);
        }
      }
    }
  }

  private say(when: Trigger): void {
    for (const d of this.mission.dialogue) {
      if (sameTrigger(d.when, when)) this.pending.push({ type: 'dialogue', speaker: d.speaker, text: d.text });
    }
  }

  private onEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'defeated': {
        const e = this.sim.enemies.get(ev.id);
        if (!e) return; // a player going down is not a kill
        const objective = this.objective;
        if (objective?.kind === 'defeat' && (!objective.enemyType || objective.enemyType === e.typeId)) this.kills++;
        const reward = this.rewards[e.typeId]?.reward;
        if (reward) {
          this.loot.scrap += reward.scrap;
          this.loot.xp += reward.xp;
          this.pending.push({ type: 'loot', scrap: reward.scrap, xp: reward.xp });
        }
        return;
      }
      case 'damage':
        if (ev.target === this.localId && this.mission.noDamage && ev.amount > 0) this.fail('damage');
        return;
      case 'melee':
        if (ev.attacker === this.localId) this.strikes++;
        return;
      case 'laser':
        if (ev.owner === this.localId) this.specials++;
        return;
      case 'rocketLaunch':
      case 'chain':
      case 'strikeStart':
        if (ev.owner === this.localId) this.specials++;
        return;
      case 'snare':
        if (ev.source === this.localId) this.specials++;
        return;
      case 'charge':
        if (ev.id === this.localId) this.specials++;
        return;
      case 'lift':
      case 'throw':
        if (ev.by === this.localId) this.specials++;
        return;
      default:
        return;
    }
  }

  private watchPlayer(me: NonNullable<ReturnType<Sim['players']['get']>>, dt: number): void {
    const now = { x: me.pos.x, z: me.pos.z, grounded: me.grounded, tether: me.tether !== null, zip: me.zip !== null };
    const prev = this.prev;
    if (prev) {
      const step = Math.hypot(now.x - prev.x, now.z - prev.z);
      if (step < TELEPORT) this.moved += step;
      if (prev.grounded && !now.grounded && me.vel.y > 3) this.jumps++;
      if (!prev.tether && now.tether) {
        this.swings++;
        this.specials++;
      }
      if (!prev.zip && now.zip) this.specials++;
    }
    if (me.flying) this.flown += dt;
    this.prev = now;
  }

  private doValue(action: DoAction): number {
    switch (action) {
      case 'move':
        return this.moved;
      case 'jump':
        return this.jumps;
      case 'strike':
        return this.strikes;
      case 'special':
        return this.specials;
      case 'fly':
        return this.flown;
      case 'swing':
        return this.swings;
    }
  }

  private isDone(): boolean {
    const o = this.objective;
    if (!o) return false;
    switch (o.kind) {
      case 'do':
        return this.doValue(o.action) >= o.amount;
      case 'defeat':
        return this.kills >= o.count;
      case 'survive':
        return this.elapsed - this.objectiveStartedAt >= o.seconds;
      case 'reach': {
        const p = this.sim.players.get(this.localId);
        return !!p && p.defeatedTimer === null && Math.hypot(p.pos.x - o.pos[0]!, p.pos.z - o.pos[2]!) <= o.radius && Math.abs(p.pos.y - o.pos[1]!) < 6;
      }
      case 'boss': {
        const id = this.tags.get(o.tag);
        const e = id ? this.sim.enemies.get(id) : undefined;
        if (!id || !e) return this.started && this.tags.has(o.tag); // it was removed (defeated and cleaned up)
        if (e.defeatedTimer !== null) return true;
        if (o.escapeAt !== undefined) {
          const def = this.sim.enemyDefs[e.typeId]!;
          const max = def.health.shield.max + def.health.core.max;
          if ((e.health.shield + e.health.core) / max <= o.escapeAt) {
            this.escaped = true;
            this.pending.push({ type: 'bossEscape', tag: o.tag, id });
            this.sim.enemies.delete(id);
            return true;
          }
        }
        return false;
      }
    }
  }
}

function sameTrigger(a: Trigger, b: Trigger): boolean {
  if ('start' in a || 'start' in b) return 'start' in a && 'start' in b;
  if ('complete' in a || 'complete' in b) return 'complete' in a && 'complete' in b;
  return a.objective === b.objective && a.event === b.event;
}
