import type { Content } from '../data/content';
import type { Sim, SimEvent } from '../sim/sim';
import type { MissionHud, ObjectiveLine, ResultCard } from '../ui/missionHud';
import { MissionRunner, type MissionData, type MissionEvent } from './missions';
import {
  award,
  completeMission,
  defaultStore,
  keepLoot,
  levelFromXp,
  missionUnlocked,
  writeSave,
  type KeyValueStore,
  type SaveData,
} from './progress';

export interface SessionDeps {
  sim: Sim;
  content: Content;
  hud: MissionHud;
  localId: string;
  /** The mission being played, or null for free roam. */
  mission: MissionData | null;
  save: SaveData;
  params: URLSearchParams;
  store?: KeyValueStore | null;
  /** Called once when a mission ends (win or lose) so the game can stop. */
  onEnd?(win: boolean): void;
}

/** Saves are written at most this often (seconds) while loot trickles in during free roam. */
const SAVE_EVERY = 2;

/**
 * The campaign layer of a play session: runs the mission (if any), turns kills into scrap and XP, keeps the save up
 * to date, and drives the mission HUD. Rendering effects stay in `Game`; this only talks to the sim, the save and the HUD.
 */
export class CampaignSession {
  save: SaveData;
  readonly runner: MissionRunner | null;
  over = false;
  private dirty = false;
  private sinceSave = 0;
  private readonly store: KeyValueStore | null;

  constructor(private readonly d: SessionDeps) {
    this.save = d.save;
    this.store = d.store === undefined ? defaultStore() : d.store;
    this.runner = d.mission ? new MissionRunner(d.mission, d.sim, d.localId, d.content.enemies) : null;
    d.hud.setMission(d.mission ? d.mission.title : null);
  }

  /** Call after every sim step with that step's events and its length. Returns what the mission wants the views to show. */
  onStep(events: readonly SimEvent[], dt: number): MissionEvent[] {
    if (this.over) return [];
    if (!this.runner) {
      this.freeRoamLoot(events);
      this.sinceSave += dt;
      if (this.dirty && this.sinceSave >= SAVE_EVERY) this.flush();
      return [];
    }
    this.runner.update(events, dt);
    const out = this.runner.take();
    for (const ev of out) {
      if (ev.type === 'dialogue') this.d.hud.say(ev.speaker, ev.text);
      if (ev.type === 'missionComplete') this.finish(true);
      if (ev.type === 'missionFailed') this.finish(false, ev.reason);
    }
    return out;
  }

  /** Call once per rendered frame: refreshes the objective list, the clock and the boss bar. */
  frame(dt: number): void {
    this.d.hud.tick(dt);
    const r = this.runner;
    if (!r) return;
    const lines: ObjectiveLine[] = r.mission.objectives.map((o, i) => {
      const state = i < r.index ? 'done' : i === r.index ? 'current' : 'later';
      let progress: string | undefined;
      if (state === 'current') {
        const [a, b] = r.progress();
        if (b > 1) progress = `${Math.floor(a)} / ${b}`;
      }
      return { text: o.text, state, ...(progress ? { progress } : {}) };
    });
    this.d.hud.setObjectives(lines, r.status === 'active' ? r.timeLeft() : null);
    const o = r.objective;
    const boss = o?.kind === 'boss' ? r.bossOf(o.tag) : undefined;
    if (boss) {
      const def = this.d.content.enemies[boss.typeId]!;
      const max = def.health.shield.max + def.health.core.max;
      this.d.hud.setBoss(def.boss?.displayTitle ?? def.displayName, (boss.health.shield + boss.health.core) / max);
    } else {
      this.d.hud.setBoss(null);
    }
  }

  /** Write any unsaved progress now (call when the tab is hidden or closed). */
  flush(): void {
    if (!this.dirty) return;
    writeSave(this.save, this.store);
    this.dirty = false;
    this.sinceSave = 0;
  }

  // ---------------------------------------------------------------- internals

  private freeRoamLoot(events: readonly SimEvent[]): void {
    for (const ev of events) {
      if (ev.type !== 'defeated') continue;
      const e = this.d.sim.enemies.get(ev.id);
      const reward = e ? this.d.content.enemies[e.typeId]?.reward : undefined;
      if (!reward) continue;
      this.save = award(this.save, reward.scrap, reward.xp);
      this.dirty = true;
    }
  }

  private finish(win: boolean, reason?: 'time' | 'damage'): void {
    const r = this.runner!;
    const m = r.mission;
    this.over = true;
    const before = this.save;
    this.save = win ? completeMission(this.save, m, r.loot) : keepLoot(this.save, r.loot);
    this.dirty = true;
    this.flush();
    this.d.hud.setBoss(null);

    const missions = Object.values(this.d.content.missions);
    const unlocked = missions.filter((x) => !missionUnlocked(x, before) && missionUnlocked(x, this.save));
    const lines: string[] = [];
    if (win) {
      lines.push(`Reward: +${m.reward.scrap + r.loot.scrap} scrap, +${m.reward.xp + r.loot.xp} XP`);
      if (r.escaped) lines.push('VASTOR got away! But you hurt him, and the whole city saw it.');
      if (levelFromXp(this.save.xp) > levelFromXp(before.xp)) lines.push(`Level up! You are now level ${levelFromXp(this.save.xp)}.`);
      if (unlocked.length > 0) lines.push(`New: ${unlocked.map((x) => x.title).join(', ')}`);
      if (m.reward.flags?.some((f) => /^world\dDone$/.test(f))) lines.push('A new upgrade for every hero is waiting in the Upgrade Bay.');
      if (m.reward.flags?.includes('gameComplete')) lines.push('You saved all four worlds. Thanks for playing!');
    } else {
      lines.push(reason === 'damage' ? 'You got hit. This one needs a clean run.' : "Time's up.");
      if (r.loot.scrap + r.loot.xp > 0) lines.push(`You still keep what you earned: +${r.loot.scrap} scrap, +${r.loot.xp} XP`);
    }
    const base = (extra: Record<string, string>) => {
      const q = new URLSearchParams();
      for (const k of ['hero', 'buddy']) {
        const v = this.d.params.get(k);
        if (v) q.set(k, v);
      }
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return `?${q.toString()}`;
    };
    const card: ResultCard = {
      title: win ? (m.kind === 'challenge' ? 'Challenge complete!' : 'Mission complete!') : 'Challenge failed',
      lines,
      buttons: [
        { label: win ? 'Continue' : 'Back to menu', href: base({ tab: 'campaign' }), primary: win },
        ...(m.kind === 'challenge' || !win ? [{ label: 'Try again', href: base({ mission: m.id }), primary: !win }] : []),
        { label: 'Upgrade Bay', href: base({ tab: 'bay' }) },
      ],
    };
    this.d.hud.showResult(card);
    this.d.onEnd?.(win);
  }
}
