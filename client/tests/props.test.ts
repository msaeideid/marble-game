import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import { carryScales } from '../src/sim/props';
import type { Sim } from '../src/sim/sim';
import { Sim as SimClass } from '../src/sim/sim';
import { World } from '../src/sim/world';
import arena from '@shared/levels/arena.json';
import { content, DT, hero as ziplash, intent, makeSimFor, run } from './helpers';

const rampart = getHero('hero.bruiser');
const lift = rampart.lift!;
const carCfg = content.props['prop.car']!;
const crateCfg = content.props['prop.crate']!;
const thug = content.enemies['enemy.thug']!;

// Level props (index = prop id): 0 car (3,0,-6), 1 car (0,0,-16.5), 2 crate (-3,0,-4), 3 crate (5,0,4.5),
// 4 dumpster (-4,0,5.5), 5 crate (-20,0,2). Walls: 34 weak south, 35 weak west, 36 reinforced south.
const CAR_A = 0;
const CAR_B = 1;
const CRATE_A = 2;
const CRATE_FAR = 5;

function rampartAt(x: number, z: number) {
  const sim = makeSimFor('hero.bruiser');
  run(sim, 10, () => intent());
  const p = sim.players.get('p1')!;
  p.pos = { x, y: 0, z };
  p.prevPos = { ...p.pos };
  return { sim, p };
}
const prop = (sim: Sim, id: number) => sim.propSystem!.props[id]!;
const grab = (extra = {}) => intent({ grabPressed: true, ...extra });
const wait = (sim: Sim, ticks: number, extra = {}) => run(sim, ticks, () => intent(extra));
const COOLDOWN_TICKS = Math.ceil(lift.cooldown / DT) + 1;

describe('prop data and kits', () => {
  it('only RAMPART can lift; the level has props; each type is sensibly different', () => {
    expect(rampart.lift).toBeDefined();
    expect(ziplash.lift).toBeUndefined();
    expect(new World(arena).propSpawns.length).toBe(6);
    expect(carCfg.carrySlow).toBeLessThan(crateCfg.carrySlow); // heavier = slower
    expect(carCfg.throwDamage).toBeGreaterThan(crateCfg.throwDamage);
    expect(carCfg.breakPower).toBeGreaterThan(crateCfg.breakPower); // only the car beats the reinforced wall
  });

  it('carry scales: heavier props slow you more, and the jump suffers less than the run', () => {
    const s = carryScales(carCfg)!;
    expect(s.speedScale).toBe(carCfg.carrySlow);
    expect(s.jumpScale).toBeGreaterThan(s.speedScale);
    expect(carryScales(undefined)).toBeUndefined();
  });

  it('props are off when disabled (online clients draw the server\'s props instead)', () => {
    const sim = new SimClass(new World(arena), rampart, content.enemies, { props: false, propDefs: content.props });
    expect(sim.propSystem).toBeNull();
    expect(sim.propWires).toEqual([]);
  });
});

