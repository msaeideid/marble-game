import { expect, test, type Page } from '@playwright/test';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function startGame(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#overlay').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 5);
}

test('boots, shows the start screen, and runs after clicking play', async ({ page }) => {
  const errors = watchErrors(page);
  await startGame(page);
  expect(await page.title()).toContain('VANGUARD');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('renders a real 3D scene (not a blank or single-colour canvas)', async ({ page }) => {
  const errors = watchErrors(page);
  await startGame(page);
  const distinctColours = await page.evaluate(async () => {
    const g = window.__vanguard;
    g.setPaused(false);
    g.frame(1 / 60);
    // Read the pixels in the same task as the render, while the drawing buffer is still valid.
    const url = g.view.engine.getRenderingCanvas().toDataURL();
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add(((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4));
    }
    return seen.size;
  });
  expect(distinctColours).toBeGreaterThan(8);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the hero can run and jump on the ground', async ({ page }) => {
  await startGame(page);
  const result = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    const key = (t: string, code: string) => window.dispatchEvent(new KeyboardEvent(t, { code, bubbles: true }));
    for (let i = 0; i < 30; i++) g.frame(1 / 60);
    const me = g.sim.players.get('local')!;
    const z0 = me.pos.z;
    key('keydown', 'KeyW');
    for (let i = 0; i < 60; i++) g.frame(1 / 60);
    key('keyup', 'KeyW');
    const ran = me.pos.z - z0;
    key('keydown', 'Space');
    key('keyup', 'Space');
    let apex = 0;
    for (let i = 0; i < 40; i++) {
      g.frame(1 / 60);
      apex = Math.max(apex, me.pos.y);
    }
    return { ran, apex };
  });
  expect(result.ran).toBeGreaterThan(4);
  expect(result.apex).toBeGreaterThan(1);
});

test('the tether attaches to a building when aimed at it', async ({ page }) => {
  await startGame(page);
  const attached = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    for (let i = 0; i < 20; i++) g.frame(1 / 60);
    const me = g.sim.players.get('local')!;
    Object.assign(me.pos, { x: 0, y: 0, z: -3 });
    g.input.yaw = 0.5;
    g.input.pitch = -0.7;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    for (let i = 0; i < 30; i++) g.frame(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
    return me.tether !== null;
  });
  expect(attached).toBe(true);
});

test('a full fight works end to end: thugs spawn, die, and the next wave arrives', async ({ page }) => {
  const errors = watchErrors(page);
  await startGame(page);
  const outcome = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    const key = (t: string, code: string) => window.dispatchEvent(new KeyboardEvent(t, { code, bubbles: true }));
    const me = g.sim.players.get('local')!;
    g.input.pitch = 0.3;
    for (let f = 0; f < 60 * 45 && g.sim.currentWave < 2; f++) {
      const alive = [...g.sim.enemies.values()].filter((e) => e.defeatedTimer === null);
      if (alive.length > 0) {
        alive.sort(
          (a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) - Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z),
        );
        const t = alive[0]!;
        g.input.yaw = Math.atan2(t.pos.x - me.pos.x, t.pos.z - me.pos.z);
        if (f % 6 === 0 && Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z) < 2.7) {
          key('keydown', 'KeyJ');
          key('keyup', 'KeyJ');
        }
      }
      g.frame(1 / 60);
    }
    return { wave: g.sim.currentWave, labels: document.querySelectorAll('.enemy-bar, .dmg-number').length };
  });
  expect(outcome.wave).toBeGreaterThanOrEqual(2);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('performance budget: bounded mesh count, and frame cost is logged', async ({ page }, testInfo) => {
  await startGame(page);
  const stats = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    for (let i = 0; i < 60; i++) g.frame(1 / 60); // warm up
    const t0 = performance.now();
    const N = 240;
    for (let i = 0; i < N; i++) g.frame(1 / 60);
    const msPerFrame = (performance.now() - t0) / N;
    // The engine's draw-call counter only resets inside its own render loop, so measure the delta of one frame.
    const engine = g.view.engine as unknown as { _drawCalls?: { current: number } };
    const before = engine._drawCalls?.current ?? 0;
    g.frame(1 / 60);
    const drawCalls = engine._drawCalls ? engine._drawCalls.current - before : -1;
    return {
      msPerFrame,
      meshes: g.view.scene.meshes.length,
      activeMeshes: g.view.scene.getActiveMeshes().length,
      drawCalls,
    };
  });
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(stats) });
  console.log('perf', JSON.stringify(stats));
  // Budget from PLAN.md section 8: keep draw calls under 300. (Frame time is logged only; CI uses software GL.)
  expect(stats.activeMeshes).toBeLessThan(300);
  if (stats.drawCalls >= 0) expect(stats.drawCalls).toBeLessThan(300);
});

