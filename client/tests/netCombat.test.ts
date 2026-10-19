import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { applyCombat, mirrorEnemies, remapEvent } from '../src/net/online';
import { SnapshotBuffer } from '../src/net/interpolation';
import type { ServerSnapshot } from '../src/net/session';
import type { EnemyWire } from '../src/sim/enemy';
import { Sim } from '../src/sim/sim';
import { combatWire } from '../src/sim/wire';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, hero, intent } from './helpers';

const thugDef = content.enemies['enemy.thug']!;

const ew = (id: string, x: number, over: Partial<EnemyWire> = {}): EnemyWire => ({
  id,
  type: 'enemy.thug',
  pos: [x, 0, 5],
  vel: [0, 0, 0],
  facing: 0,
  ai: 'chase',
  aiTimer: 0,
  shield: 0,
  core: 45,
  snared: 0,
  poise: 0,
  cooldown: 0,
  defeated: null,
  ...over,
});

/** A client's local sim: movement prediction only, no enemies, no combat. */
function onlineSim(): Sim {
  const level = arena as unknown as LevelData;
  const sim = new Sim(new World({ ...level, base: undefined }), hero, content.enemies, { waves: false, props: false, combat: false });
  sim.addPlayer('local').invulnerable = 0;
  return sim;
}

describe('events from the server', () => {
  it('our own server id becomes the local id, other players keep theirs', () => {
    const mine = remapEvent({ type: 'melee', attacker: 'p1', step: 0, yaw: 0, pos: { x: 0, y: 0, z: 0 }, hits: ['enemy-1'] }, 'p1', 'local');
    expect(mine).toMatchObject({ attacker: 'local', hits: ['enemy-1'] });
    const theirs = remapEvent({ type: 'melee', attacker: 'p2', step: 0, yaw: 0, pos: { x: 0, y: 0, z: 0 }, hits: [] }, 'p1', 'local');
    expect(theirs).toMatchObject({ attacker: 'p2' });
    const hit = remapEvent({ type: 'detonate', id: 3, pos: { x: 0, y: 0, z: 0 }, radius: 4, owner: 'p2', thrower: 'p1', hits: [], combo: true }, 'p1', 'local');
    expect(hit).toMatchObject({ owner: 'p2', thrower: 'local' });
    const dmg = remapEvent({ type: 'damage', target: 'p1', source: 'enemy-2', amount: 8, shieldLost: 8, coreLost: 0 }, 'p1', 'local');
    expect(dmg).toMatchObject({ target: 'local', source: 'enemy-2' });
  });
});

describe('the server owns combat state', () => {
  it('applyCombat puts the server health, cooldowns and defeat timer on the local player', () => {
    const sim = onlineSim();
    const p = sim.players.get('local')!;
    applyCombat(p, {
      shield: 7,
      core: 21,
      defeated: null,
      invulnerable: 0,
      cooldowns: { snare: 1, laser: 0.1, rocket: 2.5, chain: 0.5, storm: 6 },
      melee: { phase: 'idle', step: 0 },
    });
    expect(p.health.shield).toBe(7);
    expect(p.health.core).toBe(21);
    expect(p.rocketCooldown).toBe(2.5);
    expect(p.stormCooldown).toBe(6);
    expect(combatWire(p).cooldowns.chain).toBe(0.5);
    applyCombat(p, { ...combatWire(p), defeated: 2.5 });
    expect(p.defeatedTimer).toBe(2.5);
  });

  it('an online sim runs no combat: pressing attack or fire does nothing, and no enemy logic runs', () => {
    const sim = onlineSim();
    const p = sim.players.get('local')!;
    mirrorEnemies(sim, [ew('enemy-1', 0)], content.enemies);
    const e = sim.enemies.get('enemy-1')!;
    const energy = p.energy;
    for (let i = 0; i < 30; i++) sim.step(DT, new Map([['local', intent({ attackPressed: true, fireHeld: true, snarePressed: true })]]));
    expect(e.health.core).toBe(45); // untouched
    expect(e.pos).toEqual({ x: 0, y: 0, z: 5 }); // the mirrored enemy was not walked, pushed or pulled by local logic
    expect(sim.events.length).toBe(0);
    expect(p.energy).toBeGreaterThanOrEqual(energy - 1e-9); // nothing was spent locally
  });

  it('a defeated online player stays defeated until the server says otherwise', () => {
    const sim = onlineSim();
    const p = sim.players.get('local')!;
    p.defeatedTimer = 0.1;
    for (let i = 0; i < 20; i++) sim.step(DT, new Map());
    expect(p.defeatedTimer).toBe(0.1); // no local countdown and no local respawn
  });
});

