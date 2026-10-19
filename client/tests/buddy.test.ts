import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import { BuddyBrain } from '../src/sim/buddy';
import { Sim, type SimEvent } from '../src/sim/sim';
import { World, type LevelData } from '../src/sim/world';
import { content, DT } from './helpers';

const thug = content.enemies['enemy.thug']!;

function arenaOf(props: { type: string; pos: number[] }[]): World {
  const level = arena as unknown as LevelData;
  return new World({ ...level, base: undefined, enemySpawns: [], props, colliders: [level.colliders[0]!] });
}

function team(heroes: Record<string, string>, props: { type: string; pos: number[] }[] = []) {
  const first = Object.values(heroes)[0]!;
  const sim = new Sim(arenaOf(props), getHero(first), content.enemies, { waves: false, props: true, propDefs: content.props });
  for (const [id, hero] of Object.entries(heroes)) sim.addPlayer(id, getHero(hero)).invulnerable = 0;
  return sim;
}

function frozen(sim: Sim, x: number, z: number) {
  const e = sim.spawnEnemy('enemy.thug', { x, y: 0.01, z });
  e.snaredTimer = 999;
  return e;
}

/** Run the AI brains for the given players until `done` or the tick limit; returns every event. */
function play(sim: Sim, brains: BuddyBrain[], limit: number, done: (e: SimEvent[]) => boolean = () => false): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < limit; i++) {
    sim.step(DT, new Map(brains.map((b) => [b.id, b.think(sim)])));
    all.push(...sim.events);
    if (done(all)) break;
  }
  return all;
}

const CARS = [
  { type: 'prop.car', pos: [-4, 0, 4] },
  { type: 'prop.car', pos: [4, 0, 4] },
];

describe('AI teammate', () => {
  it('two AI teammates pull off the team-up combo on their own: RAMPART throws a car, METALHEAD shoots it', () => {
    const sim = team({ tank: 'hero.bruiser', jet: 'hero.flyer' }, CARS);
    const group = [frozen(sim, 0, 16), frozen(sim, 1.6, 16.5), frozen(sim, -1.6, 16.5)];
    const events = play(sim, [new BuddyBrain('tank', 'jet'), new BuddyBrain('jet', 'tank')], 600, (e) => e.some((x) => x.type === 'detonate'));
    const boom = events.find((e) => e.type === 'detonate');
    expect(boom, 'no detonation happened').toBeDefined();
    expect(boom!.type === 'detonate' && boom!.combo).toBe(true);
    expect(boom!.type === 'detonate' && boom!.owner).toBe('jet');
    expect(boom!.type === 'detonate' && boom!.thrower).toBe('tank');
    expect(boom!.type === 'detonate' && boom!.hits.length).toBeGreaterThanOrEqual(2);
    expect(group.reduce((a, g) => a + (g.defeatedTimer !== null ? thug.health.core.max : thug.health.core.max - g.health.core), 0)).toBeGreaterThan(80);
  });

  it('a shooter teammate sets off a car the human throws, and does nothing to a car on the ground', () => {
    const sim = team({ tank: 'hero.bruiser', jet: 'hero.flyer' }, [{ type: 'prop.car', pos: [0, 0, 5] }]);
    const tank = sim.players.get('tank')!;
    tank.pos = { x: 0, y: 0, z: 3.6 };
    sim.players.get('jet')!.pos = { x: 4, y: 0, z: 2 };
    for (let i = 0; i < 6; i++) sim.step(DT, new Map());
    frozen(sim, 0, 12.5);
    frozen(sim, 1.6, 13);
    const brain = new BuddyBrain('jet', 'tank');
    // Nothing is thrown yet: the car stays put however long the buddy looks at it.
    expect(play(sim, [brain], 40).some((e) => e.type === 'detonate')).toBe(false);
    // The human lifts and throws it.
    sim.step(DT, new Map([['tank', { ...blank(), grabPressed: true }]]));
    for (let i = 0; i < 20; i++) sim.step(DT, new Map());
    sim.step(DT, new Map([['tank', { ...blank(), grabPressed: true, pitch: -0.1 }]]));
    const events = play(sim, [brain], 40);
    expect(events.some((e) => e.type === 'detonate')).toBe(true);
  });

  it('follows the player when left behind', () => {
    const sim = team({ lead: 'hero.swinger', pal: 'hero.bruiser' });
    for (let i = 0; i < 6; i++) sim.step(DT, new Map());
    sim.players.get('lead')!.pos = { x: 30, y: 0, z: 30 };
    const brain = new BuddyBrain('pal', 'lead');
    play(sim, [brain], 300);
    const pal = sim.players.get('pal')!;
    expect(Math.hypot(pal.pos.x - 30, pal.pos.z - 30)).toBeLessThan(7);
  });

  it('a melee teammate walks up to an enemy and hits it', () => {
    const sim = team({ lead: 'hero.flyer', pal: 'hero.swinger' });
    const e = frozen(sim, 8, 8);
    for (let i = 0; i < 6; i++) sim.step(DT, new Map());
    play(sim, [new BuddyBrain('pal', 'lead')], 200);
    expect(e.health.core).toBeLessThan(thug.health.core.max);
  });

  it('a laser teammate shoots enemies it can see, and a storm-caller shocks them', () => {
    const sim = team({ lead: 'hero.bruiser', gun: 'hero.flyer', zap: 'hero.storm' });
    const e = frozen(sim, 0, 14);
    for (let i = 0; i < 6; i++) sim.step(DT, new Map());
    const events = play(sim, [new BuddyBrain('gun', 'lead'), new BuddyBrain('zap', 'lead')], 120);
    expect(events.some((x) => x.type === 'laser')).toBe(true);
    expect(events.some((x) => x.type === 'chain')).toBe(true);
    expect(e.health.core).toBeLessThan(thug.health.core.max);
  });

  it('a defeated teammate does nothing', () => {
    const sim = team({ lead: 'hero.bruiser', pal: 'hero.flyer' });
    frozen(sim, 0, 10);
    sim.damagePlayer('pal', 999, null);
    const intent = new BuddyBrain('pal', 'lead').think(sim);
    expect(intent.fireHeld || intent.moveZ !== 0 || intent.rocketPressed).toBe(false);
  });
});

function blank() {
  return new BuddyBrain('nobody', 'nobody').think(new Sim(arenaOf([]), getHero('hero.swinger'), content.enemies));
}
