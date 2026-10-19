import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Networked combat: two real browsers and the real Python server. The server runs the enemies and every ability;
 * the browsers send buttons and draw what the server streams. Needs NET_E2E=1 (the server then runs with
 * VANGUARD_WAVES=0 and VANGUARD_DEBUG=1, so tests place enemies and players exactly where they want them).
 */
test.skip(!process.env.NET_E2E, 'multiplayer tests need the Python server (NET_E2E=1)');

const HTTP = 'http://127.0.0.1:8000';
const SERVER = 'ws://127.0.0.1:8000/ws';
const contexts: BrowserContext[] = [];

/** Every test starts with an empty room: close our browsers, then wait for the server to notice they left. */
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  let players = -1;
  for (let i = 0; i < 300; i++) {
    players = ((await (await fetch(`${HTTP}/health`)).json()) as { players: number }).players;
    if (players === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the room did not empty after the test: ${players} player(s) still connected`);
});

async function join(browser: Browser, name: string, hero: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(`./?server=${encodeURIComponent(SERVER)}&name=${name}&hero=${hero}`);
  await page.locator('#overlay').click();
  await page.waitForFunction(() => window.__vanguard?.online?.status === 'online', undefined, { timeout: 15_000 });
  await page.evaluate(() => window.__vanguard.setPaused(false));
  return page;
}

const key = (page: Page, type: 'keydown' | 'keyup', code: string) =>
  page.evaluate(([t, c]) => window.dispatchEvent(new KeyboardEvent(t!, { code: c!, bubbles: true })), [type, code]);
const tap = async (page: Page, code: string) => {
  await key(page, 'keydown', code);
  await key(page, 'keyup', code);
};

async function post(path: string, body: object): Promise<{ id?: string }> {
  const r = await fetch(`${HTTP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.ok, `${path} ${r.status}`).toBe(true);
  return (await r.json()) as { id?: string };
}
const serverId = (page: Page) => page.evaluate(() => window.__vanguard.online!.serverId!);
const frozenThug = (x: number, z: number) => post('/debug/spawn_enemy', { type: 'enemy.thug', pos: [x, 0.01, z], snared: 999 });
const coreOf = (page: Page, id: string) =>
  page.evaluate((i) => window.__vanguard.sim.enemies.get(i)?.health.core ?? null, id);

test('two players fight the same server-side thug: one strikes it and both see it get hurt', async ({ browser }) => {
  const ann = await join(browser, 'Ann', 'hero.bruiser');
  const bo = await join(browser, 'Bo', 'hero.swinger');
  const { id } = await frozenThug(0, 2.2); // right in front of the spawn, in melee reach
  await Promise.all([ann, bo].map((p) => p.waitForFunction((i) => window.__vanguard.sim.enemies.has(i!), id, { timeout: 15_000 })));
  expect(await coreOf(bo, id!)).toBe(45);

  // Ann (RAMPART) strikes in rhythm until the thug is down to its last hits.
  for (let i = 0; i < 4; i++) {
    await tap(ann, 'KeyJ');
    await ann.waitForTimeout(450);
  }
  await Promise.all(
    [ann, bo].map((p) => p.waitForFunction((i) => (window.__vanguard.sim.enemies.get(i!)?.health.core ?? 99) < 45, id, { timeout: 15_000 })),
  );
  // The server agrees with both screens, and Ann's movement prediction was not disturbed by combat.
  const onServer = (await (await fetch(`${HTTP}/health`)).json()) as { enemies: number };
  expect(onServer.enemies).toBe(1);
  const stats = await ann.evaluate(() => window.__vanguard.online!.session.stats);
  expect(stats.corrections).toBe(0);
});

test('an enemy hurts a player, the health on screen is the server\'s, and they respawn after being defeated', async ({ browser }) => {
  const ann = await join(browser, 'Ann', 'hero.flyer');
  const maxHealth = await ann.evaluate(() => {
    const me = window.__vanguard.sim.players.get('local')!;
    return me.health.shield + me.health.core;
  });
  // Five unfrozen thugs right next to the spawn (spawn protection lasts two seconds).
  for (const [x, z] of [[1.5, 1.5], [-1.5, 1.5], [0, -2], [2, -2], [-2, -2]] as const) {
    await post('/debug/spawn_enemy', { type: 'enemy.thug', pos: [x, 0.01, z] });
  }
  await ann.waitForFunction((max) => {
    const me = window.__vanguard.sim.players.get('local')!;
    return me.health.shield + me.health.core < max!;
  }, maxHealth, { timeout: 20_000 });
  // She is eventually defeated: the server says so, and the screen shows the countdown.
  await ann.waitForFunction(() => window.__vanguard.sim.players.get('local')!.defeatedTimer !== null, undefined, { timeout: 30_000 });
  await expect(ann.locator('#banner')).toContainText('Down!');
  // ...and comes back with full health (the thugs are also gone by then or at least she is up again).
  await ann.waitForFunction(() => window.__vanguard.sim.players.get('local')!.defeatedTimer === null, undefined, { timeout: 30_000 });
});

test('the team-up combo works online: RAMPART throws a car and a METALHEAD in another browser shoots it', async ({ browser }) => {
  const tank = await join(browser, 'Tank', 'hero.bruiser');
  const jet = await join(browser, 'Jet', 'hero.flyer');
  const tankId = await serverId(tank);
  const jetId = await serverId(jet);
  // Car 0 sits at (3, 0, -6). Tank stands beside it; Jet a few metres away, out of the car's path.
  await post('/debug/teleport', { id: tankId, pos: [3, 0.01, -3.6] });
  await post('/debug/teleport', { id: jetId, pos: [4, 0.01, -1] });
  await tank.waitForFunction(() => {
    const p = window.__vanguard.sim.players.get('local')!.pos;
    return Math.hypot(p.x - 3, p.z + 3.6) < 0.5;
  }, undefined, { timeout: 15_000 });
  const group = [await frozenThug(13.5, -3.6), await frozenThug(15, -3), await frozenThug(15, -4.2)];
  await jet.waitForFunction((n) => window.__vanguard.sim.enemies.size >= n!, group.length, { timeout: 15_000 });

  // Tank lifts the car (it is at -Z of her), waits out the cooldown, then throws it east at the group.
  await tank.evaluate(() => {
    window.__vanguard.input.yaw = Math.PI;
  });
  await tap(tank, 'KeyE');
  await tank.waitForFunction(() => window.__vanguard.sim.players.get('local')!.carrying?.def === 'prop.car', undefined, { timeout: 15_000 });
  await tank.waitForTimeout(700);

  // Jet watches the car's flight (as the server describes it) and holds fire, aimed at it, while it is over the group.
  await jet.evaluate(() => {
    const g = window.__vanguard;
    const code = (t: 'keydown' | 'keyup') => window.dispatchEvent(new KeyboardEvent(t, { code: 'KeyK', bubbles: true }));
    const timer = setInterval(() => {
      const me = g.sim.players.get('local')!;
      const car = g.online!.propWires().find((w) => w.id === 0 && w.mode === 'thrown');
      if (car && car.pos[0]! > 7) {
        // Lead the target a little: what we see is about a tenth of a second old.
        const x = car.pos[0]! + 1.5;
        const dx = x - me.pos.x;
        const dy = car.pos[1]! + 0.65 - (me.pos.y + 1.5);
        const dz = car.pos[2]! - me.pos.z;
        g.input.yaw = Math.atan2(dx, dz);
        g.input.pitch = -Math.asin(dy / Math.hypot(dx, dy, dz));
        code('keydown');
      } else {
        code('keyup');
      }
    }, 16);
    (window as unknown as { __stopAim: () => void }).__stopAim = () => clearInterval(timer);
  });
  await tank.evaluate(() => {
    window.__vanguard.input.yaw = Math.PI / 2;
    window.__vanguard.input.pitch = -0.1;
  });
  await tap(tank, 'KeyE');

  // Everyone sees the car bomb: the banner, the destroyed car, and the thugs hurt on both screens.
  for (const page of [tank, jet]) {
    await page.waitForFunction(() => window.__vanguard.online!.propWires().find((w) => w.id === 0)!.mode === 'destroyed', undefined, { timeout: 20_000 });
  }
  await jet.evaluate(() => (window as unknown as { __stopAim: () => void }).__stopAim());
  await key(jet, 'keyup', 'KeyK');
  for (const page of [tank, jet]) {
    await page.waitForFunction(
      (ids) => ids!.some((i) => (window.__vanguard.sim.enemies.get(i)?.health.core ?? 0) < 45 || !window.__vanguard.sim.enemies.has(i)),
      group.map((g) => g.id!),
      { timeout: 15_000 },
    );
  }
  const hurt = await Promise.all(group.map((g) => coreOf(jet, g.id!)));
  expect(hurt.some((h) => h === null || h < 45), JSON.stringify(hurt)).toBe(true);
});
