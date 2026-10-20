import { describe, expect, it } from 'vitest';
import type { MissionData } from '../src/campaign/missions';
import {
  award,
  buy,
  completeMission,
  emptySave,
  isUnlocked,
  keepLoot,
  levelFromXp,
  levelProgress,
  loadSave,
  ownedFor,
  sanitizeSave,
  SAVE_KEY,
  whatIsMissing,
  whyNot,
  writeSave,
  xpForLevel,
  type KeyValueStore,
} from '../src/campaign/progress';
import { applyUpgrades, validateUpgrade } from '../src/sim/upgrades';
import { getHero } from '../src/data';
import { content } from './helpers';

const ups = content.upgrades;
const mission = (over: Partial<MissionData> = {}): MissionData => ({
  id: 'mission.m',
  title: 'M',
  chapter: 'chapter.c',
  kind: 'story',
  level: 'arena',
  summary: 's',
  requires: {},
  objectives: [{ id: 'o', text: 'o', kind: 'survive', seconds: 1 }],
  spawns: [],
  dialogue: [],
  reward: { scrap: 20, xp: 30, flags: ['world1Done'] },
  ...over,
});

function fakeStore(initial: string | null = null): KeyValueStore & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(_k, v) {
      this.value = v;
    },
  };
}

describe('XP and levels', () => {
  it('levels come at 50, 200, 450, 800 XP and the progress bar is within the current level', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 50, 200, 450, 800]);
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(49)).toBe(1);
    expect(levelFromXp(50)).toBe(2);
    expect(levelFromXp(199)).toBe(2);
    expect(levelFromXp(200)).toBe(3);
    expect(levelProgress(125)).toEqual([75, 150]); // level 2: 50..200
  });
});

describe('earning', () => {
  it('awards scrap and XP, never negative, without changing the original', () => {
    const a = emptySave();
    const b = award(a, 12.9, 30);
    expect(b).toMatchObject({ scrap: 12, xp: 30 });
    expect(a.scrap).toBe(0);
    expect(award(b, -5, -5)).toMatchObject({ scrap: 12, xp: 30 });
  });

  it('finishing a mission pays its reward plus the loot, sets its flags and counts it', () => {
    const s = completeMission(emptySave(), mission(), { scrap: 5, xp: 10 });
    expect(s).toMatchObject({ scrap: 25, xp: 40, completed: { 'mission.m': 1 }, flags: ['world1Done'] });
    const again = completeMission(s, mission());
    expect(again.completed['mission.m']).toBe(2);
    expect(again.flags).toEqual(['world1Done']); // no duplicates
  });

  it('a failed mission keeps only the loot', () => {
    expect(keepLoot(emptySave(), { scrap: 5, xp: 10 })).toEqual({ ...emptySave(), scrap: 5, xp: 10 });
  });
});

describe('unlocking', () => {
  const titles: Record<string, string> = { 'mission.a': 'Training Day' };

  it('needs finished missions, a level and story flags', () => {
    const req = { missions: ['mission.a'], level: 3, flags: ['x'] };
    const s0 = emptySave();
    expect(isUnlocked(req, s0)).toBe(false);
    expect(whatIsMissing(req, s0, (id) => titles[id]!)).toEqual(['finish Training Day', 'reach level 3', 'story: x']);
    const s1 = { ...s0, completed: { 'mission.a': 1 }, xp: 200, flags: ['x'] };
    expect(isUnlocked(req, s1)).toBe(true);
    expect(whatIsMissing(req, s1, (id) => titles[id]!)).toEqual([]);
    expect(isUnlocked({}, s0)).toBe(true);
  });
});

