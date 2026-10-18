import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import type { Sim, SimEvent } from '../src/sim/sim';
import { Sim as SimClass } from '../src/sim/sim';
import { StrikeSystem, strikePoint, traceChain } from '../src/sim/weapons';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, intent, run } from './helpers';

const volt = getHero('hero.storm');
const metal = getHero('hero.flyer');
const chain = volt.chain!;
const tempest = volt.tempest!;
const thug = content.enemies['enemy.thug']!;

function field(boxes: { min: number[]; max: number[] }[] = []): World {
  const level = arena as unknown as LevelData;
  return new World({
    ...level,
    base: undefined,
    enemySpawns: [],
    props: [],
    colliders: [level.colliders[0]!, ...boxes.map((b) => ({ kind: 'building', min: b.min, max: b.max }))],
  });
}

function make(heroId = 'hero.storm', boxes: { min: number[]; max: number[] }[] = []) {
  const sim = new SimClass(field(boxes), getHero(heroId), content.enemies, { waves: false, props: false });
  const p = sim.addPlayer('p1');
  p.invulnerable = 0;
  run(sim, 6, () => intent());
  return { sim, p };
}

/** A thug held still by a snare so it does not walk or attack, but which can still be shocked. */
function dummy(sim: Sim, x: number, z: number) {
  const e = sim.spawnEnemy('enemy.thug', { x, y: 0.01, z });
  e.snaredTimer = 999;
  return e;
}

const eventsOf = (sim: Sim, ticks: number, make: () => ReturnType<typeof intent>): SimEvent[] => {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step(DT, new Map([['p1', make()]]));
    all.push(...sim.events);
  }
  return all;
};

const zap = () => intent({ chainPressed: true });

describe('VOLTAGE data', () => {
  it('has the storm kits, flies, and has no weapons or powers of the other heroes', () => {
    expect(volt.chain && volt.tempest && volt.flight).toBeTruthy();
    expect(volt.laser).toBeUndefined();
    expect(volt.rockets).toBeUndefined();
    expect(volt.charge).toBeUndefined();
    expect(metal.chain).toBeUndefined();
    expect(metal.tempest).toBeUndefined();
  });

  it('is a controller, not a damage dealer: far less single-target damage than METALHEAD, and a slower glide', () => {
    const voltDps = chain.damage / chain.cooldown;
    const metalDps = metal.laser!.damage / metal.laser!.fireInterval;
    expect(voltDps).toBeLessThan(metalDps / 3);
    expect(volt.flight!.speed).toBeLessThan(metal.flight!.speed);
    expect(volt.flight!.climbSpeed).toBeLessThan(metal.flight!.climbSpeed);
    // Its toughness sits between the glass cannon and the powerhouse.
    const total = (h: typeof volt) => h.health.shield.max + h.health.core.max;
    expect(total(volt)).toBeGreaterThan(total(metal));
    expect(total(volt)).toBeLessThan(total(getHero('hero.bruiser')));
  });

  it('a storm strike alone does not defeat a thug, and the stun outlasts the warning delay', () => {
    expect(tempest.damage).toBeLessThan(thug.health.core.max);
    expect(tempest.stunTime).toBeGreaterThan(thug.staggerTime * 2);
    expect(tempest.cooldown).toBeGreaterThan(tempest.delay + tempest.stunTime);
  });
});

