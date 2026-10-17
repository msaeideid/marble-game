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
import { Sim } from '../src/sim/sim';
import { NEUTRAL_INTENT, type PlayerIntent } from '../src/sim/types';
import type { PropWire } from '../src/sim/props';
import { toWire, wireDistance, type PlayerWire } from '../src/sim/wire';
import { World } from '../src/sim/world';
import { content, getHero } from '../src/data';

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
  expected: { tick: number; state: PlayerWire; broken: number[]; props: PropWire[] }[];
}

/**
 * Runs a scenario through the full authoritative sim (movement, base regen, void respawn, walls, props), exactly
 * what the server does for one player, and records the state at each checkpoint.
 */
function simulate(def: Omit<Scenario, 'expected'>): Scenario['expected'] {
  const world = new World(arena);
  const hero = getHero(def.hero);
  const sim = new Sim(world, hero, {}, { waves: false, props: true, propDefs: content.props });
  const s = sim.addPlayer('p1');
  s.pos = { x: def.start.pos[0], y: def.start.pos[1], z: def.start.pos[2] };
  s.prevPos = { ...s.pos };
  const out: Scenario['expected'] = [];
  const record = (tick: number) =>
    out.push({ tick, state: toWire(s), broken: [...world.broken].sort((a, b) => a - b), props: sim.propWires });
  let tick = 0;
  for (const seg of def.segments) {
    const intent: PlayerIntent = { ...NEUTRAL_INTENT, ...seg.intent };
    for (let i = 0; i < seg.ticks; i++) {
      // Button presses are edge events: only the first tick of a segment carries them.
      const tickIntent =
        i === 0
          ? intent
          : { ...intent, jumpPressed: false, zipPressed: false, chargePressed: false, grabPressed: false, rocketPressed: false };
      sim.step(def.dt, new Map([['p1', tickIntent]]));
      tick++;
      if (tick % def.checkpointEvery === 0) record(tick);
    }
  }
  if (tick % def.checkpointEvery !== 0) record(tick);
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
        grabPressed: rnd() < 0.07,
      },
    });
    used += n;
  }
  return segments;
}