describe('the upgrade shop', () => {
  const longTether = ups['upgrade.swinger.long_tether']!; // cost 40, no requirement
  const slingshot = ups['upgrade.swinger.slingshot']!; // needs world 2 done

  it('buying costs scrap, can only happen once, and needs the requirements', () => {
    const rich = { ...emptySave(), scrap: 500 };
    expect(whyNot(emptySave(), longTether)).toBe('poor');
    expect(whyNot(rich, slingshot)).toBe('locked');
    expect(whyNot(rich, undefined)).toBe('unknown');
    const bought = buy(rich, longTether)!;
    expect(bought.scrap).toBe(500 - longTether.cost);
    expect(bought.upgrades).toEqual([longTether.id]);
    expect(whyNot(bought, longTether)).toBe('owned');
    expect(buy(bought, longTether)).toBeNull();
    expect(buy(emptySave(), longTether)).toBeNull();
    expect(buy(rich, slingshot)).toBeNull();
    const unlocked = { ...rich, flags: ['world2Done'] };
    expect(buy(unlocked, slingshot)).not.toBeNull();
  });

  it('owned upgrades are applied to the right hero only', () => {
    const save = { ...emptySave(), upgrades: [longTether.id, 'upgrade.flyer.wide_lock', 'upgrade.nope'] };
    expect(ownedFor(save, 'hero.swinger', ups).map((u) => u.id)).toEqual([longTether.id]);
    const base = getHero('hero.swinger');
    const upgraded = applyUpgrades(base, ownedFor(save, 'hero.swinger', ups));
    expect(upgraded.swing!.maxRange).toBeCloseTo(base.swing!.maxRange * 1.25, 9);
    expect(base.swing!.maxRange).toBe(getHero('hero.swinger').swing!.maxRange); // the original is untouched
  });
});

describe('upgrade data', () => {
  const all = Object.values(ups);

  it('every hero has several upgrades, the first few cheap and open, the rest earned by playing', () => {
    for (const hero of ['hero.swinger', 'hero.bruiser', 'hero.flyer', 'hero.storm']) {
      const mine = all.filter((u) => u.hero === hero);
      expect(mine.length, hero).toBeGreaterThanOrEqual(5);
      expect(mine.some((u) => !u.requires?.flags && (u.requires?.level ?? 0) <= 2), hero).toBe(true);
      for (const w of ['world1Done', 'world2Done', 'world3Done']) {
        expect(mine.some((u) => u.requires?.flags?.includes(w)), `${hero} ${w}`).toBe(true); // each world gives each hero something
      }
    }
  });

  it('none of them inflate raw power (the design rule), and every one has text for the shop', () => {
    for (const u of all) {
      expect(validateUpgrade(u), u.id).toEqual([]);
      expect(u.description, u.id).toBeTruthy();
    }
  });

  it('the Breaker Armor upgrade really lets RAMPART break the reinforced wall', () => {
    const base = getHero('hero.bruiser');
    const upgraded = applyUpgrades(base, [ups['upgrade.bruiser.breaker_armor']!]);
    expect(upgraded.charge!.breakPower).toBe(base.charge!.breakPower + 1);
  });
});

describe('saving', () => {
  it('round-trips through storage', () => {
    const store = fakeStore();
    const save = { ...emptySave(), scrap: 77, xp: 12, completed: { 'mission.a': 2 }, upgrades: ['upgrade.x'], flags: ['f'] };
    expect(writeSave(save, store)).toBe(true);
    expect(JSON.parse(store.value!)).toEqual(save);
    expect(loadSave(store)).toEqual(save);
  });

  it('never crashes on missing, broken, blocked or hostile storage', () => {
    expect(loadSave(null)).toEqual(emptySave());
    expect(loadSave(fakeStore('not json {'))).toEqual(emptySave());
    expect(loadSave(fakeStore('42'))).toEqual(emptySave());
    expect(writeSave(emptySave(), null)).toBe(false);
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadSave(blocked)).toEqual(emptySave());
    expect(writeSave(emptySave(), blocked)).toBe(false);
  });

  it('sanitises a tampered save: no negative or fractional numbers, no non-string flags, no duplicates', () => {
    const s = sanitizeSave({
      scrap: -5,
      xp: 12.7,
      completed: { a: 2.9, b: -1, c: 'x' },
      upgrades: ['u', 'u', 7, null],
      flags: ['f', 'f', {}],
      version: 99,
      extra: 'ignored',
    });
    expect(s).toEqual({ version: 1, scrap: 0, xp: 12, completed: { a: 2 }, upgrades: ['u'], flags: ['f'] });
    expect(SAVE_KEY).toBe('vanguard.save.v1');
  });
});
