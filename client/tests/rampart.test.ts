import arena from '@shared/levels/arena.json';
import { describe, expect, it } from 'vitest';
import { getHero } from '../src/data';
import { World } from '../src/sim/world';
import { content, DT, hero as ziplash, intent, makeSimFor, run } from './helpers';

const rampart = getHero('hero.bruiser');
const charge = rampart.charge!;
const thug = content.enemies['enemy.thug']!;

// Arena walls (collider ids): 34 = tier-1 wall in the south corridor (z -14..-12.5), 35 = tier-1 wall in the west
// corridor (x -14..-12.5), 36 = reinforced tier-2 wall in the south street (z -20..-18.5).
const SOUTH_WALL = 34;
const WEST_WALL = 35;
const REINFORCED = 36;

function rampartAt(x: number, z: number) {
  const sim = makeSimFor('hero.bruiser');
  run(sim, 10, () => intent());
  const p = sim.players.get('p1')!;
  p.pos = { x, y: 0, z };
  p.prevPos = { ...p.pos };
  return { sim, p };
}
const south = (extra = {}) => intent({ yaw: Math.PI, ...extra });

describe('RAMPART is a different hero from ZIPLASH', () => {
  it('has the powerhouse kit: charge and melee, but no swing, zip or snare', () => {
    expect(rampart.displayName).toBe('RAMPART');
    expect(rampart.charge).toBeDefined();
    expect(rampart.swing).toBeUndefined();
    expect(rampart.zip).toBeUndefined();
    expect(rampart.snare).toBeUndefined();
    expect(ziplash.charge).toBeUndefined();
  });

  it('is tougher, slower and bigger', () => {
    const total = (h: typeof rampart) => h.health.shield.max + h.health.core.max;
    expect(total(rampart)).toBeGreaterThan(total(ziplash) * 1.4);
    expect(rampart.movement.runSpeed).toBeLessThan(ziplash.movement.runSpeed);
    expect(rampart.movement.height).toBeGreaterThan(ziplash.movement.height);
    expect(rampart.movement.jumpSpeed ** 2 / (2 * rampart.movement.gravity)).toBeLessThan(
      ziplash.movement.jumpSpeed ** 2 / (2 * ziplash.movement.gravity),
    );
  });

  it('hits much harder in melee: one full combo powers down a thug', () => {
    const dmg = (h: typeof rampart) => h.melee.steps.reduce((a, s) => a + s.damage, 0);
    expect(dmg(rampart)).toBeGreaterThan(dmg(ziplash) * 1.5);
    expect(dmg(rampart)).toBeGreaterThanOrEqual(thug.health.core.max);
  });

  it('ignores ZIPLASH buttons: swing, zip and snare do nothing (and cost nothing)', () => {
    const { sim, p } = rampartAt(0, 0);
    const e = p.energy;
    run(sim, 30, () =>
      intent({ swingHeld: true, reelHeld: true, zipPressed: true, snarePressed: true, yaw: 0.5, pitch: -0.7 }),
    );
    expect(p.tether).toBeNull();
    expect(p.zip).toBeNull();
    expect(p.energy).toBe(e);
  });

  it('ZIPLASH ignores the charge button', () => {
    const sim = makeSimFor('hero.swinger');
    const p = sim.players.get('p1')!;
    run(sim, 5, () => intent({ chargePressed: true }));
    expect(p.charge).toBeNull();
    expect(p.energy).toBe(ziplash.energy.max);
  });
});

