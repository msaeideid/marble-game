import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import { handPos } from '../src/sim/controller';
import { Sim, type SimEvent } from '../src/sim/sim';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, intent } from './helpers';

const bruiser = getHero('hero.bruiser');
const flyer = getHero('hero.flyer');
const carDef = content.props['prop.car']!;
const crateDef = content.props['prop.crate']!;
const thug = content.enemies['enemy.thug']!;

type Box = { kind: string; min: number[]; max: number[]; breakable?: number };

/** An open field with the given props and extra boxes; two heroes share it. Prop ids follow the order given. */
function world(props: { type: string; pos: number[] }[], boxes: Box[] = []): World {
  const level = arena as unknown as LevelData;
  return new World({ ...level, base: undefined, enemySpawns: [], props, colliders: [level.colliders[0]!, ...boxes] });
}

function duo(props: { type: string; pos: number[] }[], boxes: Box[] = []) {
  const sim = new Sim(world(props, boxes), bruiser, content.enemies, { waves: false, props: true, propDefs: content.props });
  const tank = sim.addPlayer('tank'); // RAMPART
  const jet = sim.addPlayer('jet', flyer); // METALHEAD
  tank.invulnerable = jet.invulnerable = 0;
  return { sim, tank, jet };
}

function dummy(sim: Sim, x: number, z: number) {
  const e = sim.spawnEnemy('enemy.thug', { x, y: 0.01, z });
  e.snaredTimer = 999;
  return e;
}

type Intents = Record<string, Partial<ReturnType<typeof intent>>>;

/** One tick with the given intents per player; returns the events of that tick. */
function tick(sim: Sim, who: Intents = {}): SimEvent[] {
  sim.step(DT, new Map(Object.entries(who).map(([id, i]) => [id, intent(i)])));
  return sim.events;
}
function ticks(sim: Sim, n: number, who: Intents = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...tick(sim, who));
  return all;
}

/** Aim a hero's hand at a point (yaw and pitch for the intent). */
function aimAt(sim: Sim, id: string, p: { x: number; y: number; z: number }) {
  const h = handPos(sim.players.get(id)!, sim.heroOf(id));
  const dx = p.x - h.x;
  const dy = p.y - h.y;
  const dz = p.z - h.z;
  return { yaw: Math.atan2(dx, dz), pitch: -Math.asin(dy / Math.hypot(dx, dy, dz)) };
}

const CAR = [{ type: 'prop.car', pos: [0, 0, 5] }];

/** RAMPART lifts the car and throws it +Z at a group of thugs; returns the sim ready to detonate mid-flight. */
function throwCarAtGroup() {
  const { sim, tank, jet } = duo(CAR);
  jet.pos = { x: 4, y: 0, z: 2 };
  tank.pos = { x: 0, y: 0, z: 3.6 };
  ticks(sim, 6);
  const group = [dummy(sim, 0, 12.5), dummy(sim, 1.6, 13), dummy(sim, -1.6, 13)];
  tick(sim, { tank: { grabPressed: true, yaw: 0 } });
  ticks(sim, Math.ceil(bruiser.lift!.cooldown / DT) + 1);
  expect(tank.carrying?.def).toBe('prop.car');
  const thrown = tick(sim, { tank: { grabPressed: true, yaw: 0, pitch: -0.1 } });
  expect(thrown.some((e) => e.type === 'throw')).toBe(true);
  return { sim, tank, jet, group };
}

/** Tick until the car is at least `z` metres along its flight (it has to still be in the air). */
function flyUntil(sim: Sim, z: number) {
  for (let i = 0; i < 40; i++) {
    const car = sim.propSystem!.props[0]!;
    if (car.mode === 'thrown' && car.pos.z >= z) return car;
    tick(sim);
  }
  throw new Error('the car never got there');
}

