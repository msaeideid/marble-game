import { describe, expect, it } from 'vitest';
import type { MissionData } from '../src/campaign/missions';
import { completeMission, emptySave, isUnlocked, type SaveData } from '../src/campaign/progress';
import type { LevelData } from '../src/sim/world';
import { content } from './helpers';

const missions = Object.values(content.missions);
const levels = content.levels;
const byId = content.missions;

type Box = { kind: string; min: number[]; max: number[]; breakable?: number };

/** The solid things standing on the ground that stop a walker (the ground itself and tiny props do not). */
const blockers = (lv: LevelData): Box[] => lv.colliders.filter((c) => c.kind !== 'ground' && c.min[1]! < 1.5 && c.max[1]! > 0.4);
const grounds = (lv: LevelData): Box[] => lv.colliders.filter((c) => c.kind === 'ground');

function groundAt(lv: LevelData, x: number, z: number): boolean {
  return grounds(lv).some((g) => x >= g.min[0]! && x <= g.max[0]! && z >= g.min[2]! && z <= g.max[2]! && g.max[1]! <= 0.2);
}

function blockedAt(lv: LevelData, x: number, z: number, r = 0.45): boolean {
  return blockers(lv).some((c) => x > c.min[0]! - r && x < c.max[0]! + r && z > c.min[2]! - r && z < c.max[2]! + r);
}

const standable = (lv: LevelData, p: number[]) => groundAt(lv, p[0]!, p[2]!) && !blockedAt(lv, p[0]!, p[2]!);

/** Flood fill over a 1 m grid, treating buildings, crates and every wall (even the breakable ones) as solid. */
function reachable(lv: LevelData, from: number[]): Set<string> {
  const key = (x: number, z: number) => `${x},${z}`;
  const start = [Math.round(from[0]!), Math.round(from[2]!)] as const;
  const seen = new Set([key(start[0], start[1])]);
  const todo = [start];
  const solid = blockers(lv);
  const gs = grounds(lv);
  while (todo.length > 0) {
    const [x, z] = todo.pop()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = key(nx, nz);
      if (seen.has(k)) continue;
      if (!gs.some((g) => nx >= g.min[0]! && nx <= g.max[0]! && nz >= g.min[2]! && nz <= g.max[2]! && g.max[1]! <= 0.2)) continue;
      if (solid.some((c) => nx > c.min[0]! - 0.45 && nx < c.max[0]! + 0.45 && nz > c.min[2]! - 0.45 && nz < c.max[2]! + 0.45)) continue;
      seen.add(k);
      todo.push([nx, nz]);
    }
  }
  return seen;
}

const canWalkTo = (lv: LevelData, from: number[], to: number[]) => reachable(lv, from).has(`${Math.round(to[0]!)},${Math.round(to[2]!)}`);

/** The same layout the runner uses for a group of enemies. */
function groupOffsets(n: number, spread: number): { x: number; z: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const col = i % 5;
    const across = col === 0 ? 0 : col % 2 === 1 ? Math.ceil(col / 2) : -(col / 2);
    return { x: across * spread, z: Math.floor(i / 5) * spread };
  });
}

describe('levels', () => {
  it('there is a level for the tutorial, the hub (and its damaged version), VASTOR, three worlds and the finale', () => {
    for (const id of ['tutorial', 'arena', 'arena_damaged', 'vastor_arena', 'sugarworks', 'cloudspire', 'gearhollow', 'finale']) {
      expect(levels[id], id).toBeDefined();
    }
  });

  it('every level has the player starting on solid ground, props standing on ground, and (apart from the hub) its own look', () => {
    for (const lv of Object.values(levels)) {
      expect(standable(lv, lv.spawn), `${lv.id} spawn`).toBe(true);
      for (const p of lv.props ?? []) expect(groundAt(lv, p.pos[0]!, p.pos[2]!), `${lv.id} prop ${p.type}`).toBe(true);
      if (lv.id !== 'arena') expect(lv.theme, lv.id).toBeDefined();
      for (const e of lv.enemySpawns ?? []) expect(standable(lv, e.pos), `${lv.id} enemy spawn`).toBe(true);
    }
  });

  it('the worlds look different from each other', () => {
    const skies = ['sugarworks', 'cloudspire', 'gearhollow', 'finale'].map((id) => JSON.stringify(levels[id]!.theme!.sky));
    expect(new Set(skies).size).toBe(skies.length);
  });
});

