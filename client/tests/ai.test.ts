import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { World } from '../src/sim/world';
import { content, DT, hero, intent, makeSim, run } from './helpers';

const thug = content.enemies['enemy.thug']!;

/** Sim with the player standing at the spawn, settled on the ground. */
function arenaSim() {
  const sim = makeSim();
  run(sim, 10, () => intent());
  return { sim, player: sim.players.get('p1')! };
}

const idleTicks = (sim: Sim, ticks: number, over = {}) => run(sim, ticks, () => intent(over));

describe('thug AI', () => {
  it('stays idle when the player is outside aggro range', () => {
    const { sim } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: thug.aggroRange + 20 });
    idleTicks(sim, 60);
    expect(e.aiState).toBe('idle');
    expect(Math.hypot(e.pos.x, e.pos.z - (thug.aggroRange + 20))).toBeLessThan(0.01);
  });

  it('chases the player and starts a telegraphed attack in range', () => {
    const { sim, player } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 10 });
    let windupAt = -1;
    for (let i = 0; i < 200 && windupAt < 0; i++) {
      idleTicks(sim, 1);
      if (e.aiState === 'windup') windupAt = i;
    }
    expect(windupAt).toBeGreaterThan(0);
    const dist = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
    expect(dist).toBeLessThanOrEqual(thug.attack.range + 0.01);
    expect(e.facing).toBeCloseTo(Math.PI, 1); // faces the player (-Z)
  });

  it('only damages after the windup and takes the shield first', () => {
    const { sim, player } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    let ticksToHit = 0;
    for (let i = 1; i <= 90; i++) {
      idleTicks(sim, 1);
      if (sim.events.some((ev) => ev.type === 'enemyAttack')) {
        ticksToHit = i;
        break;
      }
    }
    expect(ticksToHit * DT).toBeGreaterThanOrEqual(thug.attack.windup - DT);
    expect(player.health.shield).toBe(hero.health.shield.max - thug.attack.damage);
    expect(player.health.core).toBe(hero.health.core.max);
    expect(e.aiState).toBe('recovery');
  });

  it('knocks the player back when it hits', () => {
    const { sim, player } = arenaSim();
    sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    // The thug stands at +Z, so the knockback pushes the player toward -Z.
    let minVz = Infinity;
    for (let i = 0; i < 40; i++) {
      idleTicks(sim, 1);
      minVz = Math.min(minVz, player.vel.z);
    }
    expect(minVz).toBeLessThan(-1);
  });

  it('can be dodged by stepping out of range during the windup', () => {
    const { sim, player } = arenaSim();
    sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    // Wait for the windup to begin, then sprint away from it.
    for (let i = 0; i < 20 && [...sim.enemies.values()][0]!.aiState !== 'windup'; i++) idleTicks(sim, 1);
    run(sim, 20, () => intent({ moveZ: -1, yaw: 0 }));
    expect(player.health.shield).toBe(hero.health.shield.max);
  });

  it('a hit during the windup interrupts the attack', () => {
    const { sim, player } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    for (let i = 0; i < 20 && e.aiState !== 'windup'; i++) idleTicks(sim, 1);
    expect(e.aiState).toBe('windup');
    sim.damageEnemy(e, 1, 'p1');
    expect(e.aiState).toBe('stagger');
    idleTicks(sim, 20);
    expect(player.health.shield).toBe(hero.health.shield.max);
    expect(e.aiState === 'chase' || e.aiState === 'windup').toBe(true);
  });

  it('repeated hits do not extend a stagger, and poise stops the next stagger-lock', () => {
    const { sim } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    sim.damageEnemy(e, 1, 'p1');
    expect(e.aiState).toBe('stagger');
    idleTicks(sim, 6); // 0.2 s in
    const left = e.aiTimer;
    sim.damageEnemy(e, 1, 'p1');
    expect(e.aiTimer).toBe(left); // not restarted
    idleTicks(sim, Math.ceil(thug.staggerTime / DT)); // stagger over, poise active
    expect(e.aiState).not.toBe('stagger');
    expect(e.poiseTimer).toBeGreaterThan(0);
    sim.damageEnemy(e, 1, 'p1');
    expect(e.aiState).not.toBe('stagger'); // armoured: damaged but not interrupted
    expect(e.health.core).toBe(thug.health.core.max - 3);
    idleTicks(sim, Math.ceil(thug.poiseTime / DT) + 1);
    sim.damageEnemy(e, 1, 'p1');
    expect(e.aiState).toBe('stagger'); // vulnerable again
  });

  it('resumes the fight after the stagger ends', () => {
    const { sim, player } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    sim.damageEnemy(e, 1, 'p1');
    idleTicks(sim, Math.ceil((thug.staggerTime + thug.attack.windup + 0.5) / DT));
    expect(player.health.shield).toBeLessThan(hero.health.shield.max);
  });

  it('does not attack a defeated player and goes idle', () => {
    const { sim } = arenaSim();
    const e = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.5 });
    sim.damagePlayer('p1', 10_000, null);
    sim.events = [];
    idleTicks(sim, 30);
    expect(sim.events.some((ev) => ev.type === 'enemyAttack')).toBe(false);
    expect(e.aiState).toBe('idle');
  });

  it('crowds spread out instead of stacking on one spot', () => {
    const { sim } = arenaSim();
    const a = sim.spawnEnemy('enemy.thug', { x: 10, y: 0.01, z: 10 });
    const b = sim.spawnEnemy('enemy.thug', { x: 10, y: 0.01, z: 10.1 });
    idleTicks(sim, 30);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThan(0.6);
  });
});