describe('the team-up combo: RAMPART throws a car, METALHEAD shoots it mid-air', () => {
  it('detonates over the group: big damage, stun, the car is gone, the combo is flagged', () => {
    const { sim, jet, tank, group } = throwCarAtGroup();
    const car = flyUntil(sim, 10.5);
    const e0 = jet.energy;
    const aim = aimAt(sim, 'jet', { x: car.pos.x, y: car.pos.y + carDef.size.height / 2, z: car.pos.z });
    const events = tick(sim, { jet: { fireHeld: true, ...aim } });
    const boom = events.find((e) => e.type === 'detonate');
    expect(boom && boom.type === 'detonate' && boom.combo).toBe(true);
    expect(boom && boom.type === 'detonate' && boom.owner).toBe('jet');
    expect(boom && boom.type === 'detonate' && boom.thrower).toBe('tank');
    expect(boom && boom.type === 'detonate' && boom.hits.sort()).toEqual(group.map((g) => g.id).sort());
    expect(jet.energy).toBeLessThan(e0); // the bolt cost a little energy like any other
    expect(sim.propSystem!.props[0]!.mode).toBe('destroyed');
    for (const g of group) {
      expect(g.health.core).toBeLessThan(thug.health.core.max - 25);
      expect(g.aiState === 'stagger' || g.defeatedTimer !== null).toBe(true);
    }
    // The blast is big enough to defeat at least the thug in the middle.
    expect(group.some((g) => g.defeatedTimer !== null)).toBe(true);
    expect(tank.health.shield + tank.health.core).toBe(bruiser.health.shield.max + bruiser.health.core.max); // no friendly fire
  });

  it('the thrown car alone is much weaker than the combo: that is the reward for teaming up', () => {
    const { sim, group } = throwCarAtGroup();
    ticks(sim, 60); // nobody shoots it; it lands and hits whoever it hits
    const left = group.reduce((a, g) => a + (g.defeatedTimer !== null ? 0 : g.health.core), 0);
    const total = group.length * thug.health.core.max;
    expect(total - left).toBeLessThan(carDef.throwDamage * 2 + 1);
    expect(carDef.detonation!.damage).toBeGreaterThan(carDef.throwDamage);
    expect(carDef.detonation!.radius).toBeGreaterThan(3);
  });

  it('the car respawns at home after exploding', () => {
    const { sim, jet } = throwCarAtGroup();
    const car = flyUntil(sim, 10);
    tick(sim, { jet: { fireHeld: true, ...aimAt(sim, 'jet', { x: car.pos.x, y: car.pos.y + 0.6, z: car.pos.z }) } });
    expect(sim.propSystem!.props[0]!.mode).toBe('destroyed');
    ticks(sim, Math.ceil(carDef.respawnTime / DT) + 2);
    const back = sim.propSystem!.props[0]!;
    expect(back.mode).toBe('resting');
    expect(back.pos).toEqual({ x: 0, y: 0, z: 5 });
    expect(jet.defeatedTimer).toBeNull();
  });
});