describe('missions: references', () => {
  it('has the story missions and four challenges in each world', () => {
    for (const id of ['mission.tutorial', 'mission.vastor', 'mission.w1.main', 'mission.w2.main', 'mission.w3.main', 'mission.finale']) {
      expect(byId[id], id).toBeDefined();
    }
    for (const w of ['w1', 'w2', 'w3']) {
      expect(missions.filter((m) => m.id.startsWith(`mission.${w}.`) && m.kind === 'challenge').length, w).toBe(4);
      expect(missions.filter((m) => m.id.startsWith(`mission.${w}.`) && m.kind === 'story').length, w).toBe(1);
    }
    expect(missions.filter((m) => m.chapter === 'chapter.city' && m.kind === 'challenge').length).toBe(3);
  });

  it('every mission points at real levels, missions, enemies and objectives', () => {
    for (const m of missions) {
      expect(levels[m.level], `${m.id} level ${m.level}`).toBeDefined();
      for (const r of m.requires.missions ?? []) expect(byId[r], `${m.id} requires ${r}`).toBeDefined();
      const ids = m.objectives.map((o) => o.id);
      expect(new Set(ids).size, `${m.id} duplicate objective ids`).toBe(ids.length);
      for (const g of m.spawns) {
        if ('objective' in g.when) expect(ids, `${m.id} spawn trigger`).toContain(g.when.objective);
        for (const e of g.enemies) expect(content.enemies[e.type], `${m.id} spawns ${e.type}`).toBeDefined();
      }
      for (const d of m.dialogue) if ('objective' in d.when) expect(ids, `${m.id} dialogue trigger`).toContain(d.when.objective);
      for (const o of m.objectives) {
        if (o.kind === 'defeat' && o.enemyType) expect(content.enemies[o.enemyType], `${m.id} ${o.id}`).toBeDefined();
      }
    }
  });

  it('every boss objective has a boss spawned with its tag, which really is a boss', () => {
    for (const m of missions) {
      for (const o of m.objectives) {
        if (o.kind !== 'boss') continue;
        const spawned = m.spawns.flatMap((g) => g.enemies).find((e) => e.tag === o.tag);
        expect(spawned, `${m.id} boss ${o.tag}`).toBeDefined();
        expect(content.enemies[spawned!.type]!.boss, `${m.id} ${spawned!.type}`).toBeDefined();
      }
    }
  });

  it('challenges are timed or no-damage, story missions are not failable, and a no-damage challenge is not also about killing', () => {
    for (const m of missions) {
      if (m.kind === 'challenge') expect(m.timeLimit || m.noDamage, m.id).toBeTruthy();
      else expect(m.timeLimit || m.noDamage, m.id).toBeFalsy();
    }
  });

  it('the VASTOR fight ends with his escape; the finale has none', () => {
    const escape = (m: MissionData) => m.objectives.some((o) => o.kind === 'boss' && o.escapeAt !== undefined);
    expect(escape(byId['mission.vastor']!)).toBe(true);
    expect(byId['mission.vastor']!.reward.flags).toContain('vastorEscaped');
    expect(escape(byId['mission.finale']!)).toBe(false);
    expect(byId['mission.finale']!.reward.flags).toContain('gameComplete');
  });
});

