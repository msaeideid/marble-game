import { describe, expect, it } from 'vitest';
import { DT, hero, intent, makeSim, run } from './helpers';
import arena from '@shared/levels/arena.json';
import { World } from '../src/sim/world';

const params = hero.movement;


describe('player controller', () => {
  it('lands on the ground and reports grounded', () => {
    const sim = makeSim();
    run(sim, 10, () => intent());
    const p = sim.players.get('p1')!;
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeCloseTo(0, 5);
  });

  it('runs forward at run speed (yaw 0 = +Z)', () => {
    const sim = makeSim();
    run(sim, 10, () => intent());
    run(sim, 20, () => intent({ moveZ: 1 }));
    const p = sim.players.get('p1')!;
    expect(p.vel.z).toBeCloseTo(params.runSpeed, 3);
    expect(p.vel.x).toBeCloseTo(0, 5);
    expect(p.pos.z).toBeGreaterThan(3);
  });

  it('moves relative to camera yaw', () => {
    const sim = makeSim();
    run(sim, 10, () => intent());
    run(sim, 20, () => intent({ moveZ: 1, yaw: Math.PI / 2 }));
    const p = sim.players.get('p1')!;
    expect(p.vel.x).toBeCloseTo(params.runSpeed, 3);
    expect(Math.abs(p.vel.z)).toBeLessThan(1e-6);
  });

  it('does not exceed run speed on diagonals', () => {
    const sim = makeSim();
    run(sim, 30, () => intent({ moveX: 1, moveZ: 1 }));
    const p = sim.players.get('p1')!;
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeLessThanOrEqual(params.runSpeed + 1e-6);
  });

  it('jumps to roughly the expected apex and lands again', () => {
    const sim = makeSim();
    run(sim, 10, () => intent());
    let apex = 0;
    run(sim, 40, (i) => {
      apex = Math.max(apex, sim.players.get('p1')!.pos.y);
      return intent({ jumpPressed: i === 0 });
    });
    const expected = (params.jumpSpeed * params.jumpSpeed) / (2 * params.gravity);
    expect(apex).toBeGreaterThan(expected * 0.85);
    expect(apex).toBeLessThan(expected * 1.1);
    expect(sim.players.get('p1')!.grounded).toBe(true);
  });

  it('allows a jump shortly after walking off a ledge (coyote time)', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    run(sim, 10, () => intent());
    // Teleport onto a ledge edge by running east onto the first stair, then off its far side is complex;
    // instead emulate: grounded last tick, airborne now, jump pressed within coyote window.
    p.grounded = true;
    sim.step(DT, new Map([['p1', intent()]]));
    p.grounded = false;
    p.pos.y += 0.5;
    p.vel.y = 0;
    sim.step(DT, new Map([['p1', intent({ jumpPressed: true })]]));
    expect(p.vel.y).toBeGreaterThan(params.jumpSpeed * 0.8);
  });

  it('cannot walk through a building wall', () => {
    const sim = makeSim();
    // Building at x:[7,17], z:[7,17]. Start in the street, run +X along z=10? z=10 is inside that block's z range.
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 0, z: 12 };
    run(sim, 60, () => intent({ moveZ: 1, yaw: Math.PI / 2 }));
    expect(p.pos.x).toBeLessThanOrEqual(7 - params.halfWidth + 1e-6);
    expect(p.vel.x).toBe(0);
  });

  it('can jump onto the first stair step but not the third from the ground', () => {
    const sim = makeSim();
    run(sim, 10, () => intent());
    const p = sim.players.get('p1')!;
    // Stairs start at x=6, heights 1.2, 2.4, 3.6, 4.8.
    p.pos = { x: 4.5, y: 0, z: 0 };
    run(sim, 3, () => intent());
    run(sim, 40, (i) => intent({ moveZ: 1, yaw: Math.PI / 2, jumpPressed: i === 3 }));
    expect(p.pos.y).toBeCloseTo(1.2, 3);
  });

  it('is deterministic for identical inputs', () => {
    const script = (i: number) =>
      intent({ moveX: Math.sin(i / 7), moveZ: Math.cos(i / 5), yaw: i / 30, jumpPressed: i % 23 === 0 });
    const a = makeSim();
    const b = makeSim();
    run(a, 300, script);
    run(b, 300, script);
    expect(a.players.get('p1')).toEqual(b.players.get('p1'));
  });

  it('does not tunnel through the ground at terminal velocity', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 500, z: 0 };
    run(sim, 700, () => intent());
    expect(p.pos.y).toBeGreaterThanOrEqual(-1e-6);
    expect(p.grounded).toBe(true);
  });

  it('respawns a player who falls into the void', () => {
    const sim = makeSim();
    const p = sim.players.get('p1')!;
    p.pos = { x: 300, y: 5, z: 300 }; // beyond the ground slab
    run(sim, 60, () => intent());
    expect(Math.abs(p.pos.x)).toBeLessThan(1);
  });
});

describe('raycast', () => {
  const world = new World(arena);

  it('hits the ground from above with an upward normal', () => {
    const hit = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5, 5);
    expect(hit!.normal).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('hits a building wall facing the ray', () => {
    // Building x:[7,17], z:[7,17] (height > 2). Ray from x=0 toward +X at z=10, y=1.
    const hit = world.raycast({ x: 0, y: 1, z: 10 }, { x: 1, y: 0, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(7, 5);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('returns null when nothing is in range', () => {
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 100)).toBeNull();
  });
});