describe('tether snare', () => {
  const place = (sim: Sim, z: number) => sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z });

  it('holds an enemy in place and blocks its attack for the duration', () => {
    const { sim, player } = arenaSim();
    const e = place(sim, 8);
    run(sim, 1, () => intent({ snarePressed: true, yaw: 0, pitch: 0 }));
    expect(e.snaredTimer).toBeGreaterThan(0);
    expect(sim.events.some((ev) => ev.type === 'snare')).toBe(true);
    const z = e.pos.z;
    idleTicks(sim, Math.floor((hero.snare!.duration - 0.3) / DT));
    expect(e.pos.z).toBeCloseTo(z, 2);
    expect(player.health.shield).toBe(hero.health.shield.max);
    idleTicks(sim, 30); // snare over: it moves again
    expect(e.pos.z).toBeLessThan(z - 0.5);
  });

  it('holds an enemy that is already adjacent, so it cannot attack', () => {
    const { sim, player } = arenaSim();
    const e = place(sim, 1.5);
    run(sim, 1, () => intent({ snarePressed: true, yaw: 0, pitch: 0 }));
    idleTicks(sim, 60);
    expect(e.snaredTimer).toBeGreaterThan(0);
    expect(player.health.shield).toBe(hero.health.shield.max);
  });

  it('costs energy and goes on cooldown', () => {
    const { sim, player } = arenaSim();
    place(sim, 8);
    const before = player.energy;
    run(sim, 1, () => intent({ snarePressed: true }));
    expect(player.energy).toBeLessThanOrEqual(before - hero.snare!.cost);
    expect(player.snareCooldown).toBeGreaterThan(0);
    // A second enemy cannot be snared until the cooldown ends.
    const second = sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 12 });
    second.snaredTimer = 0;
    sim.enemies.values().next().value!.defeatedTimer = 0.01;
    run(sim, 3, () => intent({ snarePressed: true }));
    expect(second.snaredTimer).toBe(0);
  });

  it('does nothing (and costs nothing) when aimed at empty space', () => {
    const { sim, player } = arenaSim();
    place(sim, 8);
    const before = player.energy;
    run(sim, 1, () => intent({ snarePressed: true, yaw: Math.PI }));
    expect(player.energy).toBe(before);
    expect(player.snareCooldown).toBe(0);
  });

  it('cannot reach through a building or beyond its range', () => {
    const { sim, player } = arenaSim();
    // Building at x:[7,17] z:[7,17]; player on the other side of it.
    player.pos = { x: 0, y: 0, z: 12 };
    const behind = sim.spawnEnemy('enemy.thug', { x: 20, y: 0.01, z: 12 });
    run(sim, 1, () => intent({ snarePressed: true, yaw: Math.PI / 2, pitch: 0 }));
    expect(behind.snaredTimer).toBe(0);

    const { sim: sim2 } = arenaSim();
    const far = sim2.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: hero.snare!.range + 10 });
    run(sim2, 1, () => intent({ snarePressed: true, yaw: 0, pitch: 0 }));
    expect(far.snaredTimer).toBe(0);
  });

  it('picks the nearest enemy on the aim line', () => {
    const { sim } = arenaSim();
    const far = place(sim, 18);
    const near = place(sim, 8);
    run(sim, 1, () => intent({ snarePressed: true, yaw: 0, pitch: 0 }));
    expect(near.snaredTimer).toBeGreaterThan(0);
    expect(far.snaredTimer).toBe(0);
  });
});