describe('what can and cannot be detonated', () => {
  it('a car sitting on the ground (not thrown) is not set off by a laser', () => {
    const { sim, jet } = duo(CAR);
    jet.pos = { x: 6, y: 0, z: 5 };
    ticks(sim, 6);
    const aim = aimAt(sim, 'jet', { x: 0, y: 0.7, z: 5 });
    const events = ticks(sim, 15, { jet: { fireHeld: true, ...aim } });
    expect(events.some((e) => e.type === 'detonate')).toBe(false);
    expect(sim.propSystem!.props[0]!.mode).toBe('resting');
  });

  it('a held car is not set off either', () => {
    const { sim, tank, jet } = duo(CAR);
    tank.pos = { x: 0, y: 0, z: 3.6 };
    jet.pos = { x: 6, y: 0, z: 3.6 };
    ticks(sim, 6);
    tick(sim, { tank: { grabPressed: true, yaw: 0 } });
    expect(tank.carrying).not.toBeNull();
    const events = ticks(sim, 10, { jet: { fireHeld: true, ...aimAt(sim, 'jet', { x: 0, y: 3, z: 3.6 }) } });
    expect(events.some((e) => e.type === 'detonate')).toBe(false);
  });

  it('crates are not volatile; cars and dumpsters are', () => {
    expect(crateDef.detonation).toBeUndefined();
    expect(carDef.detonation).toBeDefined();
    expect(content.props['prop.dumpster']!.detonation).toBeDefined();
    const { sim } = duo([{ type: 'prop.crate', pos: [0, 0, 5] }]);
    const crate = sim.propSystem!.props[0]!;
    crate.mode = 'thrown';
    expect(sim.propSystem!.volatileTargets()).toEqual([]);
    expect(sim.propSystem!.detonate(0)).toBeNull();
  });

  it('a rocket that bursts near a thrown car sets it off too', () => {
    const { sim, jet } = duo(CAR);
    jet.pos = { x: 0, y: 0, z: 0 };
    ticks(sim, 6);
    const car = sim.propSystem!.props[0]!;
    car.mode = 'thrown';
    car.pos = { x: 0, y: 3, z: 4 };
    car.vel = { x: 0, y: 0, z: 0 };
    const group = dummy(sim, 0, 4.5);
    const aim = aimAt(sim, 'jet', { x: 0, y: 3.65, z: 4 });
    const events = [...tick(sim, { jet: { rocketPressed: true, ...aim } })];
    for (let i = 0; i < 40 && !events.some((e) => e.type === 'detonate'); i++) events.push(...tick(sim));
    const boom = events.find((e) => e.type === 'detonate');
    expect(boom && boom.type === 'detonate' && boom.owner).toBe('jet');
    expect(group.health.core).toBeLessThan(thug.health.core.max);
  });

  it('the blast breaks walls up to the prop\'s break power and no stronger ones', () => {
    const boxes: Box[] = [
      { kind: 'wall', min: [3, 0, 12], max: [4, 4, 14], breakable: 2 }, // reinforced, within 4.2 m of the burst
      { kind: 'wall', min: [-4, 0, 12], max: [-3, 4, 14], breakable: 3 }, // beyond the car's break power
      { kind: 'wall', min: [30, 0, 12], max: [31, 4, 14], breakable: 1 }, // too far away
    ];
    const { sim, jet } = duo(CAR, boxes);
    jet.pos = { x: 0, y: 0, z: 0 };
    ticks(sim, 6);
    const car = sim.propSystem!.props[0]!;
    car.mode = 'thrown';
    car.pos = { x: 0, y: 5, z: 13 };
    car.vel = { x: 0, y: 0, z: 0 };
    const events = tick(sim, { jet: { fireHeld: true, ...aimAt(sim, 'jet', { x: 0, y: 5.65, z: 13 }) } });
    expect(events.some((e) => e.type === 'detonate')).toBe(true);
    const ids = sim.world.colliders.map((c, i) => [i, c.breakable] as const).filter(([, b]) => b !== undefined);
    const broken = ids.filter(([i]) => sim.world.broken.has(i)).map(([, b]) => b);
    expect(broken).toEqual([2]);
    expect(events.filter((e) => e.type === 'break').length).toBe(1);
  });

  it('enemies at the edge of the blast take less than the ones at the centre', () => {
    const { sim, jet } = duo(CAR);
    jet.pos = { x: 0, y: 0, z: 0 };
    ticks(sim, 6);
    const car = sim.propSystem!.props[0]!;
    car.mode = 'thrown';
    car.pos = { x: 0, y: 3, z: 10 };
    car.vel = { x: 0, y: 0, z: 0 };
    const centre = dummy(sim, 0, 10.2);
    const edge = dummy(sim, 3.6, 10);
    const outside = dummy(sim, 9, 10);
    tick(sim, { jet: { fireHeld: true, ...aimAt(sim, 'jet', { x: 0, y: 3.65, z: 10 }) } });
    const lost = (e: typeof centre) => thug.health.core.max - e.health.core;
    expect(lost(centre)).toBeGreaterThan(lost(edge));
    expect(lost(edge)).toBeGreaterThan(0);
    expect(lost(outside)).toBe(0);
  });
});

describe('two heroes in one world', () => {
  it('each player gets their own kit: only the flyer shoots, only RAMPART lifts', () => {
    const { sim, tank, jet } = duo(CAR);
    expect(sim.heroOf('tank').id).toBe('hero.bruiser');
    expect(sim.heroOf('jet').id).toBe('hero.flyer');
    tank.pos = { x: 0, y: 0, z: 3.6 };
    jet.pos = { x: 0, y: 0, z: 3.6 };
    ticks(sim, 6);
    dummy(sim, 0, 12);
    // Both press everything: the flyer cannot lift, RAMPART cannot shoot.
    const events = tick(sim, { tank: { grabPressed: true, fireHeld: true, rocketPressed: true }, jet: { grabPressed: true } });
    expect(tank.carrying).not.toBeNull();
    expect(jet.carrying).toBeNull();
    expect(events.some((e) => e.type === 'laser' || e.type === 'rocketLaunch')).toBe(false);
    expect(tick(sim, { jet: { rocketPressed: true } }).some((e) => e.type === 'rocketLaunch')).toBe(true);
  });

  it('a player added without a hero uses the sim default, and respawn keeps the right hero', () => {
    const { sim, jet } = duo(CAR);
    expect(sim.heroOf('nobody').id).toBe('hero.bruiser');
    sim.damagePlayer('jet', 999, null);
    expect(jet.defeatedTimer).not.toBeNull();
    ticks(sim, Math.ceil(flyer.respawnDelay / DT) + 2);
    expect(jet.defeatedTimer).toBeNull();
    expect(jet.energy).toBe(flyer.energy.max);
    expect(jet.health.core).toBe(flyer.health.core.max); // not RAMPART's 110
  });
});