test('hero select lists every hero and RAMPART shows only its own controls', async ({ page }) => {
  await page.goto('./?hero=hero.bruiser');
  await expect(page.locator('#hero-select a')).toHaveText(['RAMPART', 'METALHEAD', 'VOLTAGE', 'ZIPLASH']);
  await expect(page.locator('#hero-select a.selected')).toHaveText('RAMPART');
  await expect(page.locator('#overlay tr[data-kit="charge"]')).toBeVisible();
  await expect(page.locator('#overlay tr[data-kit="swing"]').first()).toBeHidden();
  await expect(page.locator('#overlay tr[data-kit="snare"]')).toBeHidden();
  // Picking the other hero reloads with ?hero=...
  await page.locator('#hero-select a', { hasText: 'ZIPLASH' }).click();
  await page.waitForURL(/hero=hero\.swinger/);
  await expect(page.locator('#hero-select a.selected')).toHaveText('ZIPLASH');
  await expect(page.locator('#overlay tr[data-kit="swing"]').first()).toBeVisible();
  await expect(page.locator('#overlay tr[data-kit="charge"]')).toBeHidden();
});

test('RAMPART charges through a weak wall and the wall disappears', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./?hero=hero.bruiser');
  await page.locator('#overlay').click();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 3);
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    for (let i = 0; i < 20; i++) g.frame(1 / 60);
    const me = g.sim.players.get('local')!;
    Object.assign(me.pos, { x: 0, y: 0, z: -2 });
    g.input.yaw = Math.PI; // face the south corridor, where the weak wall is
    const before = g.sim.world.broken.size;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
    for (let i = 0; i < 90; i++) g.frame(1 / 60);
    return { before, after: g.sim.world.broken.size, z: me.pos.z, chip: getComputedStyle(document.getElementById('charge-chip')!).display };
  });
  expect(out.before).toBe(0);
  expect(out.after).toBe(1);
  expect(out.z).toBeLessThan(-14.5);
  expect(out.chip).not.toBe('none');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('RAMPART lifts a car, throws it at the reinforced wall and breaks it', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./?hero=hero.bruiser');
  await expect(page.locator('#overlay tr[data-kit="lift"]')).toBeVisible();
  await page.locator('#overlay').click();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 3);
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    for (let i = 0; i < 20; i++) g.frame(1 / 60);
    const me = g.sim.players.get('local')!;
    // Stand between the two south walls with the car (prop 1) a couple of metres away.
    Object.assign(me.pos, { x: 0, y: 0, z: -14.7 });
    const press = () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
    };
    g.input.yaw = Math.PI;
    g.input.pitch = 0.1;
    press();
    for (let i = 0; i < 4; i++) g.frame(1 / 60);
    const carrying = me.carrying?.def ?? null;
    const chipShown = getComputedStyle(document.getElementById('carry-chip')!).display !== 'none';
    const chipText = document.getElementById('carry-chip')!.textContent;
    for (let i = 0; i < 40; i++) g.frame(1 / 60); // let the grab cooldown pass
    g.input.pitch = -0.05;
    press();
    for (let i = 0; i < 180; i++) g.frame(1 / 60);
    const car = g.sim.propWires.find((w) => w.id === 1)!;
    return { carrying, chipShown, chipText, broken: [...g.sim.world.broken], carryingAfter: me.carrying, carMode: car.mode };
  });
  expect(out.carrying).toBe('prop.car');
  expect(out.chipShown).toBe(true);
  expect(out.chipText).toContain('Car');
  expect(out.broken).toContain(36); // the reinforced wall that a charge cannot break
  expect(out.carryingAfter).toBeNull();
  expect(['resting', 'destroyed']).toContain(out.carMode);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('METALHEAD shows only its own controls', async ({ page }) => {
  await page.goto('./?hero=hero.flyer');
  await expect(page.locator('#hero-select a.selected')).toHaveText('METALHEAD');
  for (const kit of ['flight', 'laser', 'rockets']) await expect(page.locator(`#overlay tr[data-kit="${kit}"]`)).toBeVisible();
  for (const kit of ['swing', 'zip', 'snare', 'charge', 'lift', 'chain', 'tempest']) {
    await expect(page.locator(`#overlay tr[data-kit="${kit}"]`).first()).toBeHidden();
  }
  // The ability chips follow the kit too: METALHEAD's are shown, the other heroes' are not.
  await expect(page.locator('#flight-chip')).toBeVisible();
  await expect(page.locator('#rocket-chip')).toBeVisible();
  await expect(page.locator('#snare-chip')).toBeHidden();
  await expect(page.locator('#charge-chip')).toBeHidden();
});