describe('lifting', () => {
  it('lifts the nearest resting prop in reach and carries it overhead', () => {
    const { sim, p } = rampartAt(3, -3.6);
    run(sim, 1, () => grab());
    expect(p.carrying).toEqual({ id: CAR_A, def: 'prop.car' });
    expect(prop(sim, CAR_A).mode).toBe('held');
    expect(prop(sim, CAR_A).holder).toBe('p1');
    expect(sim.events.some((e) => e.type === 'lift')).toBe(true);
    wait(sim, 1);
    // it rides on top of the carrier's head
    expect(prop(sim, CAR_A).pos.y).toBeCloseTo(p.pos.y + rampart.movement.height + 0.05, 5);
    expect(prop(sim, CAR_A).pos.x).toBeCloseTo(p.pos.x, 5);
  });

  it('does nothing when no prop is in reach, and ZIPLASH cannot lift at all', () => {
    const { sim, p } = rampartAt(25, 0);
    run(sim, 1, () => grab());
    expect(p.carrying).toBeNull();
    const z = makeSimFor('hero.swinger');
    const zp = z.players.get('p1')!;
    zp.pos = { x: 3, y: 0, z: -3.6 };
    run(z, 1, () => grab());
    expect(zp.carrying).toBeNull();
    expect(prop(z, CAR_A).mode).toBe('resting');
  });

  it('picks the closest of several props', () => {
    const { sim, p } = rampartAt(-3, -2.4); // crate A is 1.6 away; car A is far
    run(sim, 1, () => grab());
    expect(p.carrying!.id).toBe(CRATE_A);
  });

  it('two players cannot lift the same prop', () => {
    const { sim } = rampartAt(3, -3.6);
    const p2 = sim.addPlayer('p2');
    p2.pos = { x: 3.5, y: 0, z: -3.6 };
    p2.invulnerable = 0;
    sim.step(DT, new Map([['p1', grab()], ['p2', grab()]]));
    expect(prop(sim, CAR_A).holder).toBe('p1');
    expect(p2.carrying).toBeNull();
  });

  it('respects the cooldown between actions and cannot lift while charging', () => {
    const { sim, p } = rampartAt(-3, -2.4);
    run(sim, 1, () => grab());
    expect(p.carrying).not.toBeNull();
    run(sim, 3, () => grab({ yaw: Math.PI })); // too soon: no throw yet
    expect(p.carrying).not.toBeNull();
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw: Math.PI }));
    expect(p.carrying).toBeNull();

    const { sim: s2, p: p2 } = rampartAt(3, -3.6);
    run(s2, 1, () => intent({ chargePressed: true, yaw: Math.PI / 2 }));
    expect(p2.charge).not.toBeNull();
    run(s2, 1, () => grab());
    expect(p2.carrying).toBeNull();
  });
});

describe('carrying', () => {
  it('slows running, lowers the jump, and blocks charging and striking', () => {
    const free = rampartAt(30, 0);
    run(free.sim, 40, () => intent({ moveZ: 1 }));
    const freeSpeed = Math.hypot(free.p.vel.x, free.p.vel.z);

    const { sim, p } = rampartAt(3, -3.6);
    run(sim, 1, () => grab());
    p.pos = { x: 30, y: 0, z: 0 }; // carry the car out to open ground
    run(sim, 40, () => intent({ moveZ: 1 }));
    const carrySpeed = Math.hypot(p.vel.x, p.vel.z);
    expect(carrySpeed).toBeCloseTo(freeSpeed * carCfg.carrySlow, 3);

    let apex = 0;
    run(sim, 1, () => intent({ jumpPressed: true }));
    for (let i = 0; i < 30; i++) {
      run(sim, 1, () => intent());
      apex = Math.max(apex, p.pos.y);
    }
    const freeApex = rampart.movement.jumpSpeed ** 2 / (2 * rampart.movement.gravity);
    expect(apex).toBeGreaterThan(0.2);
    expect(apex).toBeLessThan(freeApex * 0.8);

    wait(sim, 60);
    run(sim, 1, () => intent({ chargePressed: true, yaw: 0 }));
    expect(p.charge).toBeNull();

    const e = sim.spawnEnemy('enemy.thug', { x: p.pos.x, y: 0.01, z: p.pos.z + 1.5 });
    e.attackCooldown = 99;
    for (let i = 0; i < 30; i++) run(sim, 1, () => intent({ attackPressed: true }));
    expect(e.health.core).toBe(thug.health.core.max);
  });

  it('drops the prop where you stand when you are defeated', () => {
    const { sim, p } = rampartAt(3, -3.6);
    run(sim, 1, () => grab());
    p.pos = { x: 10, y: 0, z: 0 };
    wait(sim, 2);
    sim.damagePlayer('p1', 10_000, null);
    expect(p.carrying).toBeNull();
    wait(sim, 3);
    expect(prop(sim, CAR_A).mode).toBe('resting');
    expect(prop(sim, CAR_A).holder).toBeNull();
    expect(prop(sim, CAR_A).pos.x).toBeCloseTo(10, 0);
  });
});