/** Chaos for a flyer: the same idea, plus held climb/descend buttons so flight is exercised hard. */
function flyerChaos(seed: number, ticks: number): Segment[] {
  const rnd = mulberry32(seed);
  const segments: Segment[] = [];
  let yaw = rnd() * Math.PI * 2;
  let used = 0;
  while (used < ticks) {
    const n = 3 + Math.floor(rnd() * 25);
    yaw += (rnd() - 0.5) * 1.2;
    const climb = rnd() < 0.4;
    segments.push({
      ticks: n,
      intent: {
        moveX: Math.round((rnd() * 2 - 1) * 100) / 100,
        moveZ: Math.round((rnd() * 2 - 1) * 100) / 100,
        yaw: Math.round(yaw * 1000) / 1000,
        pitch: Math.round((rnd() * 1.6 - 0.8) * 1000) / 1000,
        jumpPressed: rnd() < 0.3,
        jumpHeld: climb,
        descendHeld: !climb && rnd() < 0.3,
        swingHeld: rnd() < 0.1,
        chargePressed: rnd() < 0.05,
        grabPressed: rnd() < 0.05,
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
    // ---- props: lift, carry, throw, wall breaking, respawn ----
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_lift_carry_and_throw_a_car',
      // Car at (3, 0, -6). Lift it, walk and try to jump while carrying (slow, low jump), throw it east.
      start: at(3, 0.01, -3.6),
      segments: [
        settle,
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI } },
        { ticks: 25, intent: { moveZ: 1, yaw: 0.4 } },
        { ticks: 20, intent: { moveZ: 1, yaw: 0.4, jumpPressed: true } },
        { ticks: 20, intent: {} },
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI / 2, pitch: -0.1 } },
        { ticks: 90, intent: { yaw: Math.PI / 2 } },
      ],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_throw_car_breaks_reinforced_wall',
      // Between the two south walls, the car at (0, 0, -16.5) is lifted and thrown at the tier-2 wall (z -20..-18.5).
      start: at(0, 0.01, -14.7),
      segments: [
        settle,
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI } },
        { ticks: 15, intent: { yaw: Math.PI } },
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI, pitch: -0.05 } },
        { ticks: 90, intent: { yaw: Math.PI } },
      ],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_throw_crate_breaks_weak_wall_then_respawns',
      // Crate at (-3, 0, -4) thrown at the tier-1 wall; it shatters, and 12 s later the crate is back.
      start: at(-3, 0.01, -2),
      segments: [
        settle,
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI } },
        { ticks: 20, intent: { yaw: Math.PI } },
        { ticks: 1, intent: { grabPressed: true, yaw: Math.PI, pitch: -0.05 } },
        { ticks: 420, intent: { yaw: Math.PI } },
      ],
    },
    {
      ...base,
      hero: 'hero.bruiser',
      name: 'rampart_grab_with_nothing_in_reach_and_cooldown',
      start: at(25, 0.01, 0),
      segments: [
        settle,
        { ticks: 1, intent: { grabPressed: true } },
        { ticks: 20, intent: { moveZ: 1 } },
        { ticks: 1, intent: { grabPressed: true } },
        { ticks: 20, intent: {} },
      ],
    },
    {
      ...base,
      hero: 'hero.swinger',
      name: 'ziplash_cannot_lift_props',
      start: at(3, 0.01, -3.6),
      segments: [settle, { ticks: 1, intent: { grabPressed: true } }, { ticks: 30, intent: { moveZ: 1 } }],
    },
    // ---- METALHEAD (hero.flyer): jet flight shares the energy pool; no gravity while the jets are on ----
    {
      ...base,
      hero: 'hero.flyer',
      name: 'metalhead_run_and_jump',
      start: at(0, 0.01, 0),
      segments: [
        settle,
        { ticks: 30, intent: { moveZ: 1 } },
        { ticks: 1, intent: { moveZ: 1, jumpPressed: true, jumpHeld: true } },
        { ticks: 30, intent: { moveZ: 1 } },
        { ticks: 20, intent: {} },
      ],
    },
    {
      ...base,
      hero: 'hero.flyer',
      name: 'metalhead_takeoff_climb_hover_cruise_and_land',
      start: at(0, 0.01, 0),
      segments: [
        settle,
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } },
        { ticks: 6, intent: {} },
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } }, // second press in the air lights the jets
        { ticks: 40, intent: { jumpHeld: true } },
        { ticks: 30, intent: {} }, // hover
        { ticks: 60, intent: { moveZ: 1, yaw: 0.6 } },
        { ticks: 60, intent: { moveX: -1, moveZ: 0.5, yaw: 0.6, jumpHeld: true } },
        { ticks: 115, intent: { descendHeld: true } }, // back down; touching ground ends the flight
        { ticks: 40, intent: { moveZ: 1 } },
      ],
    },
    {
      ...base,
      hero: 'hero.flyer',
      name: 'metalhead_flight_runs_out_of_energy_then_recovers',
      start: at(0, 0.01, 0),
      segments: [
        settle,
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } },
        { ticks: 4, intent: {} },
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } },
        { ticks: 150, intent: { jumpHeld: true } },
        { ticks: 150, intent: { moveZ: 1, yaw: 1 } }, // fuel runs out mid-flight and the hero falls
        { ticks: 120, intent: {} },
        { ticks: 1, intent: { jumpPressed: true } }, // too little energy to relight the jets
        { ticks: 200, intent: {} },
      ],
    },
    {
      ...base,
      hero: 'hero.flyer',
      name: 'metalhead_fly_into_building_and_up_its_wall',
      start: at(0, 0.01, 12),
      segments: [
        settle,
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } },
        { ticks: 4, intent: { jumpHeld: true } },
        { ticks: 1, intent: { jumpPressed: true, jumpHeld: true } },
        { ticks: 60, intent: { moveZ: 1, yaw: Math.PI / 2 } }, // into the tower's side
        { ticks: 60, intent: { moveZ: 1, yaw: Math.PI / 2, jumpHeld: true } }, // up along it
        { ticks: 50, intent: { moveZ: 1, yaw: Math.PI / 2 } }, // over the roof
      ],
    },
    {
      ...base,
      hero: 'hero.flyer',
      name: 'metalhead_ignores_swing_charge_and_lift',
      start: at(3, 0.01, -3.6),
      segments: [
        settle,
        { ticks: 20, intent: { swingHeld: true, yaw: 0.5, pitch: -0.7 } },
        { ticks: 1, intent: { chargePressed: true, yaw: 1 } },
        { ticks: 20, intent: { yaw: 1 } },
        { ticks: 1, intent: { grabPressed: true } },
        { ticks: 20, intent: { moveZ: 1 } },
      ],
    },
    ...[1212, 1313, 1414, 1515].map((seed, i) => ({
      ...base,
      hero: 'hero.flyer',
      name: `metalhead_chaos_seed_${seed}`,
      start: at([0, -6, 8, 2][i]!, 0.01, [-4, 6, -9, 10][i]!),
      segments: [settle, ...flyerChaos(seed, 900)],
    })),
    ...[707, 808, 909, 1010, 1111].map((seed, i) => ({
      ...base,
      hero: 'hero.bruiser',
      name: `rampart_chaos_seed_${seed}`,
      start: at([0, -4, 3, -2, 4][i]!, 0.01, [-6, 2, -10, -5, 3][i]!),
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
          expect(got[i]!.props, `${f} props tick ${got[i]!.tick}`).toEqual(sc.expected[i]!.props);
        }
        expect(worst).toBeLessThan(1e-9);
      });
    }
  });
}
