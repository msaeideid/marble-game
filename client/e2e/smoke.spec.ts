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

test('hero select lists both heroes and RAMPART shows only its own controls', async ({ page }) => {
  await page.goto('./?hero=hero.bruiser');
  await expect(page.locator('#hero-select a')).toHaveText(['RAMPART', 'ZIPLASH']);
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
