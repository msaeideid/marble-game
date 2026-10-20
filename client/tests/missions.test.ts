import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { MissionRunner, type MissionData, type MissionEvent, type Objective } from '../src/campaign/missions';
import { getHero } from '../src/data';
import { Sim, type SimEvent } from '../src/sim/sim';
import { World, type LevelData } from '../src/sim/world';
import { content, DT, intent } from './helpers';

const rewards = { 'enemy.thug': { reward: { scrap: 5, xp: 10 } } };

function field(): World {
  const level = arena as unknown as LevelData;
  return new World({ ...level, base: undefined, enemySpawns: [], props: [], colliders: [level.colliders[0]!] });
}

function mission(objectives: Objective[], extra: Partial<MissionData> = {}): MissionData {
  return {
    id: 'mission.test',
    title: 'Test',
    chapter: 'chapter.test',
    kind: 'story',
    level: 'arena',
    summary: 'x',
    requires: {},
    objectives,
    spawns: [],
    dialogue: [],
    reward: { scrap: 1, xp: 1 },
    ...extra,
  };
}

function setup(m: MissionData, heroId = 'hero.bruiser') {
  const sim = new Sim(field(), getHero(heroId), content.enemies, { waves: false, props: true, propDefs: content.props });
  const me = sim.addPlayer('p1');
  me.invulnerable = 0;
  const runner = new MissionRunner(m, sim, 'p1', rewards);
  const log: MissionEvent[] = [];
  const tick = (i: Partial<ReturnType<typeof intent>> = {}, extra: SimEvent[] = []) => {
    sim.step(DT, new Map([['p1', intent(i)]]));
    runner.update([...sim.events, ...extra], DT);
    log.push(...runner.take());
  };
  const run = (n: number, i: Partial<ReturnType<typeof intent>> = {}) => {
    for (let k = 0; k < n; k++) tick(i);
  };
  for (let k = 0; k < 6; k++) sim.step(DT, new Map()); // land
  return { sim, me, runner, tick, run, log };
}

const types = (log: MissionEvent[]) => log.map((e) => e.type);

describe('objectives', () => {
  it('"do" objectives count moving, jumping, striking and specials', () => {
    const m = mission([
      { id: 'move', text: 'Move', kind: 'do', action: 'move', amount: 6 },
      { id: 'jump', text: 'Jump', kind: 'do', action: 'jump', amount: 2 },
      { id: 'strike', text: 'Strike', kind: 'do', action: 'strike', amount: 2 },
      { id: 'special', text: 'Special', kind: 'do', action: 'special', amount: 1 },
    ]);
    const { runner, tick, run, sim } = setup(m);
    run(60, { moveZ: 1 });
    expect(runner.index).toBe(1);
    for (let n = 0; n < 2; n++) {
      tick({ jumpPressed: true });
      run(40);
    }
    expect(runner.index).toBe(2);
    sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 1.6 }).snaredTimer = 99;
    for (let n = 0; n < 12; n++) {
      tick({ attackPressed: true });
      run(8);
    }
    expect(runner.index).toBe(3);
    tick({}, [{ type: 'throw', id: 0, by: 'p1' }]);
    expect(runner.status).toBe('complete');
  });

  it('"defeat" counts only kills made while it is the current objective, and only the right type', () => {
    const m = mission([{ id: 'kill', text: 'Defeat 2 thugs', kind: 'defeat', count: 2, enemyType: 'enemy.thug' }]);
    const { runner, sim, tick } = setup(m);
    const a = sim.spawnEnemy('enemy.thug', { x: 5, y: 0.01, z: 5 });
    const b = sim.spawnEnemy('enemy.thug', { x: 6, y: 0.01, z: 5 });
    tick({}, [{ type: 'defeated', id: 'p1' }]); // a player going down is not a kill
    expect(runner.progress()).toEqual([0, 2]);
    tick({}, [{ type: 'defeated', id: a.id }]);
    expect(runner.progress()).toEqual([1, 2]);
    tick({}, [{ type: 'defeated', id: b.id }]);
    expect(runner.status).toBe('complete');
    expect(runner.loot).toEqual({ scrap: 10, xp: 20 });
  });

  it('"reach" completes when the player stands in the spot, and shows a marker meanwhile', () => {
    const m = mission([{ id: 'go', text: 'Go', kind: 'reach', pos: [0, 0, 8], radius: 2 }]);
    const { runner, me, tick, run } = setup(m);
    expect(runner.marker()).toEqual({ x: 0, y: 0, z: 8 });
    run(5);
    expect(runner.status).toBe('active');
    me.pos = { x: 0.5, y: 0, z: 7.5 };
    tick();
    expect(runner.status).toBe('complete');
  });

  it('"survive" completes after the time, and objectives run one after another', () => {
    const m = mission([
      { id: 'a', text: 'A', kind: 'survive', seconds: 1 },
      { id: 'b', text: 'B', kind: 'survive', seconds: 1 },
    ]);
    const { runner, run, log } = setup(m);
    run(31);
    expect(runner.index).toBe(1);
    run(31);
    expect(runner.status).toBe('complete');
    expect(types(log)).toEqual(['objectiveStart', 'objectiveDone', 'objectiveStart', 'objectiveDone', 'missionComplete']);
  });

  it('a boss objective completes when it is defeated, or when it drops to the escape fraction and escapes', () => {
    const base = (escapeAt?: number) =>
      mission([{ id: 'boss', text: 'Boss', kind: 'boss', tag: 'big', ...(escapeAt ? { escapeAt } : {}) }], {
        spawns: [{ when: { start: true }, enemies: [{ type: 'enemy.thug', pos: [0, 0.01, 8], tag: 'big' }] }],
      });
    const down = setup(base());
    down.tick();
    const boss = [...down.sim.enemies.values()][0]!;
    down.sim.damageEnemy(boss, 999, 'p1');
    down.tick();
    expect(down.runner.status).toBe('complete');
    expect(down.runner.escaped).toBe(false);

    const flee = setup(base(0.5));
    flee.tick();
    const b2 = [...flee.sim.enemies.values()][0]!;
    flee.sim.damageEnemy(b2, 30, 'p1'); // 45 -> 15, below half
    flee.tick();
    expect(flee.runner.status).toBe('complete');
    expect(flee.runner.escaped).toBe(true);
    expect(types(flee.log)).toContain('bossEscape');
    expect(flee.sim.enemies.size).toBe(0);
  });
});

