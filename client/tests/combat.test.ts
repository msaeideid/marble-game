import { describe, expect, it } from 'vitest';
import { applyDamage, createHealth, regenHealth } from '../src/sim/health';
import { content, DT, hero, intent, makeSim, run } from './helpers';

const thugDef = content.enemies['enemy.thug']!;

describe('health: shield over core', () => {
  it('the shield absorbs damage first and overflow hits the core', () => {
    const h = createHealth(hero.health);
    const r = applyDamage(h, hero.health.shield.max + 5, hero.health);
    expect(r.shieldLost).toBe(hero.health.shield.max);
    expect(r.coreLost).toBe(5);
    expect(h.shield).toBe(0);
    expect(h.core).toBe(hero.health.core.max - 5);
    expect(r.defeated).toBe(false);
  });

  it('is defeated when the core reaches zero and never goes negative', () => {
    const h = createHealth(hero.health);
    const r = applyDamage(h, 10_000, hero.health);
    expect(r.defeated).toBe(true);
    expect(h.core).toBe(0);
    expect(h.shield).toBe(0);
  });

  it('shield regenerates after its delay, core regenerates slower and later', () => {
    const h = createHealth(hero.health);
    applyDamage(h, hero.health.shield.max + 10, hero.health);
    const coreAfterHit = h.core;
    // Before the shield delay elapses nothing regenerates.
    for (let i = 0; i < 60; i++) regenHealth(h, hero.health, DT); // 2 s
    expect(h.shield).toBe(0);
    for (let i = 0; i < 90; i++) regenHealth(h, hero.health, DT); // +3 s = 5 s total
    expect(h.shield).toBeGreaterThan(0);
    expect(h.core).toBe(coreAfterHit); // core delay (8 s) not over yet
    for (let i = 0; i < 300; i++) regenHealth(h, hero.health, DT); // 15 s total
    expect(h.core).toBeGreaterThan(coreAfterHit);
    expect(h.shield).toBe(hero.health.shield.max);
  });

  it('taking damage restarts the regeneration delay', () => {
    const h = createHealth(hero.health);
    applyDamage(h, 10, hero.health);
    for (let i = 0; i < 100; i++) regenHealth(h, hero.health, DT); // past the 3 s delay
    expect(h.shield).toBeGreaterThan(hero.health.shield.max - 10);
    const before = h.shield;
    applyDamage(h, 1, hero.health);
    regenHealth(h, hero.health, DT);
    expect(h.shield).toBe(before - 1);
  });
});

describe('player defeat and respawn', () => {
  it('goes down at zero core, ignores input, then respawns at base with full health', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    run(sim, 10, () => intent());
    p.pos = { x: 20, y: 0, z: -3 };
    sim.damagePlayer('p1', 10_000, null);
    expect(p.defeatedTimer).toBe(hero.respawnDelay);
    expect(sim.events.some((e) => e.type === 'defeated')).toBe(true);

    const posBefore = { ...p.pos };
    run(sim, 30, () => intent({ moveZ: 1 })); // ~1 s: still down, cannot move
    expect(p.pos).toEqual(posBefore);

    run(sim, 90, () => intent());
    expect(p.defeatedTimer).toBeNull();
    expect(p.health.core).toBe(hero.health.core.max);
    expect(p.health.shield).toBe(hero.health.shield.max);
    expect(p.energy).toBe(hero.energy.max);
    expect(Math.hypot(p.pos.x - sim.world.spawn.x, p.pos.z - sim.world.spawn.z)).toBeLessThan(1);
  });

  it('cannot be damaged again while down', () => {
    const sim = makeSim();
    sim.damagePlayer('p1', 10_000, null);
    sim.events = [];
    sim.damagePlayer('p1', 5, null);
    expect(sim.events).toEqual([]);
  });

  it('drops an active tether when defeated', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.tether = { anchor: { x: 0, y: 30, z: 0 }, length: 20, targetLength: 20 };
    sim.damagePlayer('p1', 10_000, null);
    expect(p.tether).toBeNull();
  });
});

function attackUntilHit(sim: ReturnType<typeof makeSim>, yaw = 0): number | null {
  for (let i = 0; i < 40; i++) {
    sim.step(DT, new Map([['p1', intent({ attackPressed: i === 0, yaw })]]));
    const melee = sim.events.find((e) => e.type === 'melee');
    if (melee && melee.type === 'melee') return melee.step;
  }
  return null;
}