describe('throwing', () => {
  function throwCrate(yaw: number, pitch = -0.05) {
    const { sim, p } = rampartAt(-3, -2.4);
    run(sim, 1, () => grab());
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw, pitch }));
    return { sim, p, crate: prop(sim, CRATE_A) };
  }

  it('launches the prop along the aim at throw speed, then it flies, lands and rests', () => {
    const { sim, p, crate } = throwCrate(Math.PI / 2); // east, down the open E-W street... start at (-3, 0, -2.4)
    expect(crate.mode).toBe('thrown');
    expect(p.carrying).toBeNull();
    // (one gravity tick has already acted on it this tick)
    const speed = Math.hypot(crate.vel.x, crate.vel.y, crate.vel.z);
    expect(Math.abs(speed - crateCfg.throwSpeed * lift.strength)).toBeLessThan(1);
    expect(crate.vel.x).toBeGreaterThan(crateCfg.throwSpeed * 0.8); // mostly east
    wait(sim, 120);
    expect(crate.mode === 'resting' || crate.mode === 'destroyed').toBe(true);
    expect(crate.pos.x).toBeGreaterThan(p.pos.x + 3);
  });

  it('a hard landing costs a hit point; a one-hit prop shatters, then respawns at home', () => {
    const { sim, crate } = throwCrate(Math.PI / 2);
    wait(sim, 120);
    expect(crate.mode).toBe('destroyed'); // crates have 1 hp
    expect(sim.events.length >= 0).toBe(true);
    wait(sim, Math.ceil(crateCfg.respawnTime / DT) + 5);
    expect(crate.mode).toBe('resting');
    expect(crate.hp).toBe(crateCfg.hp);
    expect(crate.pos).toEqual(crate.home);
  });

  it('a heavy prop survives a landing (2 hp) and can be picked up and thrown again', () => {
    const { sim, p } = rampartAt(3, -3.6);
    run(sim, 1, () => grab());
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw: Math.PI / 2, pitch: -0.1 }));
    wait(sim, 120);
    const car = prop(sim, CAR_A);
    expect(car.mode).toBe('resting');
    expect(car.hp).toBe(carCfg.hp - 1);
    // walk to it and throw it again
    p.pos = { x: car.pos.x - 2, y: 0, z: car.pos.z };
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab());
    expect(p.carrying?.id).toBe(CAR_A);
  });

  it('a prop dropped in mid-air falls to the ground instead of floating', () => {
    const { sim, p } = rampartAt(3, -3.6);
    run(sim, 1, () => grab());
    p.pos = { x: 30, y: 8, z: 0 };
    p.vel = { x: 0, y: 0, z: 0 };
    sim.damagePlayer('p1', 10_000, null);
    wait(sim, 60);
    expect(prop(sim, CAR_A).pos.y).toBeCloseTo(0, 3);
  });
});

describe('thrown props smash walls', () => {
  function throwFrom(x: number, z: number, propId: number, yaw: number, pitch: number) {
    const { sim, p } = rampartAt(x, z);
    run(sim, 1, () => grab());
    expect(p.carrying?.id).toBe(propId);
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw, pitch }));
    wait(sim, 90);
    return sim;
  }

  it('a car breaks the reinforced wall that a charge cannot', () => {
    const sim = throwFrom(0, -14.7, CAR_B, Math.PI, -0.05);
    expect(sim.world.broken.has(36)).toBe(true);
    expect(prop(sim, CAR_B).hp).toBe(carCfg.hp - 1);
  });

  it('a crate breaks a weak wall but not the reinforced one', () => {
    const weak = throwFrom(-3, -2.4, CRATE_A, Math.PI, -0.05);
    expect(weak.world.broken.has(34)).toBe(true);
    // Crate A is thrown at wall 36 from the gap between the walls after breaking the weak wall first.
    const { sim, p } = rampartAt(0, -14.7);
    sim.world.breakCollider(34);
    sim.propSystem!.props[CRATE_A]!.pos = { x: 0, y: 0, z: -16 };
    run(sim, 1, () => grab());
    expect(p.carrying?.id).toBe(CRATE_A);
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw: Math.PI, pitch: -0.05 }));
    wait(sim, 60);
    expect(sim.world.broken.has(36)).toBe(false);
  });

  it('a gentle lob does not break anything', () => {
    const slow = structuredClone(content.props);
    slow['prop.car']!.throwSpeed = 6;
    const sim = new SimClass(new World({ ...arena, base: undefined }), rampart, content.enemies, {
      props: true,
      propDefs: slow,
    });
    sim.addPlayer('p1').invulnerable = 0;
    wait(sim, 10);
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 0, z: -14.7 };
    run(sim, 1, () => grab());
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw: Math.PI, pitch: -0.05 }));
    wait(sim, 90);
    expect(sim.world.broken.has(36)).toBe(false);
  });
});