describe('mirroring the server enemies', () => {
  it('creates, updates and removes enemies to match the snapshot', () => {
    const sim = onlineSim();
    mirrorEnemies(sim, [ew('enemy-1', 1), ew('enemy-2', 2)], content.enemies);
    expect([...sim.enemies.keys()]).toEqual(['enemy-1', 'enemy-2']);
    mirrorEnemies(sim, [ew('enemy-2', 3, { core: 10, ai: 'windup', aiTimer: 0.3, defeated: null, snared: 1.5 })], content.enemies);
    expect([...sim.enemies.keys()]).toEqual(['enemy-2']);
    const e = sim.enemies.get('enemy-2')!;
    expect(e.pos.x).toBe(3);
    expect(e.health.core).toBe(10);
    expect(e.aiState).toBe('windup');
    expect(e.snaredTimer).toBe(1.5);
    expect(e.typeId).toBe(thugDef.id);
    mirrorEnemies(sim, [ew('enemy-2', 3, { core: 0, defeated: 0.5 })], content.enemies);
    expect(sim.enemies.get('enemy-2')!.defeatedTimer).toBe(0.5);
    expect(sim.liveTargets()).toEqual([]); // a defeated enemy is not a target
    mirrorEnemies(sim, [], content.enemies);
    expect(sim.enemies.size).toBe(0);
  });

  it('ignores enemy types it does not know', () => {
    const sim = onlineSim();
    mirrorEnemies(sim, [ew('enemy-1', 0, { type: 'enemy.dragon' })], content.enemies);
    expect(sim.enemies.size).toBe(0);
  });
});

describe('interpolating enemies and rockets', () => {
  const snap = (enemies: EnemyWire[], rockets: ServerSnapshot['rockets'] = []): ServerSnapshot => ({ t: 'snap', tick: 0, players: {}, enemies, rockets });

  it('blends enemy positions between two snapshots, 100 ms behind', () => {
    const buf = new SnapshotBuffer(100);
    buf.push(1000, snap([ew('e', 0)]));
    buf.push(1100, snap([ew('e', 10), ew('new', 5)]));
    const mid = buf.sampleEnemies(1150); // renders t = 1050: halfway
    expect(mid.find((e) => e.id === 'e')!.pos[0]).toBeCloseTo(5, 6);
    expect(mid.find((e) => e.id === 'new')!.pos[0]).toBe(5); // no earlier sample: shown where it is
    expect(buf.sampleEnemies(5000).find((e) => e.id === 'e')!.pos[0]).toBe(10); // never extrapolates
  });

  it('blends rockets the same way and drops the ones that exploded', () => {
    const buf = new SnapshotBuffer(100);
    const r = (id: number, x: number) => ({ id, owner: 'p1', pos: [x, 1, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number], target: null });
    buf.push(0, snap([], [r(1, 0), r(2, 0)]));
    buf.push(100, snap([], [r(1, 4)]));
    const mid = buf.sampleRockets(150);
    expect(mid.map((x) => x.id)).toEqual([1]);
    expect(mid[0]!.pos[0]).toBeCloseTo(2, 6);
  });
});