describe('waves', () => {
  function waveSim() {
    const sim = new Sim(new World(arena), hero, content.enemies, { waves: true });
    sim.addPlayer('p1').invulnerable = 0;
    return sim;
  }

  it('spawns the first wave immediately and bigger waves after each clear', () => {
    const sim = waveSim();
    run(sim, 1, () => intent());
    expect(sim.enemies.size).toBe(arena.enemySpawns.length);
    for (let wave = 2; wave <= 6; wave++) {
      for (const e of sim.enemies.values()) sim.damageEnemy(e, 1000, 'p1');
      // power-down, then the delay, then the next wave
      run(sim, Math.ceil((thug.powerDownTime + arena.waveDelay + 0.5) / DT), () => intent());
      expect(sim.enemies.size).toBe(Math.min(5, arena.enemySpawns.length + wave - 1));
    }
  });

  it('does not spawn a new wave while enemies remain', () => {
    const sim = waveSim();
    run(sim, 1, () => intent());
    const n = sim.enemies.size;
    run(sim, 300, () => intent({ moveZ: 0 }));
    // enemies may attack the player but never multiply
    expect(sim.enemies.size).toBe(n);
  });
});

describe('base pad', () => {
  function damagedOnSpot(withBase: boolean, at: { x: number; z: number }) {
    const sim = makeSim(true, withBase);
    run(sim, 10, () => intent());
    const p = sim.players.get('p1')!;
    p.pos = { x: at.x, y: 0, z: at.z };
    sim.damagePlayer('p1', hero.health.shield.max + 20, null);
    p.energy = 0;
    return { sim, p };
  }

  it('refills shield, energy and (slowly) core after the damage delay, much faster than normal regen', () => {
    const onPad = damagedOnSpot(true, { x: 0, z: 0 });
    const offPad = damagedOnSpot(true, { x: 30, z: 0 });
    const ticks = Math.ceil((hero.health.shield.regenDelay + 1) / DT);
    run(onPad.sim, ticks, () => intent());
    run(offPad.sim, ticks, () => intent());
    expect(onPad.sim.world.isOnBase(onPad.p.pos)).toBe(true);
    expect(onPad.p.health.shield).toBeGreaterThan(offPad.p.health.shield + 10);
    expect(onPad.p.energy).toBeGreaterThan(offPad.p.energy + 20);
    expect(onPad.p.health.core).toBeGreaterThan(offPad.p.health.core);
    expect(onPad.sim.world.base!.regenPerSecond * 0.25).toBeLessThan(onPad.sim.world.base!.regenPerSecond);
  });

  it('does not heal the shield while still in combat (inside the damage delay)', () => {
    const { sim, p } = damagedOnSpot(true, { x: 0, z: 0 });
    run(sim, Math.floor((hero.health.shield.regenDelay - 0.5) / DT), () => intent());
    expect(p.health.shield).toBe(0);
  });

  it('standing on the pad does not make you immune to a group of thugs', () => {
    const sim = makeSim(true, true);
    run(sim, 10, () => intent());
    const p = sim.players.get('p1')!;
    for (const z of [3, -3, 4]) sim.spawnEnemy('enemy.thug', { x: z, y: 0.01, z });
    let down = false;
    for (let i = 0; i < 30 * 40 && !down; i++) {
      run(sim, 1, () => intent());
      down = p.defeatedTimer !== null;
    }
    expect(down).toBe(true);
  });
});
