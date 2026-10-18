import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import type { Sim, SimEvent } from '../src/sim/sim';
import { Sim as SimClass } from '../src/sim/sim';
import { pickLockTarget, traceLaser } from '../src/sim/weapons';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, hero as ziplash, intent, run } from './helpers';

const metal = getHero('hero.flyer');
const flight = metal.flight!;
const laser = metal.laser!;
const rockets = metal.rockets!;
const thug = content.enemies['enemy.thug']!;

/** An open field (just the ground) plus any extra boxes, so line of sight is whatever the test says it is. */
function field(boxes: { min: number[]; max: number[] }[] = []): World {
  const level: LevelData = {
    ...(arena as unknown as LevelData),
    base: undefined,
    enemySpawns: [],
    props: [],
    colliders: [
      (arena as unknown as LevelData).colliders[0]!,
      ...boxes.map((b) => ({ kind: 'building', min: b.min, max: b.max })),
    ],
  };
  return new World(level);
}

function make(heroId = 'hero.flyer', boxes: { min: number[]; max: number[] }[] = []) {
  const sim = new SimClass(field(boxes), getHero(heroId), content.enemies, { waves: false, props: false });
  const p = sim.addPlayer('p1');
  p.invulnerable = 0;
  run(sim, 6, () => intent()); // land
  return { sim, p };
}

/** A frozen thug (snared, so it neither walks nor attacks) standing at the given spot. */
function dummy(sim: Sim, x: number, z: number) {
  const e = sim.spawnEnemy('enemy.thug', { x, y: 0.01, z });
  e.snaredTimer = 999;
  return e;
}

const press = () => intent({ jumpPressed: true, jumpHeld: true });

function takeOff(sim: Sim) {
  run(sim, 1, press); // a normal jump...
  run(sim, 8, () => intent());
  run(sim, 1, press); // ...and a second press in the air lights the jets
}

const eventsOf = (sim: Sim, ticks: number, make: () => ReturnType<typeof intent>): SimEvent[] => {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step(DT, new Map([['p1', make()]]));
    all.push(...sim.events);
  }
  return all;
};

describe('METALHEAD data', () => {
  it('has the flyer kits and nothing of the other heroes', () => {
    expect(metal.flight).toBeDefined();
    expect(metal.laser).toBeDefined();
    expect(metal.rockets).toBeDefined();
    expect(metal.swing).toBeUndefined();
    expect(metal.charge).toBeUndefined();
    expect(metal.lift).toBeUndefined();
    expect(ziplash.flight).toBeUndefined();
    expect(ziplash.laser).toBeUndefined();
  });

  it('is the most fragile hero and its melee is the weakest: air power is paid for', () => {
    const total = (h: typeof metal) => h.health.shield.max + h.health.core.max;
    const combo = (h: typeof metal) => h.melee.steps.reduce((a, s) => a + s.damage, 0);
    for (const id of ['hero.swinger', 'hero.bruiser']) {
      const other = getHero(id);
      expect(total(metal)).toBeLessThan(total(other));
      expect(combo(metal)).toBeLessThan(combo(other));
    }
  });

  it('flying, shooting and rockets all draw on the one energy pool, so a full tank cannot do everything', () => {
    // Hover and fire at once: both drain the same bar, and the bar is empty within about eight seconds.
    const perSecond = flight.hoverDrainPerSecond + laser.shotCost / laser.fireInterval;
    expect(metal.energy.max / perSecond).toBeLessThan(8);
    expect(metal.energy.max / perSecond).toBeGreaterThan(3);
  });
});