describe('chain lightning', () => {
  it('hits the enemy under the crosshair then jumps to the neighbours, weaker each time, stunning all', () => {
    const { sim, p } = make();
    const a = dummy(sim, 0, 10);
    const b = dummy(sim, 3, 10); // 3 m from a: within the 5 m jump
    const c = dummy(sim, 6, 10);
    const far = dummy(sim, 20, 10); // out of every jump's reach
    const e0 = p.energy;
    const ev = eventsOf(sim, 1, zap).find((e) => e.type === 'chain');
    expect(ev && ev.type === 'chain' && ev.hits).toEqual([a.id, b.id, c.id]);
    expect(e0 - p.energy).toBeCloseTo(chain.cost, 3);
    const lost = (e: typeof a) => thug.health.core.max - e.health.core;
    expect(lost(a)).toBeCloseTo(chain.damage, 3);
    expect(lost(b)).toBeCloseTo(chain.damage * chain.damageFalloff, 3);
    expect(lost(c)).toBeCloseTo(chain.damage * chain.damageFalloff ** 2, 3);
    expect(lost(far)).toBe(0);
    for (const e of [a, b, c]) {
      expect(e.aiState).toBe('stagger');
      expect(e.aiTimer).toBeCloseTo(chain.stunTime, 3);
    }
    expect(far.aiState).not.toBe('stagger');
  });

  it('never hits more than maxTargets', () => {
    const { sim } = make();
    for (let i = 0; i < 7; i++) dummy(sim, i * 1.5 - 3, 10);
    const ev = eventsOf(sim, 1, zap).find((e) => e.type === 'chain');
    expect(ev && ev.type === 'chain' && ev.hits.length).toBe(chain.maxTargets);
  });

  it('with nobody to shock it costs nothing and does not start the cooldown', () => {
    const { sim, p } = make();
    const e0 = p.energy;
    expect(eventsOf(sim, 3, zap).some((e) => e.type === 'chain')).toBe(false);
    expect(p.energy).toBeGreaterThanOrEqual(e0);
    expect(p.chainCooldown).toBe(0);
  });

  it('has a cooldown and needs the energy', () => {
    const { sim, p } = make();
    dummy(sim, 0, 10);
    expect(eventsOf(sim, 1, zap).filter((e) => e.type === 'chain').length).toBe(1);
    expect(eventsOf(sim, 5, zap).filter((e) => e.type === 'chain').length).toBe(0);
    run(sim, Math.ceil(chain.cooldown / DT), () => intent());
    p.energy = chain.cost - 1;
    expect(eventsOf(sim, 1, zap).filter((e) => e.type === 'chain').length).toBe(0);
    p.energy = 100;
    expect(eventsOf(sim, 1, zap).filter((e) => e.type === 'chain').length).toBe(1);
  });

  it('cannot jump through walls, and cannot lock through one either', () => {
    const world = field([{ min: [1, 0, 8], max: [2, 5, 12] }]);
    const t = (id: string, x: number, z: number) => ({ id, pos: { x, y: 0, z }, halfWidth: 0.4, height: 1.8 });
    const a = t('a', 0, 10);
    const behind = t('b', 4, 10); // 4 m from a but with the wall between
    const out = traceChain(world, { x: 0, y: 1.45, z: 0 }, { x: 0, y: 0, z: 1 }, chain, [a, behind]);
    expect(out.hits.map((h) => h.id)).toEqual(['a']);
    const blocked = traceChain(field([{ min: [-3, 0, 4], max: [3, 5, 5] }]), { x: 0, y: 1.45, z: 0 }, { x: 0, y: 0, z: 1 }, chain, [a]);
    expect(blocked.hits).toEqual([]);
  });

  it('shocks a staggered-proof enemy too: the stun ignores poise', () => {
    const { sim } = make();
    const e = dummy(sim, 0, 10);
    e.poiseTimer = 5;
    eventsOf(sim, 1, zap);
    expect(e.aiState).toBe('stagger');
  });

  it('heroes without the kit cannot cast it', () => {
    const { sim, p } = make('hero.flyer');
    dummy(sim, 0, 10);
    const e0 = p.energy;
    expect(eventsOf(sim, 3, zap).some((e) => e.type === 'chain')).toBe(false);
    expect(p.energy).toBeGreaterThanOrEqual(e0);
  });
});