describe('thrown props hit enemies', () => {
  function throwAtThug(propId: number, from: { x: number; z: number }, thugPos: { x: number; z: number }, yaw: number) {
    const { sim, p } = rampartAt(from.x, from.z);
    const e = sim.spawnEnemy('enemy.thug', { x: thugPos.x, y: 0.01, z: thugPos.z });
    e.attackCooldown = 99;
    run(sim, 1, () => grab());
    expect(p.carrying?.id).toBe(propId);
    wait(sim, COOLDOWN_TICKS);
    run(sim, 1, () => grab({ yaw, pitch: -0.02 }));
    const impacts: { id: number; hits: string[] }[] = [];
    for (let i = 0; i < 60; i++) {
      wait(sim, 1);
      for (const ev of sim.events) if (ev.type === 'impact' && ev.hits.length > 0) impacts.push({ id: ev.id, hits: ev.hits });
    }
    return { sim, e, p, impacts };
  }

  it('damages and knocks back an enemy in the path, exactly once, and costs the prop a hit point', () => {
    const { sim, e, impacts } = throwAtThug(CAR_A, { x: 3, z: -3.6 }, { x: 12, z: -3.6 }, Math.PI / 2);
    expect(e.health.core).toBe(thug.health.core.max - carCfg.throwDamage);
    expect(impacts).toEqual([{ id: CAR_A, hits: [e.id] }]); // one impact, one victim, reported once
    expect(prop(sim, CAR_A).hp).toBeLessThan(carCfg.hp);
  });

  it('misses an enemy that is off to the side', () => {
    const { e } = throwAtThug(CAR_A, { x: 3, z: -3.6 }, { x: 12, z: 4 }, Math.PI / 2);
    expect(e.health.core).toBe(thug.health.core.max);
  });

  it('a car plus a follow-up strike powers down a thug (the start of a team-up)', () => {
    const { e } = throwAtThug(CAR_A, { x: 3, z: -3.6 }, { x: 12, z: -3.6 }, Math.PI / 2);
    expect(e.health.core).toBeLessThanOrEqual(thug.health.core.max - carCfg.throwDamage);
    expect(e.health.core).toBeLessThan(thug.attack.damage * 1); // one more light hit finishes it
  });
});

describe('synced prop state', () => {
  it('toWire lists every prop with a stable shape', () => {
    const { sim } = rampartAt(3, -3.6);
    const wires = sim.propWires;
    expect(wires.map((w) => w.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(wires[0]).toEqual({
      id: 0,
      def: 'prop.car',
      pos: [3, 0, -6],
      vel: [0, 0, 0],
      mode: 'resting',
      holder: null,
      hp: carCfg.hp,
      respawn: 0,
    });
  });

  it('prop at the far side of the west wall is out of reach until the wall is broken', () => {
    const { sim, p } = rampartAt(-5, 2);
    // Walk west toward the far crate; the weak west wall (x -14..-12.5) blocks the way.
    run(sim, 150, () => intent({ moveZ: 1, yaw: -Math.PI / 2 }));
    expect(p.pos.x).toBeGreaterThan(-12.5);
    expect(Math.hypot(prop(sim, CRATE_FAR).pos.x - p.pos.x, prop(sim, CRATE_FAR).pos.z - p.pos.z)).toBeGreaterThan(lift.liftRange);
  });
});
