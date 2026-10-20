import type { UpgradeData } from '../data/content';
import type { MissionData } from './missions';

/** Everything the game remembers between sessions. Plain data, so it round-trips through JSON. */
export interface SaveData {
  version: 1;
  scrap: number;
  xp: number;
  /** Missions finished, and how many times (challenges can be repeated). */
  completed: Record<string, number>;
  /** Upgrade ids bought. */
  upgrades: string[];
  /** Story flags (a world beaten, VASTOR escaped...). */
  flags: string[];
}

export const SAVE_KEY = 'vanguard.save.v1';

export function emptySave(): SaveData {
  return { version: 1, scrap: 0, xp: 0, completed: {}, upgrades: [], flags: [] };
}

/** XP needed to *reach* a level: 0, 50, 200, 450, 800, ... (level n needs 50 * (n - 1)^2). */
export function xpForLevel(level: number): number {
  return 50 * (level - 1) ** 2;
}

export function levelFromXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** [XP into the current level, XP the level needs] for a progress bar. */
export function levelProgress(xp: number): [number, number] {
  const level = levelFromXp(xp);
  return [xp - xpForLevel(level), xpForLevel(level + 1) - xpForLevel(level)];
}

// ------------------------------------------------------------------ saving

/** The bits of `Storage` we use, so tests can pass a fake and a blocked browser storage cannot crash the game. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Turn whatever was stored into a valid save (unknown or damaged data falls back to an empty one). */
export function sanitizeSave(raw: unknown): SaveData {
  if (typeof raw !== 'object' || raw === null) return emptySave();
  const r = raw as Record<string, unknown>;
  const completed: Record<string, number> = {};
  if (typeof r.completed === 'object' && r.completed !== null) {
    for (const [k, v] of Object.entries(r.completed)) if (num(v) > 0) completed[k] = Math.floor(num(v));
  }
  return {
    version: 1,
    scrap: Math.floor(num(r.scrap)),
    xp: Math.floor(num(r.xp)),
    completed,
    upgrades: [...new Set(strings(r.upgrades))],
    flags: [...new Set(strings(r.flags))],
  };
}

export function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (private window, strict settings)
  }
}

export function loadSave(store: KeyValueStore | null = defaultStore()): SaveData {
  try {
    const text = store?.getItem(SAVE_KEY);
    return text ? sanitizeSave(JSON.parse(text)) : emptySave();
  } catch {
    return emptySave();
  }
}

/** Returns false if the browser would not let us save (the game keeps working, progress just is not kept). */
export function writeSave(save: SaveData, store: KeyValueStore | null = defaultStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ rules

export function has(save: SaveData, flag: string): boolean {
  return save.flags.includes(flag);
}

export function isUnlocked(requires: { missions?: string[]; level?: number; flags?: string[] }, save: SaveData): boolean {
  return (
    (requires.missions ?? []).every((m) => (save.completed[m] ?? 0) > 0) &&
    levelFromXp(save.xp) >= (requires.level ?? 0) &&
    (requires.flags ?? []).every((f) => has(save, f))
  );
}

export const missionUnlocked = (m: MissionData, save: SaveData): boolean => isUnlocked(m.requires, save);

/** What is missing for a mission, in words ("needs level 3", "needs: Training Day"). Empty when unlocked. */
export function whatIsMissing(
  requires: { missions?: string[]; level?: number; flags?: string[] },
  save: SaveData,
  titleOf: (missionId: string) => string,
): string[] {
  const out: string[] = [];
  for (const m of requires.missions ?? []) if (!(save.completed[m] ?? 0)) out.push(`finish ${titleOf(m)}`);
  if (levelFromXp(save.xp) < (requires.level ?? 0)) out.push(`reach level ${requires.level}`);
  for (const f of requires.flags ?? []) if (!has(save, f)) out.push(`story: ${f}`);
  return out;
}

/** Add scrap and XP (never negative). Returns a new save. */
export function award(save: SaveData, scrap: number, xp: number): SaveData {
  return { ...save, scrap: save.scrap + Math.max(0, Math.floor(scrap)), xp: save.xp + Math.max(0, Math.floor(xp)) };
}

/** Record a finished mission: its reward plus whatever was looted, its flags, and the completion count. */
export function completeMission(save: SaveData, m: MissionData, loot: { scrap: number; xp: number } = { scrap: 0, xp: 0 }): SaveData {
  const rewarded = award(save, m.reward.scrap + loot.scrap, m.reward.xp + loot.xp);
  return {
    ...rewarded,
    completed: { ...rewarded.completed, [m.id]: (rewarded.completed[m.id] ?? 0) + 1 },
    flags: [...new Set([...rewarded.flags, ...(m.reward.flags ?? [])])],
  };
}

/** Loot from a mission you did not finish (a failed challenge): the scrap and XP are kept, nothing else. */
export function keepLoot(save: SaveData, loot: { scrap: number; xp: number }): SaveData {
  return award(save, loot.scrap, loot.xp);
}

export type BuyProblem = 'owned' | 'locked' | 'poor' | 'unknown';

export function whyNot(save: SaveData, u: UpgradeData | undefined): BuyProblem | null {
  if (!u) return 'unknown';
  if (save.upgrades.includes(u.id)) return 'owned';
  if (!isUnlocked(u.requires ?? {}, save)) return 'locked';
  if (save.scrap < u.cost) return 'poor';
  return null;
}

export function buy(save: SaveData, u: UpgradeData): SaveData | null {
  if (whyNot(save, u) !== null) return null;
  return { ...save, scrap: save.scrap - u.cost, upgrades: [...save.upgrades, u.id] };
}

/** The upgrades a hero owns, in purchase order, ready for `applyUpgrades`. */
export function ownedFor(save: SaveData, heroId: string, all: Record<string, UpgradeData>): UpgradeData[] {
  return save.upgrades.map((id) => all[id]).filter((u): u is UpgradeData => !!u && u.hero === heroId);
}