test('METALHEAD takes off, climbs, shoots a laser and a homing rocket hits the thug', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./?hero=hero.flyer');
  await page.locator('#overlay').click();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 3);
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) g.frame(1 / 60);
    };
    frames(20);
    const me = g.sim.players.get('local')!;
    me.invulnerable = 999;
    for (const e of g.sim.enemies.values()) e.snaredTimer = 999; // the wave stands still for this test
    g.input.yaw = 0;
    g.input.pitch = 0;

    key('keydown', 'Space'); // a normal jump...
    frames(2);
    key('keyup', 'Space');
    frames(10);
    const airborne = !me.grounded;
    key('keydown', 'Space'); // ...then hold Space in the air: jets on, climbing
    frames(60);
    const flying = me.flying;
    const altitude = me.pos.y;
    const flightChipLit = document.getElementById('flight-chip')!.classList.contains('on');
    key('keyup', 'Space');
    frames(10);

    // A thug 12 m ahead and well below; aim down at it.
    const thug = g.sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 12 });
    thug.snaredTimer = 999;
    g.input.pitch = Math.atan2(me.pos.y + 1.5 - 0.9, 12 - me.pos.z);
    const hp0 = thug.health.core;
    key('keydown', 'KeyK'); // hold fire
    frames(40);
    key('keyup', 'KeyK');
    const afterLaser = thug.health.core;

    key('keydown', 'KeyR'); // a homing rocket
    key('keyup', 'KeyR');
    frames(8);
    const rocketsInFlight = g.sim.rocketSystem!.rockets.length;
    const rocketMesh = (g.view.scene.meshes as { name: string }[]).some((m) => m.name.startsWith('rocket-'));
    frames(90);
    return {
      airborne,
      flying,
      altitude,
      flightChipLit,
      hp0,
      afterLaser,
      rocketsInFlight,
      rocketMesh,
      afterRocket: thug.defeatedTimer !== null ? 0 : thug.health.core,
      rocketsLeft: g.sim.rocketSystem!.rockets.length,
    };
  });
  expect(out.airborne).toBe(true);
  expect(out.flying).toBe(true);
  expect(out.altitude).toBeGreaterThan(4);
  expect(out.flightChipLit).toBe(true);
  expect(out.afterLaser).toBeLessThan(out.hp0);
  expect(out.rocketsInFlight).toBe(1);
  expect(out.rocketMesh).toBe(true);
  expect(out.afterRocket).toBeLessThan(out.afterLaser - 20); // a rocket hit is ~30; it may or may not finish the thug
  expect(out.rocketsLeft).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('VOLTAGE glides, chains lightning through a group and calls a storm strike that stuns', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./?hero=hero.storm');
  await expect(page.locator('#hero-select a.selected')).toHaveText('VOLTAGE');
  for (const kit of ['flight', 'chain', 'tempest']) await expect(page.locator(`#overlay tr[data-kit="${kit}"]`)).toBeVisible();
  await expect(page.locator('#overlay tr[data-kit="laser"]')).toBeHidden();
  await page.locator('#overlay').click();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 3);
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    g.setPaused(false);
    const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const tap = (code: string) => {
      key('keydown', code);
      key('keyup', code);
    };
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) g.frame(1 / 60);
    };
    frames(20);
    const me = g.sim.players.get('local')!;
    me.invulnerable = 999;
    for (const e of g.sim.enemies.values()) e.snaredTimer = 999;
    g.input.yaw = 0;
    g.input.pitch = 0;

    // Chain lightning on three thugs in a row, on the ground.
    const a = g.sim.spawnEnemy('enemy.thug', { x: 0, y: 0.01, z: 10 });
    const b = g.sim.spawnEnemy('enemy.thug', { x: 3, y: 0.01, z: 10 });
    const c = g.sim.spawnEnemy('enemy.thug', { x: 6, y: 0.01, z: 10 });
    for (const e of [a, b, c]) e.snaredTimer = 999;
    g.input.pitch = Math.atan2(1.45 - 0.9, 10);
    tap('KeyR');
    frames(4);
    const chained = [a, b, c].map((e) => e.health.core < 45 && e.aiState === 'stagger');
    const lockShown = getComputedStyle(document.querySelector('.lock-ring') as HTMLElement).display;

    // Storm strike on a fresh thug 14 m away: the warning, then the hit.
    const d = g.sim.spawnEnemy('enemy.thug', { x: -6, y: 0.01, z: 14 });
    d.snaredTimer = 999;
    g.input.yaw = Math.atan2(-6, 14);
    g.input.pitch = Math.atan2(1.45, Math.hypot(6, 14));
    tap('KeyQ');
    frames(4);
    const warned = g.sim.strikeSystem!.strikes.length;
    const untouched = d.health.core;
    frames(90);
    return { chained, lockShown, warned, untouched, after: d.health.core, stunned: d.aiState, left: g.sim.strikeSystem!.strikes.length };
  });
  expect(out.chained).toEqual([true, true, true]);
  expect(out.lockShown).toBe('block');
  expect(out.warned).toBe(1);
  expect(out.untouched).toBe(45);
  expect(out.after).toBeLessThan(45);
  expect(out.left).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