describe('charge', () => {
  it('rushes in the camera direction at charge speed for its duration, then ends', () => {
    const { sim, p } = rampartAt(30, 0); // open street intersection, nothing in the way to the east? use +Z
    const z0 = p.pos.z;
    run(sim, 1, () => intent({ chargePressed: true, yaw: 0 }));
    expect(p.charge).not.toBeNull();
    let maxSpeed = 0;
    for (let i = 0; i < 40; i++) {
      run(sim, 1, () => intent({ yaw: 0 }));
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.z));
    }
    expect(maxSpeed).toBeCloseTo(charge.speed, 3);
    expect(p.charge).toBeNull();
    const ran = p.pos.z - z0;
    expect(ran).toBeGreaterThan(charge.speed * charge.duration * 0.8);
    expect(ran).toBeLessThan(charge.speed * charge.duration * 1.4);
    expect(Math.abs(p.pos.x - 30)).toBeLessThan(1e-6);
  });

  it('costs energy, then is on cooldown, and also needs the energy', () => {
    const { sim, p } = rampartAt(30, 0);
    run(sim, 1, () => intent({ chargePressed: true }));
    expect(p.energy).toBeLessThanOrEqual(rampart.energy.max - charge.cost);
    expect(p.chargeCooldown).toBeGreaterThan(0);
    const first = p.charge;
    run(sim, 40, () => intent()); // charge over, still cooling down
    expect(p.charge).toBeNull();
    run(sim, 1, () => intent({ chargePressed: true }));
    expect(p.charge).toBeNull();
    expect(first).not.toBeNull();

    const { sim: s2, p: p2 } = rampartAt(30, 0);
    p2.energy = charge.cost - 1;
    run(s2, 1, () => intent({ chargePressed: true }));
    expect(p2.charge).toBeNull();
  });

  it('can be used again once the cooldown has passed', () => {
    const { sim, p } = rampartAt(30, 0);
    run(sim, 1, () => intent({ chargePressed: true }));
    run(sim, Math.ceil((charge.cooldown + 0.3) / DT), () => intent());
    p.energy = rampart.energy.max;
    run(sim, 1, () => intent({ chargePressed: true }));
    expect(p.charge).not.toBeNull();
  });

  it('cannot jump while charging, but steering is locked to the charge direction', () => {
    const { sim, p } = rampartAt(30, 0);
    run(sim, 1, () => intent({ chargePressed: true, yaw: 0 }));
    run(sim, 5, () => intent({ jumpPressed: true, moveX: 1, yaw: 0 }));
    expect(p.pos.y).toBe(0);
    expect(Math.abs(p.vel.x)).toBeLessThan(1e-9);
  });

  it('is stopped by a building', () => {
    const { sim, p } = rampartAt(0, 12); // building at x 7..17, z 7..17 is 7 m east
    run(sim, 1, () => intent({ chargePressed: true, yaw: Math.PI / 2 }));
    run(sim, 30, () => intent({ yaw: Math.PI / 2 }));
    expect(p.charge).toBeNull();
    expect(p.pos.x).toBeLessThanOrEqual(7 - rampart.movement.halfWidth + 1e-6);
    expect(sim.world.broken.size).toBe(0);
  });
});

