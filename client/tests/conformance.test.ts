/**
 * Conformance scenarios: the contract between the TypeScript sim (client prediction) and the Python sim (server).
 *
 * Normal run: replays the committed scenarios in shared/conformance/movement/ with the TypeScript sim and checks the
 * recorded results still match, so a change to the TS movement rules cannot slip through unnoticed.
 * Regenerate after an intentional change:  UPDATE_CONFORMANCE=1 npm test -- conformance
 * The Python test (server/tests/test_conformance.py) replays the same files against the Python port.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { createPlayerState, stepPlayer } from '../src/sim/controller';
import { NEUTRAL_INTENT, type PlayerIntent } from '../src/sim/types';
import { toWire, wireDistance, type PlayerWire } from '../src/sim/wire';
import { World } from '../src/sim/world';
import { getHero } from '../src/data';

const DT = 1 / 30;
const dir = fileURLToPath(new URL('../../shared/conformance/movement/', import.meta.url));
const UPDATE = process.env.UPDATE_CONFORMANCE === '1';

interface Segment {
  ticks: number;
  intent: Partial<PlayerIntent>;
}
interface Scenario {
  name: string;
  hero: string;
  dt: number;
  start: { pos: [number, number, number] };
  checkpointEvery: number;
  segments: Segment[];
  expected: { tick: number; state: PlayerWire; broken: number[] }[];
}

function simulate(def: Omit<Scenario, 'expected'>): Scenario['expected'] {
  const world = new World(arena);
  const hero = getHero(def.hero);
  const s = createPlayerState(world.spawn, hero);
  s.pos = { x: def.start.pos[0], y: def.start.pos[1], z: def.start.pos[2] };
  s.prevPos = { ...s.pos };
  const out: Scenario['expected'] = [];
  let tick = 0;
  for (const seg of def.segments) {
    const intent: PlayerIntent = { ...NEUTRAL_INTENT, ...seg.intent };
    for (let i = 0; i < seg.ticks; i++) {
      // jumpPressed / zipPressed are edge events: only the first tick of a segment carries them.
      const tickIntent = i === 0 ? intent : { ...intent, jumpPressed: false, zipPressed: false, chargePressed: false };
      stepPlayer(s, tickIntent, hero, world, def.dt);
      tick++;
      if (tick % def.checkpointEvery === 0) out.push({ tick, state: toWire(s), broken: [...world.broken].sort((a, b) => a - b) });
    }
  }
  if (tick % def.checkpointEvery !== 0) out.push({ tick, state: toWire(s), broken: [...world.broken].sort((a, b) => a - b) });
  return out;
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

function chaos(seed: number, ticks: number): Segment[] {
  const rnd = mulberry32(seed);
  const segments: Segment[] = [];
  let yaw = rnd() * Math.PI * 2;
  let used = 0;
  let swinging = false;
  while (used < ticks) {
    const n = 3 + Math.floor(rnd() * 18);
    yaw += (rnd() - 0.5) * 1.2;
    if (rnd() < 0.25) swinging = !swinging;
    segments.push({
      ticks: n,
      intent: {
        moveX: Math.round((rnd() * 2 - 1) * 100) / 100,
        moveZ: Math.round((rnd() * 2 - 1) * 100) / 100,
        yaw: Math.round(yaw * 1000) / 1000,
        pitch: Math.round((rnd() * 1.6 - 0.8) * 1000) / 1000,
        jumpPressed: rnd() < 0.2,
        swingHeld: swinging,
        reelHeld: rnd() < 0.2,
        zipPressed: rnd() < 0.06,
        chargePressed: rnd() < 0.05,
      },
    });
    used += n;
  }
  return segments;
}

const settle: Segment = { ticks: 10, intent: {} };

function definitions(): Omit<Scenario, 'expected'>[] {
  const base = { hero: 'hero.swinger', dt: DT, checkpointEvery: 5 };
  const at = (x: number, y: number, z: number) => ({ pos: [x, y, z] as [number, number, number] });
  return [
    {
      ...base,
      name: 'run_and_jump',
      start: at(0, 0.01, 0),
      segments: [
        settle,
        { ticks: 30, intent: { moveZ: 1 } },
        { ticks: 20, intent: { moveZ: 1, jumpPressed: true } },
        { ticks: 30, intent: { moveX: 1, moveZ: 1, yaw: 0.8 } },
        { ticks: 20, intent: {} },
      ],
    },
    {
      ...base,
      name: 'wall_slide_and_stairs',
      start: at(0, 0.01, 12),
      segments: [
        settle,
        { ticks: 40, intent: { moveZ: 1, yaw: Math.PI / 2 } },
        { ticks: 15, intent: { moveZ: 1, moveX: 0.5, yaw: Math.PI / 2 } },
        { ticks: 20, intent: {} },
        { ticks: 40, intent: { moveZ: 1, yaw: Math.PI / 2, jumpPressed: true } },
        { ticks: 30, intent: { moveZ: 1, yaw: Math.PI / 2, jumpPressed: true } },
      ],
    },
    {
      ...base,
      name: 'swing_launch_release_fall',
      start: at(0, 0.01, -3),
      segments: [
        settle,
        { ticks: 120, intent: { swingHeld: true, yaw: 0.5, pitch: -0.7, moveZ: 0.3 } },
        { ticks: 80, intent: { yaw: 0.5, pitch: 0 } },
      ],
    },
    {
      ...base,
      name: 'swing_with_reel_and_steer',
      start: at(0, 0.01, -3),
      segments: [
        settle,
        { ticks: 40, intent: { swingHeld: true, yaw: 0.5, pitch: -0.7 } },
        { ticks: 40, intent: { swingHeld: true, reelHeld: true, yaw: 0.5, pitch: -0.7, moveX: 1 } },
        { ticks: 40, intent: { swingHeld: true, yaw: 0.5, pitch: -0.7, moveX: -1 } },
        { ticks: 60, intent: {} },
      ],
    },
    {
      ...base,
      name: 'zip_over_roof_edge',
      start: at(0, 0.01, 12),
      segments: [
        settle,
        { ticks: 1, intent: { zipPressed: true, yaw: Math.PI / 2, pitch: -1.1 } },
        { ticks: 100, intent: { yaw: Math.PI / 2, pitch: -1.1 } },
      ],
    },
    {
      ...base,
      name: 'energy_runs_out_then_regens',
      start: at(0, 0.01, -3),
      segments: [
        settle,
        { ticks: 400, intent: { swingHeld: true, reelHeld: true, yaw: 0.5, pitch: -0.7 } },
        { ticks: 200, intent: {} },
      ],
    },
    {
      ...base,
      name: 'tether_blocked_by_building',
      start: at(0, 6, 12),
      segments: [settle, { ticks: 60, intent: { swingHeld: true, yaw: Math.PI / 2, pitch: 0.2 } }],
    },
    // ---- RAMPART (hero.bruiser): the charge, breakable walls and a very different movement feel ----
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_run_and_jump',
      start: at(0, 0.01, 0),
      segments: [
        settle,
        { ticks: 30, intent: { moveZ: 1 } },
        { ticks: 20, intent: { moveZ: 1, jumpPressed: true } },
        { ticks: 30, intent: { moveX: 1, moveZ: 1, yaw: 0.8 } },
        { ticks: 20, intent: {} },
      ],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_charge_smashes_weak_wall',
      // Faces -Z (yaw PI) from the base toward the tier-1 wall in the south corridor (z -14..-12.5).
      start: at(0, 0.01, -2),
      segments: [settle, { ticks: 1, intent: { chargePressed: true, yaw: Math.PI } }, { ticks: 40, intent: { yaw: Math.PI } }],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_charge_stopped_by_reinforced_wall',
      // Start between the weak wall (z -14..-12.5) and the reinforced one (z -20..-18.5), which it cannot break.
      start: at(0, 0.01, -16),
      segments: [settle, { ticks: 1, intent: { chargePressed: true, yaw: Math.PI } }, { ticks: 40, intent: { yaw: Math.PI } }],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_charge_into_building_and_cooldown',
      start: at(0, 0.01, 12),
      segments: [
        settle,
        { ticks: 1, intent: { chargePressed: true, yaw: Math.PI / 2 } },
        { ticks: 30, intent: { yaw: Math.PI / 2 } },
        { ticks: 1, intent: { chargePressed: true, yaw: Math.PI / 2 } }, // still on cooldown / low energy
        { ticks: 60, intent: { yaw: Math.PI / 2 } },
        { ticks: 1, intent: { chargePressed: true, yaw: 0 } },
        { ticks: 40, intent: { yaw: 0, moveZ: 0.5 } },
      ],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_two_charges_through_west_wall',
      start: at(-5, 0.01, 0),
      segments: [
        settle,
        { ticks: 1, intent: { chargePressed: true, yaw: -Math.PI / 2 } },
        { ticks: 60, intent: { yaw: -Math.PI / 2 } },
        { ticks: 1, intent: { chargePressed: true, yaw: -Math.PI / 2 } },
        { ticks: 30, intent: { yaw: -Math.PI / 2 } },
      ],
    },
    ...[707, 808, 909].map((seed, i) => ({
      ...base,
      hero: 'hero.bruiser',
      name: `rampart_chaos_seed_${seed}`,
      start: at([0, -4, 3][i]!, 0.01, [-6, 2, -10][i]!),
      segments: [settle, ...chaos(seed, 900)],
    })),
    ...[101, 202, 303, 404, 505, 606].map((seed, i) => ({
      ...base,
      name: `chaos_seed_${seed}`,
      start: at([0, 3, -12, 20, -25, 8][i]!, 0.01, [0, 14, 5, -22, 18, 30][i]!),
      segments: [settle, ...chaos(seed, 900)],
    })),
  ];
}

if (UPDATE) {
  describe('regenerate conformance scenarios', () => {
    it('writes shared/conformance/movement/*.json', () => {
      mkdirSync(dir, { recursive: true });
      for (const def of definitions()) {
        const scenario: Scenario = { ...def, expected: simulate(def) };
        writeFileSync(`${dir}${def.name}.json`, JSON.stringify(scenario) + '\n');
      }
    });
  });
} else {
  describe('TypeScript sim matches the committed conformance scenarios', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    it('has scenarios', () => expect(files.length).toBeGreaterThanOrEqual(10));
    for (const f of files) {
      it(f, () => {
        const sc = JSON.parse(readFileSync(dir + f, 'utf8')) as Scenario;
        const got = simulate(sc);
        expect(got.length).toBe(sc.expected.length);
        let worst = 0;
        for (let i = 0; i < got.length; i++) {
          worst = Math.max(worst, wireDistance(got[i]!.state, sc.expected[i]!.state));
          expect(got[i]!.broken, `${f} tick ${got[i]!.tick}`).toEqual(sc.expected[i]!.broken);
        }
        expect(worst).toBeLessThan(1e-9);
      });
    }
  });
}
