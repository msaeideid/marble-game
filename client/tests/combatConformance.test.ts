/**
 * Combat conformance: the contract between the TypeScript Sim (solo play, the reference) and the Python GameSim (the
 * networked server) for everything that is not plain movement: enemies and their AI, health, melee, snare, charge,
 * laser, rockets, chain lightning, storm strikes, props hitting enemies, car bombs, waves, defeat and respawn.
 *
 * Normal run: replays the committed scenarios in shared/conformance/combat/ with the TypeScript sim and checks the
 * recorded results still match. Regenerate after an intentional change:  UPDATE_CONFORMANCE=1 npm test -- combatConformance
 * Scenarios are recorded input logs (some are written by small "drivers" that look at the sim, e.g. to aim at a flying
 * car); the Python test (server/tests/test_combat_conformance.py) replays the same logs through the Python port.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { content, getHero } from '../src/data';
import { handPos } from '../src/sim/controller';
import { Sim } from '../src/sim/sim';
import { NEUTRAL_INTENT, type PlayerIntent, type Vec3 } from '../src/sim/types';
import { combatWire, toWire, type CombatWire, type PlayerWire } from '../src/sim/wire';
import { World, type LevelData } from '../src/sim/world';
import type { EnemyWire } from '../src/sim/enemy';
import type { PropWire } from '../src/sim/props';
import type { RocketWire, StrikeWire } from '../src/sim/weapons';

const DT = 1 / 30;
const dir = fileURLToPath(new URL('../../shared/conformance/combat/', import.meta.url));
const UPDATE = process.env.UPDATE_CONFORMANCE === '1';

type Intents = Record<string, Partial<PlayerIntent>>;
interface Segment {
  ticks: number;
  intents: Intents;
}
interface LevelOptions {
  /** Drop the healing pad. */
  noBase?: boolean;
  /** Only the ground: no buildings or walls in the way. */
  openField?: boolean;
  props?: { type: string; pos: number[] }[];
  /** Waves of thugs spawn at the level's enemy spawns. */
  waves?: boolean;
}
interface Scenario {
  name: string;
  dt: number;
  level: LevelOptions;
  players: { id: string; hero: string; pos: [number, number, number] }[];
  enemies: { type: string; pos: [number, number, number]; snared?: number }[];
  checkpointEvery: number;
  segments: Segment[];
  expected: Checkpoint[];
}
interface Checkpoint {
  tick: number;
  players: Record<string, { state: PlayerWire; combat: CombatWire }>;
  enemies: EnemyWire[];
  rockets: RocketWire[];
  strikes: StrikeWire[];
  props: PropWire[];
  broken: number[];
  wave: number;
  events: Record<string, number>;
}
type Definition = Omit<Scenario, 'expected' | 'segments'> & { segments?: Segment[]; ticks?: number; drive?: Driver };
type Driver = (sim: Sim, tick: number) => Intents;

/** Intent flags that are button *presses*: only the first tick of a segment carries them. */
const EDGES = [
  'jumpPressed',
  'zipPressed',
  'attackPressed',
  'snarePressed',
  'chargePressed',
  'grabPressed',
  'rocketPressed',
  'chainPressed',
  'stormPressed',
] as const;

function buildLevel(o: LevelOptions): LevelData {
  const base = arena as unknown as LevelData;
  return {
    ...base,
    ...(o.noBase ? { base: undefined } : {}),
    ...(o.openField ? { colliders: [base.colliders[0]!] } : {}),
    ...(o.props ? { props: o.props } : {}),
  };
}

function setup(def: Definition) {
  const world = new World(buildLevel(def.level));
  const sim = new Sim(world, getHero(def.players[0]!.hero), content.enemies, {
    waves: def.level.waves ?? false,
    props: true,
    propDefs: content.props,
  });
  for (const p of def.players) {
    const s = sim.addPlayer(p.id, getHero(p.hero));
    s.pos = { x: p.pos[0], y: p.pos[1], z: p.pos[2] };
    s.prevPos = { ...s.pos };
    s.invulnerable = 0;
  }
  for (const e of def.enemies) {
    const en = sim.spawnEnemy(e.type, { x: e.pos[0], y: e.pos[1], z: e.pos[2] });
    en.snaredTimer = e.snared ?? 0;
  }
  return sim;
}