describe('spawns, dialogue and failure', () => {
  it('spawns and says things at the right moments, in a deterministic layout', () => {
    const m = mission(
      [
        { id: 'one', text: 'One', kind: 'survive', seconds: 0.5 },
        { id: 'two', text: 'Two', kind: 'survive', seconds: 0.5 },
      ],
      {
        spawns: [
          { when: { start: true }, enemies: [{ type: 'enemy.thug', pos: [0, 0.01, 10], count: 3, spread: 2 }] },
          { when: { objective: 'two', event: 'start' }, enemies: [{ type: 'enemy.thug', pos: [20, 0.01, 10] }] },
        ],
        dialogue: [
          { when: { start: true }, speaker: 'Dot', text: 'Hello' },
          { when: { objective: 'one', event: 'complete' }, speaker: 'Dot', text: 'Nice' },
          { when: { complete: true }, speaker: 'Dot', text: 'Done' },
        ],
      },
    );
    const { runner, sim, tick, run, log } = setup(m);
    tick();
    expect(sim.enemies.size).toBe(3);
    expect([...sim.enemies.values()].map((e) => e.pos.x).sort((a, b) => a - b)).toEqual([-2, 0, 2]);
    run(60);
    expect(runner.status).toBe('complete');
    expect(sim.enemies.size).toBe(4);
    expect(log.filter((e) => e.type === 'dialogue').map((e) => (e as { text: string }).text)).toEqual(['Hello', 'Nice', 'Done']);
  });

  it('a time limit fails the mission, and so does any damage in a no-damage challenge', () => {
    const slow = setup(mission([{ id: 'x', text: 'x', kind: 'survive', seconds: 99 }], { timeLimit: 2 }));
    slow.run(70);
    expect(slow.runner.status).toBe('failed');
    expect(types(slow.log)).toContain('missionFailed');
    expect(slow.runner.timeLeft()).toBe(0);

    const clean = setup(mission([{ id: 'x', text: 'x', kind: 'survive', seconds: 99 }], { noDamage: true }));
    clean.run(10);
    expect(clean.runner.status).toBe('active');
    clean.sim.events = [];
    clean.sim.damagePlayer('p1', 5, 'enemy-1');
    clean.tick({}, [...clean.sim.events]); // (damage normally happens inside a step, whose events the runner sees)
    expect(clean.runner.status).toBe('failed');
    expect(clean.log.find((e) => e.type === 'missionFailed')).toMatchObject({ reason: 'damage' });
  });

  it('does nothing once the mission is over', () => {
    const { runner, run, log } = setup(mission([{ id: 'x', text: 'x', kind: 'survive', seconds: 0.2 }]));
    run(20);
    const n = log.length;
    run(20);
    expect(runner.status).toBe('complete');
    expect(log.length).toBe(n);
  });
});
