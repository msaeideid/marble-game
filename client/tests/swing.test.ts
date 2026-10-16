import { describe, expect, it } from 'vitest';
import swinger from '@shared/data/heroes/swinger.json';
import arena from '@shared/levels/arena.json';
import { handPos } from '../src/sim/controller';
import type { HeroParams } from '../src/sim/params';
import { Sim } from '../src/sim/sim';
import { pickSwingAnchor, removeOutwardVelocity, ropeLimitedDelta } from '../src/sim/swing';
import { NEUTRAL_INTENT, type PlayerIntent, type Vec3 } from '../src/sim/types';
import { World } from '../src/sim/world';

const DT = 1 / 30;
const hero = swinger as HeroParams;
const intent = (over: Partial<PlayerIntent> = {}): PlayerIntent => ({ ...NEUTRAL_INTENT, ...over });

function makeSim(): Sim {
  const sim = new Sim(new World(arena), hero);
  sim.addPlayer('p1');
  return sim;
}
function run(sim: Sim, ticks: number, make: (i: number) => PlayerIntent): void {
  for (let i = 0; i < ticks; i++) sim.step(DT, new Map([['p1', make(i)]]));
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('rope maths', () => {
  it('keeps the hand within the rope length', () => {
    const anchor = { x: 0, y: 10, z: 0 };
    const hand = { x: 5, y: 10, z: 0 };
    const d = ropeLimitedDelta(hand, { x: 3, y: 0, z: 0 }, anchor, 5);
    const next = { x: hand.x + d.x, y: hand.y + d.y, z: hand.z + d.z };
    expect(dist(next, anchor)).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('leaves slack moves alone', () => {
    const d = { x: -1, y: 0, z: 0 };
    expect(ropeLimitedDelta({ x: 5, y: 10, z: 0 }, d, { x: 0, y: 10, z: 0 }, 5)).toBe(d);
  });

  it('removes only the outward velocity when taut', () => {
    const vel = { x: 3, y: 4, z: 0 };
    removeOutwardVelocity(vel, { x: 5, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, 5);
    expect(vel.x).toBeCloseTo(0, 9);
    expect(vel.y).toBeCloseTo(4, 9);
  });

  it('ignores velocity pointing inward or a slack rope', () => {
    const inward = { x: -3, y: 0, z: 0 };
    removeOutwardVelocity(inward, { x: 5, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, 5);
    expect(inward.x).toBe(-3);
    const slack = { x: 3, y: 0, z: 0 };
    removeOutwardVelocity(slack, { x: 2, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, 5);
    expect(slack.x).toBe(3);
  });
});

describe('anchor picking', () => {
  it('finds a building wall when aiming up and forward', () => {
    const world = new World(arena);
    const hand = { x: 0, y: 1.4, z: 12 };
    const a = pickSwingAnchor(world, hand, { x: Math.cos(0.6), y: Math.sin(0.6), z: 0 }, hero.swing.maxRange);
    expect(a).not.toBeNull();
    expect(a!.x).toBeLessThan(7);
    expect(a!.x).toBeGreaterThan(6.9);
  });

  it('returns null when aiming at open sky', () => {
    const world = new World(arena);
    expect(pickSwingAnchor(world, { x: 0, y: 1.4, z: 0 }, { x: 0, y: 1, z: 0 }, 55)).toBeNull();
  });
});

/** Put the player in mid-air and attach a tether to an arbitrary anchor, bypassing aiming. */
function hang(sim: Sim, from: Vec3, anchor: Vec3) {
  const p = sim.players.get('p1')!;
  p.pos = { ...from };
  p.prevPos = { ...from };
  const length = dist(handPos(p, hero), anchor);
  p.tether = { anchor, length, targetLength: length };
  p.swingHeldPrev = true;
  return p;
}

describe('swinging', () => {
  it('never stretches the rope and swings like a pendulum', () => {
    const sim = makeSim();
    const anchor = { x: 0, y: 60, z: 0 };
    const p = hang(sim, { x: 0, y: 40, z: -20 }, anchor);
    const length = p.tether!.length;
    const startHandY = p.pos.y + hero.swing.handHeight;
    let lowestHandY = Infinity;
    let maxSpeed = 0;
    for (let i = 0; i < 150; i++) {
      sim.step(DT, new Map([['p1', intent({ swingHeld: true })]]));
      expect(dist(handPos(p, hero), anchor)).toBeLessThanOrEqual(length + 0.05);
      lowestHandY = Math.min(lowestHandY, p.pos.y + hero.swing.handHeight);
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.y, p.vel.z));
    }
    // Energy conservation: top speed is about sqrt(2 g h) for the height dropped.
    expect(startHandY - lowestHandY).toBeGreaterThan(5);
    const ideal = Math.sqrt(2 * hero.movement.gravity * (startHandY - lowestHandY));
    expect(maxSpeed).toBeGreaterThan(ideal * 0.8);
    expect(maxSpeed).toBeLessThan(ideal * 1.1);
  });

  it('keeps momentum after release (no air drag) and adds the release boost', () => {
    const sim = makeSim();
    const p = hang(sim, { x: 0, y: 40, z: -20 }, { x: 0, y: 60, z: 0 });
    run(sim, 30, () => intent({ swingHeld: true }));
    const before = Math.hypot(p.vel.x, p.vel.z);
    run(sim, 1, () => intent({ swingHeld: false }));
    expect(p.tether).toBeNull();
    const after = Math.hypot(p.vel.x, p.vel.z);
    expect(after).toBeGreaterThan(before);
    run(sim, 6, () => intent({ swingHeld: false }));
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeCloseTo(after, 0);
  });

  it('drains energy while tethered and lets go when empty', () => {
    const sim = makeSim();
    const p = hang(sim, { x: 0, y: 40, z: -20 }, { x: 0, y: 60, z: 0 });
    p.energy = 2;
    run(sim, 30, () => intent({ swingHeld: true }));
    expect(p.tether).toBeNull();
    expect(p.energy).toBe(0);
  });

  it('regenerates energy after a delay when not swinging', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.energy = 10;
    p.energyDelay = hero.energy.regenDelay;
    run(sim, 60, () => intent());
    expect(p.energy).toBeGreaterThan(10);
    expect(p.energy).toBeLessThanOrEqual(hero.energy.max);
  });

  it('attaches on press, charges the attach cost, and detaches on release', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 3, z: 12 };
    p.energy = 50;
    // Face +X (yaw PI/2) and look up (pitch -0.6) to hit the building wall.
    run(sim, 1, () => intent({ swingHeld: true, yaw: Math.PI / 2, pitch: -0.6 }));
    expect(p.tether).not.toBeNull();
    expect(p.energy).toBeLessThanOrEqual(50 - hero.swing.attachCost);
    run(sim, 1, () => intent({ swingHeld: false }));
    expect(p.tether).toBeNull();
  });

  it('cannot attach without enough energy', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 3, z: 12 };
    p.energy = hero.swing.attachCost - 1;
    run(sim, 1, () => intent({ swingHeld: true, yaw: Math.PI / 2, pitch: -0.6 }));
    expect(p.tether).toBeNull();
  });

  it('reeling shortens the rope but never below the minimum length', () => {
    const sim = makeSim();
    const p = hang(sim, { x: 0, y: 40, z: -20 }, { x: 0, y: 60, z: 0 });
    const start = p.tether!.length;
    run(sim, 20, () => intent({ swingHeld: true, reelHeld: true }));
    expect(p.tether!.length).toBeLessThan(start);
    expect(p.tether!.length).toBeGreaterThanOrEqual(hero.swing.minLength);
  });

  it('auto-reels on attach so a ground start launches into the air', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    run(sim, 10, () => intent());
    p.pos = { x: 0, y: 0, z: -3 };
    const aim = { yaw: 0.5, pitch: -0.7 };
    run(sim, 1, () => intent({ swingHeld: true, ...aim }));
    expect(p.tether).not.toBeNull();
    const start = p.tether!.length;
    expect(p.tether!.targetLength).toBeLessThan(start);
    let maxY = 0;
    for (let i = 0; i < 45; i++) {
      sim.step(DT, new Map([['p1', intent({ swingHeld: true, ...aim })]]));
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(p.tether === null || p.tether.length <= p.tether.targetLength + 1e-6).toBe(true);
    expect(maxY).toBeGreaterThan(4);
  });

  it('releases the tether when a wall blocks the rope', () => {
    const sim = makeSim();
    // Building x:[7,17] z:[7,17]; anchor behind it, player in front.
    const p = hang(sim, { x: 0, y: 6, z: 12 }, { x: 20, y: 6, z: 12 });
    run(sim, 2, () => intent({ swingHeld: true }));
    expect(p.tether).toBeNull();
  });
});

describe('zip pull', () => {
  it('carries the player up and over a roof edge', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    run(sim, 10, () => intent());
    p.pos = { x: 0, y: 0, z: 12 };
    p.prevPos = { ...p.pos };
    // The building at x:[7,17], z:[7,17] is 18 m tall. Aim at its wall 1 m below the roof edge.
    const hand = handPos(p, hero);
    const target = { x: 7, y: 17, z: 12 };
    const len = dist(hand, target);
    const pitch = -Math.asin((target.y - hand.y) / len); // aimDir: y = -sin(pitch)
    const yaw = Math.PI / 2;
    run(sim, 1, () => intent({ zipPressed: true, yaw, pitch }));
    expect(p.zip).not.toBeNull();
    run(sim, 120, () => intent({ yaw, pitch }));
    expect(p.zip).toBeNull();
    expect(p.pos.y).toBeGreaterThan(17.9);
    expect(p.pos.x).toBeGreaterThan(7);
  });

  it('refuses to zip without enough energy', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 0, z: 12 };
    p.energy = hero.zip.cost - 1;
    run(sim, 1, () => intent({ zipPressed: true, yaw: Math.PI / 2, pitch: -0.6 }));
    expect(p.zip).toBeNull();
  });
});