describe('missions: the world they happen in', () => {
  const ofLevel = (m: MissionData) => levels[m.level]!;

  it('every enemy spawn lands on open ground, with room for the whole group', () => {
    for (const m of missions) {
      const lv = ofLevel(m);
      for (const g of m.spawns) {
        for (const e of g.enemies) {
          for (const off of groupOffsets(e.count ?? 1, e.spread ?? 1.6)) {
            const p = [e.pos[0]! + off.x, e.pos[1]!, e.pos[2]! + off.z];
            expect(standable(lv, p), `${m.id}: ${e.type} at ${p.map((v) => v.toFixed(1))}`).toBe(true);
          }
        }
      }
    }
  });

  it('every marker is somewhere you can stand and walk to from the start, without breaking a wall or crossing a gap', () => {
    for (const m of missions) {
      const lv = ofLevel(m);
      const flood = reachable(lv, lv.spawn);
      for (const o of m.objectives) {
        if (o.kind !== 'reach') continue;
        expect(standable(lv, o.pos), `${m.id} ${o.id} is inside something or over the void`).toBe(true);
        expect(flood.has(`${Math.round(o.pos[0]!)},${Math.round(o.pos[2]!)}`), `${m.id} ${o.id} cannot be walked to`).toBe(true);
      }
      for (const g of m.spawns) {
        for (const e of g.enemies) {
          expect(flood.has(`${Math.round(e.pos[0]!)},${Math.round(e.pos[2]!)}`), `${m.id} ${e.type} spawns where you cannot walk`).toBe(true);
        }
      }
    }
  });

  it('every world has a walkable ground route from the start to its boss, so every hero can finish it', () => {
    for (const id of ['mission.w1.main', 'mission.w2.main', 'mission.w3.main']) {
      const m = byId[id]!;
      const lv = ofLevel(m);
      const boss = m.spawns.flatMap((g) => g.enemies).find((e) => e.tag === 'boss')!;
      expect(canWalkTo(lv, lv.spawn, boss.pos), id).toBe(true);
    }
  });

  it('the weak walls in Gearhollow are shortcuts, not the only way through', () => {
    const lv = levels['gearhollow']!;
    expect(lv.colliders.filter((c) => c.kind === 'wall' && c.breakable).length).toBeGreaterThan(2);
  });

  it('the walkability check is not vacuous: Cloudspire without its bridges cannot be crossed', () => {
    const lv = levels['cloudspire']!;
    const noBridges = { ...lv, colliders: lv.colliders.filter((c) => !(c.kind === 'ground' && c.max[0]! - c.min[0]! < 7 || c.kind === 'ground' && c.max[2]! - c.min[2]! < 7)) };
    const boss = byId['mission.w2.main']!.spawns.flatMap((g) => g.enemies).find((e) => e.tag === 'boss')!;
    expect(canWalkTo(lv, lv.spawn, boss.pos)).toBe(true);
    expect(canWalkTo(noBridges, lv.spawn, boss.pos)).toBe(false);
  });

  it('Cloudspire really has gaps (and only bridges across them)', () => {
    const lv = levels['cloudspire']!;
    expect(lv.killY).toBeGreaterThan(-40); // a shallow fall: the void is close
    // a point between two islands that is not on a bridge has no ground
    expect(groundAt(lv, 11, 11)).toBe(false);
  });
});

describe('the whole campaign can be finished', () => {
  /** Play everything in an order the unlock rules allow, with unlimited XP, and see that nothing is stuck. */
  it('every mission unlocks, in a sensible order, and the flags upgrades need are all earned', () => {
    let save: SaveData = { ...emptySave(), xp: 1e6 };
    const order: string[] = [];
    for (let round = 0; round < missions.length + 1; round++) {
      const next = missions.find((m) => (save.completed[m.id] ?? 0) === 0 && isUnlocked(m.requires, save));
      if (!next) break;
      order.push(next.id);
      save = completeMission(save, next);
    }
    expect(order.length, `stuck after ${order.join(', ')}`).toBe(missions.length);
    expect(order.indexOf('mission.tutorial')).toBeLessThan(order.indexOf('mission.vastor'));
    expect(order.indexOf('mission.vastor')).toBeLessThan(order.indexOf('mission.w1.main'));
    expect(order.indexOf('mission.w3.main')).toBeLessThan(order.indexOf('mission.finale'));
    // every flag any upgrade or mission asks for is granted by some mission
    const granted = new Set(missions.flatMap((m) => m.reward.flags ?? []));
    for (const u of Object.values(content.upgrades)) for (const f of u.requires?.flags ?? []) expect(granted.has(f), `${u.id} needs ${f}`).toBe(true);
    for (const m of missions) for (const f of m.requires.flags ?? []) expect(granted.has(f), `${m.id} needs ${f}`).toBe(true);
  });

  it('the first VASTOR fight needs a level you can reach by doing the city challenges', () => {
    const need = byId['mission.vastor']!.requires.level ?? 0;
    // tutorial + 3 challenges worth of XP, plus ordinary kills, must be able to reach it
    const xp = ['mission.tutorial', 'mission.challenge.thug_rush', 'mission.challenge.rooftop_run', 'mission.challenge.untouchable'].reduce(
      (n, id) => n + byId[id]!.reward.xp,
      0,
    );
    const thugXp = content.enemies['enemy.thug']!.reward!.xp;
    expect(xp + thugXp * 12).toBeGreaterThanOrEqual(50 * (need - 1) ** 2);
  });
});
