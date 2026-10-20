import { expect, test, type Page } from '@playwright/test';

/** The campaign end to end in the production build: the menu, a mission from briefing to results card, failing a challenge, VASTOR's escape, and spending scrap in the upgrade bay. */

const KEY = 'vanguard.save.v1';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Start the page with a save already in browser storage (only if there is none yet, so progress survives reloads). */
async function withSave(page: Page, save: object): Promise<void> {
  await page.addInitScript(([k, v]) => {
    if (!localStorage.getItem(k!)) localStorage.setItem(k!, v!);
  }, [KEY, JSON.stringify(save)]);
}

const saved = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as { scrap: number; xp: number; completed: Record<string, number>; upgrades: string[]; flags: string[] } | null, KEY);

async function begin(page: Page, query: string): Promise<void> {
  await page.goto(`./?${query}`);
  await page.locator('#overlay .go').click();
  await page.waitForFunction(() => (window.__vanguard?.sim.tick ?? 0) > 3);
  await page.evaluate(() => window.__vanguard.setPaused(false));
}

const TUTORIAL_DONE = { version: 1, scrap: 30, xp: 60, completed: { 'mission.tutorial': 1 }, upgrades: [], flags: ['tutorialDone'] };

test('the campaign menu lists the story, locks what is not ready and says why', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./?tab=campaign');
  await expect(page.locator('#tab-campaign')).toBeVisible();
  await expect(page.locator('#tab-play')).toBeHidden();
  const training = page.locator('.mission-card:has(.mc-head b:text-is("Training Day"))');
  await expect(training.locator('a.play')).toBeVisible();
  const vastor = page.locator('.mission-card:has(.mc-head b:text-is("The Worldbreaker"))');
  await expect(vastor).toHaveClass(/locked/);
  await expect(vastor).toContainText('finish Training Day');
  await expect(vastor).toContainText('reach level 3');
  await expect(page.locator('.chapter h3')).toContainText(['Brightport', 'Sugarworks', 'Cloudspire', 'Gearhollow', 'The Shard Engine']);
  await expect(page.locator('a.play.wide')).toContainText('Free roam');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Training Day: play it through, get the results card, and the save and the next missions follow', async ({ page }) => {
  const errors = watchErrors(page);
  await begin(page, 'mission=mission.tutorial&hero=hero.bruiser');
  await expect(page.locator('#mission-title')).toHaveText('Training Day');
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    const key = (t: string, c: string) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
    const tap = (c: string) => {
      key('keydown', c);
      key('keyup', c);
    };
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) g.frame(1 / 30);
    };
    const me = g.sim.players.get('local')!;
    me.invulnerable = 999;
    const knockOut = () => {
      g.sim.events = [];
      for (const e of [...g.sim.enemies.values()]) g.sim.damageEnemy(e, 999, 'local');
      g.session!.onStep(g.sim.events, 1 / 30); // (in play the damage happens inside a step, which the session sees)
    };
    const stages: number[] = [];
    frames(5);
    key('keydown', 'KeyW');
    frames(75);
    key('keyup', 'KeyW');
    stages.push(g.session!.runner!.index); // moved
    tap('Space');
    frames(30);
    tap('Space');
    frames(30);
    stages.push(g.session!.runner!.index); // jumped
    for (let i = 0; i < 6; i++) {
      tap('KeyJ');
      frames(12);
    }
    stages.push(g.session!.runner!.index); // struck
    tap('KeyC'); // RAMPART's charge is her special
    frames(110);
    tap('KeyC');
    frames(30);
    stages.push(g.session!.runner!.index); // special
    frames(5);
    const thugs = g.sim.enemies.size;
    knockOut();
    frames(40);
    stages.push(g.session!.runner!.index); // fought
    me.pos.x = 0;
    me.pos.z = 38;
    me.pos.y = 0.2;
    frames(5);
    return { stages, thugs, status: g.session!.runner!.status, over: g.session!.over };
  });
  expect(out.stages).toEqual([1, 2, 3, 4, 5]);
  expect(out.thugs).toBe(3);
  expect(out.status).toBe('complete');
  expect(out.over).toBe(true);
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result h2')).toHaveText('Mission complete!');
  await expect(page.locator('#result')).toContainText('scrap');
  const s = (await saved(page))!;
  expect(s.completed['mission.tutorial']).toBe(1);
  expect(s.flags).toContain('tutorialDone');
  expect(s.scrap).toBeGreaterThanOrEqual(30);
  // The game stays stopped behind the card.
  const tick = await page.evaluate(() => window.__vanguard.sim.tick);
  await page.evaluate(() => window.__vanguard.frame(1 / 30));
  expect(await page.evaluate(() => window.__vanguard.sim.tick)).toBe(tick);
  // Back in the menu the city challenges have opened up.
  await page.locator('#result a', { hasText: 'Continue' }).click();
  await page.locator('#overlay').waitFor({ state: 'visible' });
  await expect(page.locator('.mission-card:has(.mc-head b:text-is("Thug Rush"))').locator('a.play')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a no-damage challenge fails the moment you are hit, keeps your loot, and offers a retry', async ({ page }) => {
  const errors = watchErrors(page);
  await withSave(page, TUTORIAL_DONE);
  await begin(page, 'mission=mission.challenge.untouchable&hero=hero.bruiser');
  const status = await page.evaluate(() => {
    const g = window.__vanguard;
    const me = g.sim.players.get('local')!;
    me.invulnerable = 0;
    for (let i = 0; i < 6; i++) g.frame(1 / 30);
    // Stand right next to the thugs and let them swing.
    me.pos.x = 0;
    me.pos.z = 19;
    for (let i = 0; i < 300 && !g.session!.over; i++) g.frame(1 / 30);
    return g.session!.runner!.status;
  });
  expect(status).toBe('failed');
  await expect(page.locator('#result h2')).toHaveText('Challenge failed');
  await expect(page.locator('#result')).toContainText('hit');
  await expect(page.locator('#result a', { hasText: 'Try again' })).toBeVisible();
  expect((await saved(page))!.completed['mission.challenge.untouchable']).toBeUndefined();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('The Worldbreaker: VASTOR appears after his shards, escapes at a third of his health, and the city changes', async ({ page }) => {
  const errors = watchErrors(page);
  await withSave(page, { ...TUTORIAL_DONE, xp: 200 }); // level 3
  await begin(page, 'mission=mission.vastor&hero=hero.bruiser');
  const out = await page.evaluate(() => {
    const g = window.__vanguard;
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) g.frame(1 / 30);
    };
    const me = g.sim.players.get('local')!;
    me.invulnerable = 999;
    const knockOut = () => {
      g.sim.events = [];
      for (const e of [...g.sim.enemies.values()]) g.sim.damageEnemy(e, 999, 'local');
      g.session!.onStep(g.sim.events, 1 / 30);
    };
    frames(5);
    const shards = [...g.sim.enemies.values()].length;
    knockOut();
    frames(60);
    const boss = g.session!.runner!.bossOf('vastor');
    const bossBarShown = getComputedStyle(document.getElementById('bossbar')!).display !== 'none';
    const hp = boss ? boss.health.core : -1;
    if (boss) boss.health.core = 800 * 0.25; // he is already well hurt
    frames(5);
    return { shards, bossBarShown, hp, escaped: g.session!.runner!.escaped, status: g.session!.runner!.status };
  });
  expect(out.shards).toBe(6);
  expect(out.bossBarShown).toBe(true);
  expect(out.hp).toBe(800);
  expect(out.status).toBe('complete');
  expect(out.escaped).toBe(true);
  await expect(page.locator('#result')).toContainText('VASTOR got away');
  const s = (await saved(page))!;
  expect(s.flags).toContain('vastorEscaped');
  expect(s.completed['mission.vastor']).toBe(1);
  // Free roam afterwards happens in the damaged city.
  await page.goto('./?campaign=1&hero=hero.bruiser');
  const colliders = await page.evaluate(() => window.__vanguard.sim.world.colliders.length);
  expect(colliders).toBe(40); // the hub has 37; the damaged one has rubble on top
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the upgrade bay: buy an upgrade with scrap, keep it, and your hero wears it in the campaign', async ({ page }) => {
  const errors = watchErrors(page);
  await withSave(page, { version: 1, scrap: 500, xp: 60, completed: {}, upgrades: [], flags: [] }); // level 2
  await page.goto('./?tab=bay&hero=hero.bruiser');
  await expect(page.locator('#tab-bay')).toBeVisible();
  await expect(page.locator('.wallet .scrap')).toHaveText('500 scrap');
  const tireless = page.locator('.upgrade', { hasText: 'Tireless' });
  await expect(tireless.locator('button')).toBeEnabled();
  const breaker = page.locator('.upgrade', { hasText: 'Breaker Armor' });
  await expect(breaker).toContainText('Locked'); // needs a world beaten
  await tireless.locator('button').click();
  await expect(page.locator('.wallet .scrap')).toHaveText('440 scrap');
  await expect(page.locator('.upgrade', { hasText: 'Tireless' })).toContainText('Owned');
  expect((await saved(page))!.upgrades).toEqual(['upgrade.bruiser.tireless']);
  // In the campaign RAMPART's energy regenerates 30% faster; the plain sandbox is untouched.
  await page.goto('./?campaign=1&hero=hero.bruiser');
  const boosted = await page.evaluate(() => window.__vanguard.sim.hero.energy.regenPerSecond);
  expect(boosted).toBeCloseTo(9 * 1.3, 6);
  await page.goto('./?hero=hero.bruiser');
  expect(await page.evaluate(() => window.__vanguard.sim.hero.energy.regenPerSecond)).toBe(9);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('free roam in the campaign pays scrap and XP for defeated thugs and saves it', async ({ page }) => {
  await begin(page, 'campaign=1&hero=hero.bruiser');
  await page.evaluate(() => {
    const g = window.__vanguard;
    g.sim.players.get('local')!.invulnerable = 999;
    for (let i = 0; i < 10; i++) g.frame(1 / 30);
    g.sim.events = [];
    for (const e of [...g.sim.enemies.values()]) g.sim.damageEnemy(e, 999, 'local');
    g.session!.onStep(g.sim.events, 1 / 30);
    for (let i = 0; i < 90; i++) g.frame(1 / 30); // long enough for the debounced save
  });
  const s = (await saved(page))!;
  expect(s.scrap).toBeGreaterThanOrEqual(15);
  expect(s.xp).toBeGreaterThanOrEqual(30);
});