describe('storm strike', () => {
  it('lands after the warning delay, hurting and stunning everything inside the ring and nothing outside', () => {
    const { sim, p } = make();
    // Aim at the ground 10 m ahead: the hand is 1.45 m up.
    const pitch = Math.atan2(1.45, 10);
    const inside = dummy(sim, 0, 10);
    const edge = dummy(sim, 0, 10 + tempest.radius - 0.2);
    const outside = dummy(sim, 0, 10 + tempest.radius + 2);
    const e0 = p.energy;
    const start = eventsOf(sim, 1, () => intent({ stormPressed: true, pitch })).find((e) => e.type === 'strikeStart');
    expect(start && start.type === 'strikeStart' && Math.abs(start.pos.z - 10)).toBeLessThan(0.1);
    expect(e0 - p.energy).toBeCloseTo(tempest.cost, 3);
    // Nothing happens during the warning...
    const early = eventsOf(sim, Math.floor(tempest.delay / DT) - 3, () => intent());
    expect(early.some((e) => e.type === 'strikeHit')).toBe(false);
    expect(inside.health.core).toBe(thug.health.core.max);
    // ...then it lands.
    const late = eventsOf(sim, 6, () => intent());
    const hit = late.find((e) => e.type === 'strikeHit');
    expect(hit && hit.type === 'strikeHit' && hit.hits.sort()).toEqual([inside.id, edge.id].sort());
    expect(thug.health.core.max - inside.health.core).toBeCloseTo(tempest.damage, 3);
    expect(inside.aiState).toBe('stagger');
    expect(outside.health.core).toBe(thug.health.core.max);
    expect(sim.strikeSystem!.strikes.length).toBe(0);
  });

  it('can be dodged: an enemy that leaves the ring during the warning is spared', () => {
    const { sim } = make();
    const pitch = Math.atan2(1.45, 10);
    const e = dummy(sim, 0, 10);
    eventsOf(sim, 1, () => intent({ stormPressed: true, pitch }));
    run(sim, 5, () => intent());
    e.pos.z = 10 + tempest.radius + 3; // steps out
    const hit = eventsOf(sim, 40, () => intent()).find((ev) => ev.type === 'strikeHit');
    expect(hit && hit.type === 'strikeHit' && hit.hits).toEqual([]);
    expect(e.health.core).toBe(thug.health.core.max);
  });

  it('aimed at the sky it does nothing and costs nothing; it has a long cooldown', () => {
    const { sim, p } = make();
    const e0 = p.energy;
    expect(eventsOf(sim, 3, () => intent({ stormPressed: true, pitch: -1 })).some((e) => e.type === 'strikeStart')).toBe(false);
    expect(p.energy).toBeGreaterThanOrEqual(e0);
    const pitch = 0.3;
    expect(eventsOf(sim, 1, () => intent({ stormPressed: true, pitch })).filter((e) => e.type === 'strikeStart').length).toBe(1);
    expect(eventsOf(sim, 30, () => intent({ stormPressed: true, pitch })).filter((e) => e.type === 'strikeStart').length).toBe(0);
    expect(p.stormCooldown).toBeGreaterThan(5);
  });

  it('strikePoint finds the first surface under the aim, and StrikeSystem resolves strikes independently', () => {
    const world = field();
    const at = strikePoint(world, { x: 0, y: 1.45, z: 0 }, { x: 0, y: -0.2, z: 0.98 }, tempest);
    expect(at && Math.abs(at.y)).toBeLessThan(1e-6);
    expect(strikePoint(world, { x: 0, y: 1.45, z: 0 }, { x: 0, y: 1, z: 0 }, tempest)).toBeNull();
    const sys = new StrikeSystem(tempest);
    const shocked: string[] = [];
    const t = (id: string, x: number) => ({ id, pos: { x, y: 0, z: 0 }, halfWidth: 0.4, height: 1.8 });
    sys.call('p', { x: 0, y: 0, z: 0 });
    sys.call('p', { x: 20, y: 0, z: 0 });
    const hooks = { targets: () => [t('a', 0.5), t('b', 20.5), t('c', 10)], shock: (id: string) => void shocked.push(id) };
    sys.step(tempest.delay + 0.1, hooks);
    expect(shocked.sort()).toEqual(['a', 'b']);
  });

  it('heroes without the kit cannot call one', () => {
    const { sim } = make('hero.flyer');
    expect(sim.strikeSystem).toBeNull();
    expect(eventsOf(sim, 3, () => intent({ stormPressed: true, pitch: 0.3 })).some((e) => e.type === 'strikeStart')).toBe(false);
  });
});

describe('VOLTAGE glide', () => {
  it('takes off like METALHEAD but hovers more cheaply', () => {
    const { sim, p } = make();
    run(sim, 1, () => intent({ jumpPressed: true, jumpHeld: true }));
    run(sim, 8, () => intent());
    run(sim, 1, () => intent({ jumpPressed: true, jumpHeld: true }));
    expect(p.flying).toBe(true);
    run(sim, 20, () => intent());
    const e0 = p.energy;
    run(sim, 30, () => intent());
    expect(e0 - p.energy).toBeCloseTo(volt.flight!.hoverDrainPerSecond, 0);
  });
});