describe('jet flight', () => {
  it('a second jump press in the air lights the jets; a press on the ground is just a jump', () => {
    const { sim, p } = make();
    run(sim, 1, press);
    expect(p.flying).toBe(false);
    expect(p.vel.y).toBeGreaterThan(5);
    run(sim, 8, () => intent());
    expect(p.grounded).toBe(false);
    const before = p.energy;
    run(sim, 1, press);
    expect(p.flying).toBe(true);
    expect(p.energy).toBeLessThanOrEqual(before - flight.startCost);
  });

  it('hovers without falling and pays the hover cost per second', () => {
    const { sim, p } = make();
    takeOff(sim);
    run(sim, 20, () => intent()); // let the jump's leftover climb settle
    const y0 = p.pos.y;
    const e0 = p.energy;
    run(sim, 30, () => intent());
    expect(p.flying).toBe(true);
    expect(Math.abs(p.pos.y - y0)).toBeLessThan(0.05);
    expect(e0 - p.energy).toBeCloseTo(flight.hoverDrainPerSecond * 1, 0);
  });

  it('holding jump climbs, holding descend drops, and touching the ground ends the flight', () => {
    const { sim, p } = make();
    takeOff(sim);
    const y0 = p.pos.y;
    run(sim, 30, () => intent({ jumpHeld: true }));
    expect(p.pos.y - y0).toBeGreaterThan(5);
    expect(p.vel.y).toBeCloseTo(flight.climbSpeed, 0);
    run(sim, 10, () => intent());
    for (let i = 0; i < 400 && p.flying; i++) sim.step(DT, new Map([['p1', intent({ descendHeld: true })]]));
    expect(p.flying).toBe(false);
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeCloseTo(0, 1);
  });

  it('cruises at flight speed in the direction of the stick', () => {
    const { sim, p } = make();
    takeOff(sim);
    run(sim, 30, () => intent({ moveZ: 1 }));
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeCloseTo(flight.speed, 0);
    expect(p.pos.z).toBeGreaterThan(3);
  });

  it('does not regenerate energy while the jets are on', () => {
    const { sim, p } = make();
    takeOff(sim);
    let last = p.energy;
    for (let i = 0; i < 90; i++) {
      sim.step(DT, new Map([['p1', intent()]]));
      expect(p.energy).toBeLessThanOrEqual(last + 1e-9);
      last = p.energy;
    }
  });

  it('running out of energy cuts the jets and the hero falls; too little energy cannot relight them', () => {
    const { sim, p } = make();
    takeOff(sim);
    run(sim, 40, () => intent({ jumpHeld: true })); // get some height
    p.energy = 0.05;
    run(sim, 1, () => intent());
    expect(p.flying).toBe(false);
    const vyAtCutoff = p.vel.y;
    run(sim, 3, () => intent());
    expect(p.vel.y).toBeLessThan(vyAtCutoff - 2); // gravity is back
    p.energy = flight.startCost - 1;
    run(sim, 1, press);
    expect(p.flying).toBe(false);
    p.energy = flight.startCost + 20;
    run(sim, 1, press);
    expect(p.flying).toBe(true);
  });

  it('a defeated flyer stops flying', () => {
    const { sim, p } = make();
    takeOff(sim);
    sim.damagePlayer('p1', 999, null);
    expect(p.flying).toBe(false);
  });

  it('heroes without the kit cannot fly: ZIPLASH pressing jump in the air just does nothing', () => {
    const { sim, p } = make('hero.swinger');
    run(sim, 1, press);
    run(sim, 8, () => intent());
    const before = p.energy;
    run(sim, 1, press);
    expect(p.flying).toBe(false);
    expect(p.energy).toBeCloseTo(before, 6);
  });
});

