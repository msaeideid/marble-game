import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Two real browsers, one real Python server. Run with NET_E2E=1 (see playwright.config.ts).
 * Proves: players see each other, our own prediction agrees with the server (no corrections), and it keeps
 * agreeing under simulated network lag and jitter.
 */
test.skip(!process.env.NET_E2E, 'multiplayer tests need the Python server (NET_E2E=1)');

const SERVER = 'ws://127.0.0.1:8000/ws';
const contexts: BrowserContext[] = [];

/** Every test starts with an empty room: close our browsers, then wait for the server to notice they left. */
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  for (let i = 0; i < 100; i++) {
    const { players } = (await (await fetch('http://127.0.0.1:8000/health')).json()) as { players: number };
    if (players === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
});

async function join(browser: Browser, name: string, extra = ''): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`./?server=${encodeURIComponent(SERVER)}&name=${name}${extra}`);
  await page.locator('#overlay').click();
  await page.waitForFunction(() => window.__vanguard?.online?.status === 'online', undefined, { timeout: 15_000 });
  await page.waitForFunction(() => (window.__vanguard.online?.session.stats.acked ?? 0) > 0 || true);
  (page as Page & { errors: string[] }).errors = errors;
  return page;
}

const key = (page: Page, type: 'keydown' | 'keyup', code: string) =>
  page.evaluate(([t, c]) => window.dispatchEvent(new KeyboardEvent(t!, { code: c!, bubbles: true })), [type, code]);

async function scenario(browser: Browser, extra: string) {
  const a = await join(browser, 'Ann', extra);
  const b = await join(browser, 'Bo', extra);
  await Promise.all([a, b].map((p) => p.evaluate(() => window.__vanguard.setPaused(false))));

  // Ann runs up the street until she is level with the building on her right (position, not wall-clock time, so the
  // scenario is the same on a fast laptop and a slow CI runner), then swings off it.
  await key(a, 'keydown', 'KeyW');
  await a.waitForFunction(() => window.__vanguard.sim.players.get('local')!.pos.z > 11, undefined, { timeout: 20_000 });
  await key(a, 'keyup', 'KeyW');
  await a.evaluate(() => {
    const g = window.__vanguard;
    // Face the building on the right and look up at it.
    g.input.yaw = Math.PI / 2 - 0.4;
    g.input.pitch = -0.7;
  });
  await a.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true })));
  let sawTether = false;
  let sawHigh = false;
  // Bo watches (up to 10 s) for Ann's tether and for her to be lifted off the ground.
  for (let i = 0; i < 100 && !(sawTether && sawHigh); i++) {
    await b.waitForTimeout(100);
    const seen = await b.evaluate(() => {
      const others = Object.values(window.__vanguard.online!.remotePlayers());
      return others.map((o) => ({ y: o.state.pos[1]!, tether: o.state.tether !== null }));
    });
    sawTether ||= seen.some((o) => o.tether);
    sawHigh ||= seen.some((o) => o.y > 2);
  }
  await a.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true })));
  await a.waitForTimeout(1500);

  const aStats = await a.evaluate(() => {
    const o = window.__vanguard.online!;
    return { ...o.session.stats, players: o.playerCount, ping: o.pingMs, pos: window.__vanguard.sim.players.get('local')!.pos };
  });
  const seenByB = await b.evaluate(() => Object.values(window.__vanguard.online!.remotePlayers()).map((o) => o.state.pos));
  return { a, b, aStats, seenByB, sawTether, sawHigh };
}

test('two players see each other and prediction agrees with the Python server', async ({ browser }) => {
  const { a, b, aStats, seenByB, sawTether, sawHigh } = await scenario(browser, '');
  console.log('no-lag', JSON.stringify({ ...aStats, seenByB }));
  expect(aStats.players).toBe(2);
  expect(aStats.acked).toBeGreaterThan(100);
  expect(aStats.corrections).toBe(0);
  expect(aStats.maxError).toBeLessThan(1e-6);
  expect(sawTether).toBe(true); // Bo saw Ann's tether
  expect(sawHigh).toBe(true); // ...and saw her swing up into the air
  expect(seenByB.length).toBe(1);
  expect(seenByB[0]![2]).toBeGreaterThan(3); // she moved forward
  for (const p of [a, b]) expect((p as Page & { errors: string[] }).errors).toEqual([]);
});

test('prediction still agrees with the server under 100 ms lag and 30 ms jitter', async ({ browser }) => {
  const { a, aStats, sawHigh } = await scenario(browser, '&lag=100&jitter=30');
  console.log('lag', JSON.stringify(aStats));
  console.log('firstCorrection', JSON.stringify(await a.evaluate(() => window.__vanguard.online!.session.stats.firstCorrection)));
  console.log('lastCorrection', JSON.stringify(await a.evaluate(() => window.__vanguard.online!.session.stats.lastCorrection)));
  expect(aStats.corrections).toBe(0);
  expect(aStats.maxError).toBeLessThan(1e-6);
  expect(aStats.rttMs).toBeGreaterThan(190); // 2 x 100 ms of added latency is really being applied
  expect(sawHigh).toBe(true);
});

test('a fifth player is turned away', async ({ browser }) => {
  // Four lightweight raw-socket players fill the room (full game pages are heavy under software rendering)...
  const sockets: WebSocket[] = [];
  const opened = async (ws: WebSocket) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no welcome')), 15_000);
      ws.onmessage = (e) => {
        clearTimeout(t);
        resolve((JSON.parse(String(e.data)) as { t: string }).t);
      };
    });
  try {
    for (let i = 0; i < 4; i++) {
      const ws = new WebSocket(`${SERVER}?name=filler${i}`);
      sockets.push(ws);
      expect(await opened(ws)).toBe('welcome');
    }
    // ...and a real browser is the fifth.
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const extra = await ctx.newPage();
    await extra.goto(`./?server=${encodeURIComponent(SERVER)}&name=late`);
    await extra.waitForFunction(() => window.__vanguard?.online?.status === 'full', undefined, { timeout: 15_000 });
    expect(await extra.evaluate(() => window.__vanguard.online!.status)).toBe('full');
    await expect(extra.locator('#banner')).toHaveText('Server is full');
  } finally {
    for (const ws of sockets) ws.close();
  }
});
