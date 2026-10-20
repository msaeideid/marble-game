import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import { phaseFor } from '../src/sim/boss';
import { Sim, type SimEvent } from '../src/sim/sim';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, intent } from './helpers';

const defs = content.enemies;
const bosses = Object.values(defs).filter((d) => d.boss);

function field(): World {
  const level = arena as unknown as LevelData;
  return new World({ ...level, base: undefined, enemySpawns: [], props: [], colliders: [level.colliders[0]!] });
}

function duel(bossId = 'boss.vastor', bossAt = { x: 0, z: 14 }, heroId = 'hero.bruiser') {
  const sim = new Sim(field(), getHero(heroId), defs, { waves: false, props: true, propDefs: content.props });
  const me = sim.addPlayer('p1');
  me.invulnerable = 0;
  for (let i = 0; i < 6; i++) sim.step(DT, new Map());
  const boss = sim.spawnEnemy(bossId, { x: bossAt.x, y: 0.01, z: bossAt.z });
  const log: SimEvent[] = [];
  const tick = (n = 1, i: Partial<ReturnType<typeof intent>> = {}) => {
    for (let k = 0; k < n; k++) {
      sim.step(DT, new Map([['p1', intent(i)]]));
      log.push(...sim.events);
    }
  };
  return { sim, me, boss, tick, log };
}

const of = <T extends SimEvent['type']>(log: SimEvent[], type: T) => log.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