function stepWith(sim: Sim, def: Definition, intents: Intents, first: boolean, counts: Record<string, number>) {
  const map = new Map<string, PlayerIntent>();
  for (const [id, i] of Object.entries(intents)) {
    const merged: PlayerIntent = { ...NEUTRAL_INTENT, ...i };
    if (!first) for (const k of EDGES) merged[k] = false;
    map.set(id, merged);
  }
  sim.step(def.dt, map);
  for (const e of sim.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
}

function checkpoint(sim: Sim, def: Definition, tick: number, counts: Record<string, number>): Checkpoint {
  const players: Checkpoint['players'] = {};
  for (const p of def.players) {
    const s = sim.players.get(p.id)!;
    players[p.id] = { state: toWire(s), combat: combatWire(s) };
  }
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k]!;
  return {
    tick,
    players,
    enemies: sim.enemyWires,
    rockets: sim.rocketSystem?.toWire() ?? [],
    strikes: sim.strikeSystem?.toWire() ?? [],
    props: sim.propWires,
    broken: [...sim.world.broken].sort((a, b) => a - b),
    wave: sim.currentWave,
    events: sorted,
  };
}

/** Run a recorded input log; returns the checkpoints. */
function replay(def: Definition & { segments: Segment[] }): Checkpoint[] {
  const sim = setup(def);
  const out: Checkpoint[] = [];
  let counts: Record<string, number> = {};
  let tick = 0;
  for (const seg of def.segments) {
    for (let i = 0; i < seg.ticks; i++) {
      stepWith(sim, def, seg.intents, i === 0, counts);
      tick++;
      if (tick % def.checkpointEvery === 0) {
        out.push(checkpoint(sim, def, tick, counts));
        counts = {};
      }
    }
  }
  if (tick % def.checkpointEvery !== 0) out.push(checkpoint(sim, def, tick, counts));
  return out;
}

/** Run a driver against the sim and record what it did as a one-tick-per-segment input log. */
function record(def: Definition & { drive: Driver; ticks: number }): Segment[] {
  const sim = setup(def);
  const segments: Segment[] = [];
  const counts: Record<string, number> = {};
  for (let t = 0; t < def.ticks; t++) {
    const intents = def.drive(sim, t);
    segments.push({ ticks: 1, intents });
    stepWith(sim, def, intents, true, counts);
  }
  return segments;
}

// ------------------------------------------------------------------ drivers

const hand = (sim: Sim, id: string): Vec3 => handPos(sim.players.get(id)!, sim.heroOf(id));
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Yaw and pitch that point a player's hand at a spot. */
function aimAt(sim: Sim, id: string, p: Vec3): { yaw: number; pitch: number } {
  const h = hand(sim, id);
  const dx = p.x - h.x;
  const dy = p.y - h.y;
  const dz = p.z - h.z;
  return { yaw: round(Math.atan2(dx, dz)), pitch: round(-Math.asin(dy / (Math.hypot(dx, dy, dz) || 1))) };
}