describe('pulse laser', () => {
  it('fires a bolt every interval while held, each costing a little energy, and wears an enemy down', () => {
    const { sim, p } = make();
    const e = dummy(sim, 0, 10);
    const e0 = p.energy;
    const events = eventsOf(sim, 30, () => intent({ fireHeld: true }));
    const bolts = events.filter((ev) => ev.type === 'laser');
    expect(bolts.length).toBe(Math.ceil(1 / laser.fireInterval));
    expect(e0 - p.energy).toBeCloseTo(bolts.length * laser.shotCost, 3);
    const hp = e.health.core + e.health.shield;
    expect(hp).toBeCloseTo(thug.health.core.max - bolts.length * laser.damage, 3);
    expect(bolts.every((b) => b.type === 'laser' && b.hit === e.id)).toBe(true);
  });

  it('does nothing unless the button is held, and stops when the energy is gone', () => {
    const { sim, p } = make();
    const e = dummy(sim, 0, 10);
    expect(eventsOf(sim, 20, () => intent()).some((ev) => ev.type === 'laser')).toBe(false);
    p.energy = laser.shotCost * 2 - 0.1;
    p.energyDelay = 5; // nothing trickles back in while we count the shots
    const bolts = eventsOf(sim, 25, () => intent({ fireHeld: true })).filter((ev) => ev.type === 'laser');
    expect(bolts.length).toBe(1);
    expect(e.health.core).toBeCloseTo(thug.health.core.max - laser.damage, 3);
  });

  it('is stopped by walls and by missing', () => {
    const { sim } = make('hero.flyer', [{ min: [-2, 0, 4], max: [2, 6, 5] }]);
    const e = dummy(sim, 0, 10);
    const behind = eventsOf(sim, 20, () => intent({ fireHeld: true })).filter((ev) => ev.type === 'laser');
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((b) => b.type === 'laser' && b.hit === null && b.to.z < 4.1)).toBe(true);
    expect(e.health.core).toBe(thug.health.core.max);

    const open = make();
    const e2 = dummy(open.sim, 0, 10);
    eventsOf(open.sim, 20, () => intent({ fireHeld: true, yaw: 0.6 })); // well off to the side
    expect(e2.health.core).toBe(thug.health.core.max);
  });

  it('does not stagger: a steady beam wears enemies down while they keep coming', () => {
    const { sim } = make();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 22 });
    let staggered = false;
    for (let i = 0; i < 40; i++) {
      sim.step(DT, new Map([['p1', intent({ fireHeld: true })]]));
      if (e.aiState === 'stagger') staggered = true;
    }
    expect(staggered).toBe(false);
    expect(e.health.core).toBeLessThan(thug.health.core.max);
    expect(e.pos.z).toBeLessThan(22); // it advanced
  });

  it('heroes without the laser cannot fire', () => {
    const { sim, p } = make('hero.swinger');
    const e = dummy(sim, 0, 10);
    const e0 = p.energy;
    expect(eventsOf(sim, 20, () => intent({ fireHeld: true })).some((ev) => ev.type === 'laser')).toBe(false);
    expect(p.energy).toBeGreaterThanOrEqual(e0);
    expect(e.health.core).toBe(thug.health.core.max);
  });

  it('traceLaser reports the nearest enemy on the line, and the end of the range when nothing is there', () => {
    const world = field();
    const near = { id: 'a', pos: { x: 0, y: 0, z: 8 }, halfWidth: 0.4, height: 1.8 };
    const far = { id: 'b', pos: { x: 0, y: 0, z: 14 }, halfWidth: 0.4, height: 1.8 };
    const hit = traceLaser(world, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: 1 }, laser, [far, near]);
    expect(hit.hit?.id).toBe('a');
    expect(hit.end.z).toBeGreaterThan(7);
    expect(hit.end.z).toBeLessThan(9);
    const none = traceLaser(world, { x: 0, y: 1.2, z: 0 }, { x: 1, y: 0, z: 0 }, laser, [near, far]);
    expect(none.hit).toBeNull();
    expect(none.end.x).toBeCloseTo(laser.range, 3);
  });
});