describe('boss data', () => {
  it('there are four bosses: three mini-bosses and VASTOR', () => {
    expect(bosses.map((b) => b.id).sort()).toEqual(['boss.big_batch', 'boss.clockwork_duchess', 'boss.gale_warden', 'boss.vastor']);
  });

  it('every boss has phases from full health downward, complete attacks, armor, resistances and a reward', () => {
    for (const b of bosses) {
      const phases = b.boss!.phases;
      expect(phases[0]!.fromFraction, b.id).toBe(1);
      for (let i = 1; i < phases.length; i++) expect(phases[i]!.fromFraction, b.id).toBeLessThan(phases[i - 1]!.fromFraction);
      for (const ph of phases) {
        for (const a of ph.attacks) {
          if (a.kind === 'slam') expect([a.range, a.radius, a.damage], `${b.id} slam`).not.toContain(undefined);
          if (a.kind === 'charge') expect([a.speed, a.duration, a.damage], `${b.id} charge`).not.toContain(undefined);
          if (a.kind === 'summon') {
            expect(defs[a.enemy ?? ''], `${b.id} summons ${a.enemy}`).toBeDefined();
            expect(a.count).toBeGreaterThan(0);
          }
        }
      }
      expect(b.armor, b.id).toBeGreaterThan(0);
      expect(b.resist?.stun, b.id).toBeLessThan(1);
      expect(b.reward?.scrap, b.id).toBeGreaterThan(50);
    }
  });

  it('VASTOR is the toughest, the finale and the first fight use the same body', () => {
    const hp = (id: string) => defs[id]!.health.core.max;
    expect(hp('boss.vastor')).toBeGreaterThan(Math.max(hp('boss.big_batch'), hp('boss.gale_warden'), hp('boss.clockwork_duchess')));
    expect(defs['boss.vastor']!.armor).toBeGreaterThan(defs['boss.big_batch']!.armor!);
  });

  it('phases follow the health fraction', () => {
    const v = defs['boss.vastor']!;
    expect([1, 0.7, 0.65, 0.5, 0.35, 0.2].map((f) => phaseFor(v, f))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('armor and resistance', () => {
  it('armor takes a flat amount off each hit, never more than 80%, so light attacks barely scratch', () => {
    const { sim, boss } = duel('boss.vastor');
    const armor = defs['boss.vastor']!.armor!;
    const before = boss.health.core;
    sim.damageEnemy(boss, 35, 'p1'); // a rocket
    expect(before - boss.health.core).toBeCloseTo(35 - armor, 6);
    const b2 = boss.health.core;
    sim.damageEnemy(boss, 5, 'p1'); // one laser bolt: 5 - 5 = 0, so the 20% floor
    expect(b2 - boss.health.core).toBeCloseTo(1, 6);
    const thug = sim.spawnEnemy('enemy.thug', { x: 3, y: 0.01, z: 3 });
    sim.damageEnemy(thug, 5, 'p1');
    expect(thug.health.core).toBe(40); // unarmored enemies take it all
  });

  it('stuns and snares are shortened, hits barely shove it, and hits cannot stagger it', () => {
    const { sim, boss } = duel('boss.big_batch');
    const r = defs['boss.big_batch']!.resist!;
    sim.players.get('p1')!.stormCooldown = 0;
    (sim as unknown as { stun(e: typeof boss, s: number): void }).stun(boss, 2);
    expect(boss.aiTimer).toBeCloseTo(2 * r.stun!, 6);
    boss.aiState = 'chase';
    boss.aiTimer = 0;
    const vx = boss.vel.x;
    (sim as unknown as { shove(e: typeof boss, dx: number, dz: number): void }).shove(boss, 10, 0);
    expect(boss.vel.x - vx).toBeCloseTo(10 * r.knockback!, 6);
    sim.damageEnemy(boss, 30, 'p1');
    expect(boss.aiState).not.toBe('stagger'); // poise: hits never interrupt a boss
  });
});

describe('boss attacks', () => {
  it('a slam is telegraphed first, then hits everyone inside the ring and nobody outside', () => {
    const { sim, boss, tick, log } = duel('boss.vastor', { x: 0, z: 5 });
    const ally = sim.addPlayer('p2');
    ally.invulnerable = 0;
    ally.pos = { x: 30, y: 0.01, z: 30 }; // far away, outside any ring
    tick(40);
    const tele = of(log, 'bossTelegraph').find((e) => e.kind === 'slam');
    const strike = of(log, 'bossStrike').find((e) => e.kind === 'slam');
    expect(tele, 'no telegraph').toBeDefined();
    expect(strike, 'no strike').toBeDefined();
    expect(strike!.hits).toEqual(['p1']);
    const slam = defs['boss.vastor']!.boss!.phases[0]!.attacks.find((a) => a.kind === 'slam')!;
    expect(tele!.delay).toBe(slam.windup);
    expect(tele!.radius).toBe(slam.radius);
    expect(log.indexOf(tele!)).toBeLessThan(log.indexOf(strike!));
    expect(sim.players.get('p1')!.health.shield).toBeLessThan(getHero('hero.bruiser').health.shield.max); // hurt
    expect(ally.health.shield).toBe(getHero('hero.bruiser').health.shield.max); // untouched
    expect(boss.boss!.cooldowns['0:0']).toBeGreaterThan(0);
  });

  it('a boss does not strike the instant it is telegraphed: the player has the whole windup to get out', () => {
    const { me, tick, log } = duel('boss.vastor', { x: 0, z: 5 });
    tick(3);
    const tele = of(log, 'bossTelegraph')[0]!;
    // Step out of the ring (radius 6.5) during the windup.
    me.pos = { x: 20, y: 0.01, z: 5 };
    tick(Math.ceil(tele.delay / DT) + 4);
    expect(of(log, 'bossStrike').find((e) => e.kind === 'slam')?.hits).toEqual([]);
    expect(me.health.shield).toBe(getHero('hero.bruiser').health.shield.max);
  });

  it('summons call minions, up to a cap', () => {
    const { sim, boss, tick } = duel('boss.big_batch', { x: 0, z: 30 }); // too far for a slam: it summons
    tick(200);
    const thugs = [...sim.enemies.values()].filter((e) => e.typeId === 'enemy.thug');
    expect(thugs.length).toBeGreaterThanOrEqual(2);
    const cap = defs['boss.big_batch']!.boss!.phases[0]!.attacks.find((a) => a.kind === 'summon')!.count! * 2;
    expect(thugs.length).toBeLessThanOrEqual(cap + 2); // (it can top up as they fall, but never floods)
    void boss;
  });

  it('a charge rushes at the player from a distance and hurts them once', () => {
    const { sim, me, boss, tick, log } = duel('boss.gale_warden', { x: 0, z: 14 });
    tick(120);
    const strikes = of(log, 'bossStrike').filter((e) => e.kind === 'charge');
    expect(of(log, 'bossTelegraph').some((e) => e.kind === 'charge')).toBe(true);
    expect(strikes.length).toBeGreaterThanOrEqual(1);
    expect(strikes[0]!.hits).toEqual(['p1']);
    // One charge hits a given player once, however long it lasts.
    const firstCharge = strikes.filter((s) => Math.hypot(s.pos.x - strikes[0]!.pos.x, s.pos.z - strikes[0]!.pos.z) < 12);
    expect(firstCharge.length).toBe(1);
    expect(me.health.shield).toBeLessThan(getHero('hero.bruiser').health.shield.max);
    void sim;
    void boss;
  });

  it('phases change as it takes damage, with a phase event, and new attacks appear', () => {
    const { sim, boss, tick, log } = duel('boss.vastor', { x: 0, z: 30 });
    tick(2);
    expect(boss.boss!.phase).toBe(0);
    boss.health.core = 800 * 0.6; // below 65%
    tick(2);
    expect(boss.boss!.phase).toBe(1);
    expect(of(log, 'bossPhase').map((e) => e.phase)).toEqual([1]);
    boss.health.core = 800 * 0.3;
    tick(2);
    expect(of(log, 'bossPhase').map((e) => e.phase)).toEqual([1, 2]);
    expect(sim.enemyDefs['boss.vastor']!.boss!.phases[1]!.attacks.some((a) => a.kind === 'charge')).toBe(true);
  });

  it('snared bosses stand still for a short while, and a defeated boss does nothing', () => {
    const { sim, boss, tick, log } = duel('boss.vastor', { x: 0, z: 5 });
    boss.snaredTimer = 1;
    tick(20);
    expect(of(log, 'bossTelegraph').length).toBe(0);
    sim.damageEnemy(boss, 9999, 'p1');
    expect(boss.defeatedTimer).not.toBeNull();
    const n = log.length;
    tick(20);
    expect(of(log.slice(n), 'bossTelegraph').length).toBe(0);
  });
});