describe('melee strike', () => {
  const settle = (sim: ReturnType<typeof makeSim>) => run(sim, 10, () => intent());

  it('hits an enemy in front, damages it and knocks it back', () => {
    const sim = makeSim();
    settle(sim);
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 2 });
    for (let i = 0; i < 5; i++) sim.step(DT, new Map()); // let the enemy land
    const z0 = e.pos.z;
    expect(attackUntilHit(sim)).toBe(0);
    expect(e.health.core).toBe(thugDef.health.core.max - hero.melee.steps[0]!.damage);
    run(sim, 6, () => intent());
    expect(e.pos.z).toBeGreaterThan(z0);
  });

  it('misses an enemy behind the player', () => {
    const sim = makeSim();
    settle(sim);
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: -2 });
    attackUntilHit(sim);
    expect(e.health.core).toBe(thugDef.health.core.max);
  });

  it('misses an enemy out of range or on a much higher ledge', () => {
    const sim = makeSim();
    settle(sim);
    const far = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 5 });
    const high = sim.spawnEnemy('enemy.thug', { x: 0.2, y: 8, z: 1 });
    high.vel.y = 0;
    attackUntilHit(sim);
    expect(far.health.core).toBe(thugDef.health.core.max);
    expect(high.health.core).toBe(thugDef.health.core.max);
  });

  it('attacks toward the aim yaw', () => {
    const sim = makeSim();
    settle(sim);
    const e = sim.spawnEnemy('enemy.thug', { x: 2, y: 0.01, z: 0 });
    attackUntilHit(sim, Math.PI / 2);
    expect(e.health.core).toBeLessThan(thugDef.health.core.max);
  });

  it('chains a three-step combo that powers down a thug, finisher hitting hardest', () => {
    const sim = makeSim();
    settle(sim);
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    const steps: number[] = [];
    for (let i = 0; i < 90 && steps.length < 3; i++) {
      // Hold attack: the input buffer keeps the combo flowing.
      sim.step(DT, new Map([['p1', intent({ attackPressed: i % 3 === 0 })]]));
      for (const ev of sim.events) if (ev.type === 'melee') steps.push(ev.step);
      e.pos = { x: 0, y: 0.01, z: 1.5 }; // pin it in reach despite knockback
      e.vel = { x: 0, y: 0, z: 0 };
    }
    expect(steps).toEqual([0, 1, 2]);
    // The three hits together are enough to power down a thug.
    const total = hero.melee.steps.reduce((a, s) => a + s.damage, 0);
    expect(total).toBeGreaterThanOrEqual(thugDef.health.core.max);
    expect(e.defeatedTimer).not.toBeNull();
    expect(hero.melee.steps[2]!.damage).toBeGreaterThan(hero.melee.steps[0]!.damage);
  });

  it('restarts the combo after the window expires', () => {
    const sim = makeSim();
    settle(sim);
    expect(attackUntilHit(sim)).toBe(0);
    run(sim, 60, () => intent()); // 2 s idle
    expect(attackUntilHit(sim)).toBe(0);
  });

  it('powers down a defeated enemy, emits events, then removes it', () => {
    const sim = makeSim();
    settle(sim);
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    sim.damageEnemy(e, 1000, 'p1');
    expect(e.defeatedTimer).toBe(thugDef.powerDownTime);
    expect(sim.events.map((x) => x.type)).toEqual(['damage', 'defeated']);
    // Cannot be hit while powering down.
    const core = e.health.core;
    attackUntilHit(sim);
    expect(e.health.core).toBe(core);
    run(sim, 40, () => intent());
    expect(sim.enemies.has(e.id)).toBe(false);
  });

  it('attack rate is limited by windup + recovery even when mashing', () => {
    const sim = makeSim();
    settle(sim);
    sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 }).health.core = 1e6;
    let swings = 0;
    for (let i = 0; i < 90; i++) {
      sim.step(DT, new Map([['p1', intent({ attackPressed: true })]]));
      swings += sim.events.filter((x) => x.type === 'melee').length;
    }
    const perSecond = swings / 3;
    const maxPerSecond = 1 / (hero.melee.windup + hero.melee.recovery);
    expect(perSecond).toBeLessThanOrEqual(maxPerSecond + 0.5);
    expect(perSecond).toBeGreaterThan(2);
  });
});