describe('homing rockets', () => {
  const fire = () => intent({ rocketPressed: true });

  function explosions(events: SimEvent[]) {
    return events.filter((e): e is Extract<SimEvent, { type: 'explosion' }> => e.type === 'explosion');
  }

  it('locks the enemy nearest the crosshair and curves to hit it even when it is off to the side', () => {
    const { sim } = make();
    const target = dummy(sim, 3.5, 13); // ~15 degrees off the line of fire: inside the lock cone
    const events = [...eventsOf(sim, 1, fire), ...eventsOf(sim, 90, () => intent())];
    const launch = events.find((e) => e.type === 'rocketLaunch');
    expect(launch && launch.type === 'rocketLaunch' && launch.locked).toBe(target.id);
    const boom = explosions(events);
    expect(boom.length).toBe(1);
    expect(boom[0]!.hits).toContain(target.id);
    // It really did turn: a straight shot along +Z would have passed 3.5 m to the side.
    expect(Math.hypot(boom[0]!.pos.x - 3.5, boom[0]!.pos.z - 13)).toBeLessThan(1.6);
    expect(target.health.core).toBeLessThan(thug.health.core.max - 20);
  });

  it('without a lock it flies straight and bursts on the ground or a wall', () => {
    const { sim } = make('hero.flyer', [{ min: [-5, 0, 8], max: [5, 6, 9] }]);
    const far = dummy(sim, 12, 20); // outside the lock cone
    const events = [...eventsOf(sim, 1, fire), ...eventsOf(sim, 90, () => intent())];
    const launch = events.find((e) => e.type === 'rocketLaunch');
    expect(launch && launch.type === 'rocketLaunch' && launch.locked).toBeNull();
    const boom = explosions(events);
    expect(boom.length).toBe(1);
    expect(boom[0]!.pos.z).toBeLessThan(8.2); // burst on the wall's face
    expect(boom[0]!.hits).toEqual([]);
    expect(far.health.core).toBe(thug.health.core.max);
    expect(sim.rocketSystem!.rockets.length).toBe(0);
  });

  it('the blast hurts neighbours less than the centre, spares the far, and always staggers survivors', () => {
    const { sim } = make();
    const centre = dummy(sim, 0, 12);
    const side = dummy(sim, 2, 12);
    const far = dummy(sim, -9, 12);
    const events = [...eventsOf(sim, 1, fire), ...eventsOf(sim, 60, () => intent())];
    expect(explosions(events).length).toBe(1);
    const lost = (e: typeof centre) => thug.health.core.max - e.health.core;
    expect(lost(centre)).toBeGreaterThan(lost(side));
    expect(lost(side)).toBeGreaterThan(0);
    expect(lost(far)).toBe(0);
    expect(lost(centre)).toBeLessThanOrEqual(rockets.damage);
    expect(lost(side)).toBeGreaterThanOrEqual(rockets.damage * rockets.edgeFalloff - 0.001);
  });

  it('costs energy, waits out its cooldown, and cannot launch on an empty tank', () => {
    const { sim, p } = make();
    const e0 = p.energy;
    const events = eventsOf(sim, 1, fire);
    expect(events.filter((e) => e.type === 'rocketLaunch').length).toBe(1);
    expect(e0 - p.energy).toBeCloseTo(rockets.cost, 6);
    // Pressed again straight away: still on cooldown.
    expect(eventsOf(sim, 3, fire).filter((e) => e.type === 'rocketLaunch').length).toBe(0);
    run(sim, Math.ceil(rockets.cooldown / DT), () => intent());
    expect(eventsOf(sim, 1, fire).filter((e) => e.type === 'rocketLaunch').length).toBe(1);
    run(sim, Math.ceil(rockets.cooldown / DT) + 1, () => intent());
    p.energy = rockets.cost - 1;
    expect(eventsOf(sim, 1, fire).filter((e) => e.type === 'rocketLaunch').length).toBe(0);
  });

  it('heroes without the rocket kit cannot launch one', () => {
    const { sim } = make('hero.bruiser');
    expect(sim.rocketSystem).toBeNull();
    expect(eventsOf(sim, 5, fire).some((e) => e.type === 'rocketLaunch')).toBe(false);
  });

  it('lock-on needs a clear line of sight and picks the enemy closest to the crosshair', () => {
    const open = field();
    const walled = field([{ min: [-6, 0, 5], max: [6, 5, 6] }]);
    const a = { id: 'a', pos: { x: 1, y: 0, z: 15 }, halfWidth: 0.4, height: 1.8 };
    const b = { id: 'b', pos: { x: -4, y: 0, z: 15 }, halfWidth: 0.4, height: 1.8 };
    const origin = { x: 0, y: 1.5, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    expect(pickLockTarget(open, origin, dir, rockets, [b, a])?.id).toBe('a');
    expect(pickLockTarget(walled, origin, dir, rockets, [a, b])).toBeNull();
    expect(pickLockTarget(open, origin, { x: 1, y: 0, z: 0 }, rockets, [a, b])).toBeNull();
  });
});