function nearestEnemy(sim: Sim, from: Vec3) {
  let best: { pos: Vec3; id: string; height: number } | null = null;
  let bestD = Infinity;
  for (const t of sim.liveTargets()) {
    const d = Math.hypot(t.pos.x - from.x, t.pos.z - from.z);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best ? { ...best, dist: bestD } : null;
}

/** Walk at the nearest enemy, facing it, and press `buttons` on the given tick periods. */
function fighter(id: string, buttons: Record<string, number | { every: number; from?: number; whileFar?: boolean }>, stopAt = 1.8): Driver {
  return (sim, tick) => {
    const me = sim.players.get(id)!;
    const foe = nearestEnemy(sim, me.pos);
    if (!foe || me.defeatedTimer !== null) return { [id]: {} };
    const aim = aimAt(sim, id, { x: foe.pos.x, y: foe.pos.y + foe.height / 2, z: foe.pos.z });
    const intent: Partial<PlayerIntent> = { ...aim, moveZ: foe.dist > stopAt ? 1 : 0 };
    for (const [k, spec] of Object.entries(buttons)) {
      const every = typeof spec === 'number' ? spec : spec.every;
      const from = typeof spec === 'number' ? 0 : (spec.from ?? 0);
      if (tick >= from && (tick - from) % every === 0) (intent as Record<string, boolean>)[k] = true;
    }
    return { [id]: intent };
  };
}

/** Small deterministic PRNG so generated scenarios are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random play for every player: mostly facing the nearest enemy, pressing every button now and then. */
function chaos(seed: number, ids: string[]): Driver {
  const rnd = mulberry32(seed);
  const held = new Map<string, Partial<PlayerIntent>>();
  const left = new Map<string, number>();
  return (sim, tick) => {
    const out: Intents = {};
    for (const id of ids) {
      const me = sim.players.get(id)!;
      if ((left.get(id) ?? 0) <= 0) {
        const foe = nearestEnemy(sim, me.pos);
        const aim = foe
          ? aimAt(sim, id, { x: foe.pos.x, y: foe.pos.y + foe.height / 2, z: foe.pos.z })
          : { yaw: round(rnd() * 6.28), pitch: 0 };
        left.set(id, 3 + Math.floor(rnd() * 14));
        const noisy = rnd() < 0.3;
        held.set(id, {
          moveX: round((rnd() * 2 - 1) * 0.7),
          moveZ: round(rnd() * 1.2 - 0.2),
          yaw: round(aim.yaw + (noisy ? (rnd() - 0.5) * 1.5 : 0)),
          pitch: round(Math.max(-0.7, Math.min(0.9, aim.pitch + (noisy ? (rnd() - 0.5) * 0.5 : 0)))),
          jumpHeld: rnd() < 0.35,
          descendHeld: rnd() < 0.1,
          fireHeld: rnd() < 0.45,
          swingHeld: rnd() < 0.15,
          reelHeld: rnd() < 0.1,
        });
      }
      left.set(id, left.get(id)! - 1);
      const base = held.get(id)!;
      out[id] = {
        ...base,
        jumpPressed: rnd() < 0.08,
        attackPressed: rnd() < 0.3,
        snarePressed: rnd() < 0.05,
        chargePressed: rnd() < 0.05,
        grabPressed: rnd() < 0.06,
        rocketPressed: rnd() < 0.06,
        chainPressed: rnd() < 0.08,
        stormPressed: rnd() < 0.04,
        zipPressed: rnd() < 0.03,
      };
    }
    void tick;
    return out;
  };
}

/** RAMPART lifts and throws the car at the group; METALHEAD shoots it while it is in the air. */
const carBombDriver: Driver = (sim, tick) => {
  const car = sim.propSystem!.props[0]!;
  const out: Intents = { tank: { yaw: 0 }, jet: {} };
  if (tick === 10) out.tank = { yaw: 0, grabPressed: true };
  if (tick === 36) out.tank = { yaw: 0, pitch: -0.1, grabPressed: true };
  if (car.mode === 'thrown') {
    out.jet = { fireHeld: true, ...aimAt(sim, 'jet', { x: car.pos.x, y: car.pos.y + 0.65, z: car.pos.z }) };
  }
  return out;
};

// ------------------------------------------------------------------ scenarios

const at = (x: number, y: number, z: number) => [x, y, z] as [number, number, number];
const thug = (x: number, z: number, snared = 0) => ({ type: 'enemy.thug', pos: at(x, 0.01, z), snared });
const common = { dt: DT, checkpointEvery: 5 };

function definitions(): Definition[] {
  return [
    {
      ...common,
      name: 'ziplash_melee_vs_chasing_thugs',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.swinger', pos: at(0, 0.01, 0) }],
      enemies: [thug(7, 9), thug(-8, 10), thug(0, 14)],
      ticks: 300,
      drive: fighter('p1', { attackPressed: 4 }),
    },
    {
      ...common,
      name: 'rampart_charge_and_smash_vs_thugs',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.bruiser', pos: at(0, 0.01, 0) }],
      enemies: [thug(5, 12), thug(-6, 14), thug(1, 16), thug(8, 8)],
      ticks: 360,
      drive: fighter('p1', { chargePressed: { every: 45, from: 3 }, attackPressed: 4 }, 1.5),
    },
    {
      ...common,
      name: 'ziplash_snare_then_melee',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.swinger', pos: at(0, 0.01, 0) }],
      enemies: [thug(4, 10), thug(-4, 11)],
      ticks: 260,
      drive: fighter('p1', { snarePressed: { every: 50, from: 2 }, attackPressed: 3 }, 2),
    },
    {
      ...common,
      name: 'metalhead_laser_and_homing_rockets',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.flyer', pos: at(0, 0.01, 0) }],
      enemies: [thug(6, 14), thug(-5, 16), thug(0, 20), thug(3, 17)],
      ticks: 360,
      drive: fighter('p1', { fireHeld: 1, rocketPressed: { every: 110, from: 5 } }, 9),
    },
    {
      ...common,
      name: 'voltage_chain_lightning_and_storm_strike',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.storm', pos: at(0, 0.01, 0) }],
      enemies: [thug(6, 14), thug(-5, 16), thug(8, 16), thug(3, 17)],
      ticks: 360,
      drive: fighter('p1', { chainPressed: { every: 56, from: 2 }, stormPressed: { every: 250, from: 20 } }, 8),
    },
    {
      ...common,
      name: 'combo_car_bomb_two_players',
      level: { openField: true, noBase: true, props: [{ type: 'prop.car', pos: [0, 0, 5] }] },
      players: [
        { id: 'tank', hero: 'hero.bruiser', pos: at(0, 0.01, 3.6) },
        { id: 'jet', hero: 'hero.flyer', pos: at(4, 0.01, 2) },
      ],
      enemies: [thug(0, 12.5, 999), thug(1.6, 13, 999), thug(-1.6, 13, 999)],
      ticks: 120,
      drive: carBombDriver,
    },
    {
      ...common,
      name: 'thrown_props_hit_thugs_and_reinforced_wall',
      level: { noBase: true, props: [{ type: 'prop.car', pos: [0, 0, -16.5] }, { type: 'prop.crate', pos: [-3, 0, -4] }] },
      players: [{ id: 'p1', hero: 'hero.bruiser', pos: at(0, 0.01, -14.7) }],
      enemies: [thug(0, -17.5, 5)],
      ticks: 200,
      drive: (_sim, t) => ({ p1: t === 10 ? { yaw: Math.PI, grabPressed: true } : t === 40 ? { yaw: Math.PI, pitch: -0.05, grabPressed: true } : { yaw: Math.PI } }),
    },
    {
      ...common,
      name: 'defeat_and_respawn_under_attack',
      level: { openField: true, noBase: true },
      players: [{ id: 'p1', hero: 'hero.flyer', pos: at(0, 0.01, 0) }],
      enemies: [thug(1.5, 1.5), thug(-1.5, 1.5), thug(0, -2), thug(2, -2), thug(-2, -2), thug(3, 3)],
      ticks: 420,
      drive: () => ({ p1: { yaw: 0 } }),
    },
    ...[
      [11, ['hero.bruiser', 'hero.flyer']],
      [22, ['hero.storm', 'hero.swinger']],
      [33, ['hero.flyer', 'hero.storm']],
      [44, ['hero.bruiser', 'hero.swinger']],
    ].map(([seed, heroes]) => {
      const hs = heroes as string[];
      return {
        ...common,
        name: `waves_chaos_seed_${seed}`,
        level: { waves: true },
        players: [
          { id: 'a', hero: hs[0]!, pos: at(0, 0.01, 0) },
          { id: 'b', hero: hs[1]!, pos: at(3, 0.01, 1) },
        ],
        enemies: [],
        ticks: 900,
        drive: chaos(seed as number, ['a', 'b']),
      } satisfies Definition;
    }),
  ];
}

function withLog(def: Definition): Definition & { segments: Segment[] } {
  if (def.segments) return def as Definition & { segments: Segment[] };
  return { ...def, segments: record(def as Definition & { drive: Driver; ticks: number }) };
}

if (UPDATE) {
  describe('regenerate combat conformance scenarios', () => {
    it('writes shared/conformance/combat/*.json', () => {
      mkdirSync(dir, { recursive: true });
      for (const raw of definitions()) {
        const def = withLog(raw);
        const scenario: Scenario = {
          name: def.name,
          dt: def.dt,
          level: def.level,
          players: def.players,
          enemies: def.enemies,
          checkpointEvery: def.checkpointEvery,
          segments: def.segments,
          expected: replay(def),
        };
        writeFileSync(`${dir}${def.name}.json`, JSON.stringify(scenario) + '\n');
      }
    });
  });
} else {
  describe('TypeScript sim matches the committed combat conformance scenarios', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    it('has scenarios', () => expect(files.length).toBeGreaterThanOrEqual(10));
    for (const f of files) {
      it(f, () => {
        const sc = JSON.parse(readFileSync(dir + f, 'utf8')) as Scenario;
        const got = replay(sc);
        expect(got.length).toBe(sc.expected.length);
        for (let i = 0; i < got.length; i++) {
          // JSON has no NaN/undefined, so compare through a round trip.
          expect(JSON.parse(JSON.stringify(got[i])), `${f} tick ${got[i]!.tick}`).toEqual(sc.expected[i]);
        }
      });
    }
  });
}