describe('breakable walls', () => {
  it('a charge smashes a weak wall, emits a break event, and carries on through the gap', () => {
    const { sim, p } = rampartAt(0, -2);
    const events: string[] = [];
    run(sim, 1, () => south({ chargePressed: true }));
    for (let i = 0; i < 40; i++) {
      run(sim, 1, () => south());
      for (const ev of sim.events) if (ev.type === 'break') events.push(`${ev.type}:${ev.id}`);
    }
    expect(events).toEqual([`break:${SOUTH_WALL}`]);
    expect(sim.world.broken.has(SOUTH_WALL)).toBe(true);
    expect(sim.world.active.some((c) => c.id === SOUTH_WALL)).toBe(false);
    expect(p.pos.z).toBeLessThan(-14.5); // past where the wall stood (z -14 .. -12.5)
  });

  it('the wall really is solid for everyone until it breaks', () => {
    const sim = makeSimFor('hero.swinger');
    run(sim, 10, () => intent());
    const p = sim.players.get('p1')!;
    p.pos = { x: 0, y: 0, z: -2 };
    run(sim, 150, () => south({ moveZ: 1 }));
    expect(p.pos.z).toBeGreaterThan(-12.5);
    sim.world.breakCollider(SOUTH_WALL);
    run(sim, 150, () => south({ moveZ: 1 }));
    expect(p.pos.z).toBeLessThan(-14.5);
  });

  it('a reinforced wall stops the charge and survives it', () => {
    const { sim, p } = rampartAt(0, -16);
    run(sim, 1, () => south({ chargePressed: true }));
    run(sim, 40, () => south());
    expect(sim.world.broken.has(REINFORCED)).toBe(false);
    expect(p.pos.z).toBeCloseTo(-18.5 + rampart.movement.halfWidth, 1);
    expect(p.charge).toBeNull();
  });

  it('a stronger charge (an upgrade) would break it', () => {
    // Break power is data: this is the hook for the "Breaker armor" upgrade in the design doc.
    const strong = structuredClone(rampart);
    strong.charge!.breakPower = 2;
    const sim = makeSimFor('hero.bruiser');
    const p = sim.addPlayer('p1', strong); // re-adding a player gives them the upgraded hero
    p.invulnerable = 0;
    run(sim, 10, () => intent());
    p.pos = { x: 0, y: 0, z: -16 };
    run(sim, 1, () => south({ chargePressed: true }));
    run(sim, 40, () => south());
    expect(sim.world.broken.has(REINFORCED)).toBe(true);
  });

  it('a wall only breaks once, and the world tracks which', () => {
    const w = new World(arena);
    expect(w.breakCollider(WEST_WALL)).toBe(true);
    expect(w.breakCollider(WEST_WALL)).toBe(false);
    expect(w.breakCollider(0)).toBe(false); // the ground is not breakable
    expect(w.breakCollider(9999)).toBe(false);
    expect([...w.broken]).toEqual([WEST_WALL]);
  });

  it('rays go through broken walls (so tethers and aim see the gap)', () => {
    const w = new World(arena);
    const origin = { x: 0, y: 1.5, z: -9 };
    const dir = { x: 0, y: 0, z: -1 };
    expect(w.raycast(origin, dir, 20)!.collider.id).toBe(SOUTH_WALL);
    w.breakCollider(SOUTH_WALL);
    expect(w.raycast(origin, dir, 20)!.collider.id).toBe(REINFORCED);
  });

  it('setBroken replaces the set, unionBroken only adds, and both ignore unbreakable ids', () => {
    const w = new World(arena);
    w.unionBroken([SOUTH_WALL, 0, 12345]);
    expect([...w.broken]).toEqual([SOUTH_WALL]);
    w.unionBroken([WEST_WALL]);
    expect([...w.broken].sort()).toEqual([SOUTH_WALL, WEST_WALL]);
    w.unionBroken([]);
    expect(w.broken.size).toBe(2);
    const v = w.brokenVersion;
    w.setBroken([WEST_WALL]);
    expect([...w.broken]).toEqual([WEST_WALL]);
    expect(w.brokenVersion).toBeGreaterThan(v);
    const v2 = w.brokenVersion;
    w.setBroken([WEST_WALL]); // no change
    expect(w.brokenVersion).toBe(v2);
  });
});

describe('charging into enemies', () => {
  function chargeInto(thugs: { x: number; z: number }[]) {
    const { sim, p } = rampartAt(30, 0);
    const es = thugs.map((t) => sim.spawnEnemy('enemy.thug', { x: t.x, y: 0.01, z: t.z }));
    for (const e of es) e.attackCooldown = 99; // keep them passive for this test
    const events: string[] = [];
    run(sim, 1, () => intent({ chargePressed: true, yaw: 0 }));
    for (let i = 0; i < 40; i++) {
      run(sim, 1, () => intent({ yaw: 0 }));
      for (const ev of sim.events) if (ev.type === 'charge') events.push(ev.hits.join(','));
    }
    return { sim, p, es, events };
  }

  it('bowls over each enemy in the path exactly once, damaging and knocking them forward', () => {
    const { es, events } = chargeInto([
      { x: 30, z: 6 },
      { x: 30.5, z: 11 },
    ]);
    for (const e of es) {
      expect(e.health.core).toBe(thug.health.core.max - charge.damage);
      expect(e.pos.z).toBeGreaterThan(8);
    }
    expect(events.length).toBe(2); // two separate impacts, each reported once
  });

  it('does not hit enemies off to the side or behind', () => {
    const { es, events } = chargeInto([
      { x: 36, z: 6 },
      { x: 30, z: -5 },
    ]);
    expect(es.every((e) => e.health.core === thug.health.core.max)).toBe(true);
    expect(events).toEqual([]);
  });

  it('knocks the enemy off balance even through poise', () => {
    const { sim, p } = rampartAt(30, 0);
    const e = sim.spawnEnemy('enemy.thug', { x: 30, y: 0.01, z: 5 });
    e.poiseTimer = 5; // an ordinary hit could not stagger it
    run(sim, 1, () => intent({ chargePressed: true, yaw: 0 }));
    run(sim, 12, () => intent({ yaw: 0 }));
    expect(e.health.core).toBeLessThan(thug.health.core.max);
    expect(e.aiState === 'stagger' || e.aiTimer > 0 || e.pos.z > p.pos.z).toBe(true);
  });
});
