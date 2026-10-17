import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { resolveHero, type AbilityData } from '../src/data/content';
import { applyUpgrades, MAX_RAW_POWER_MULTIPLIER, validateUpgrade } from '../src/sim/upgrades';
import arena from '@shared/levels/arena.json';
import { content, hero } from './helpers';

const sharedDir = fileURLToPath(new URL('../../shared/', import.meta.url));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(sharedDir + rel, 'utf8'));

function makeAjv() {
  const ajv = new Ajv({ allErrors: true });
  for (const f of readdirSync(sharedDir + 'schemas')) ajv.addSchema(readJson('schemas/' + f) as object);
  return ajv;
}

const KINDS: [string, string][] = [
  ['heroes', 'hero.schema.json'],
  ['abilities', 'ability.schema.json'],
  ['enemies', 'enemy.schema.json'],
  ['upgrades', 'upgrade.schema.json'],
  ['props', 'prop.schema.json'],
];

describe('data files match their JSON schemas', () => {
  const ajv = makeAjv();
  for (const [dir, schema] of KINDS) {
    for (const file of readdirSync(sharedDir + 'data/' + dir)) {
      it(`${dir}/${file}`, () => {
        const validate = ajv.getSchema(schema)!;
        const ok = validate(readJson(`data/${dir}/${file}`));
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
      });
    }
  }

  it('rejects an ability whose block does not match its kind', () => {
    const validate = ajv.getSchema('ability.schema.json')!;
    const swing = readJson('data/abilities/swing.json') as Record<string, unknown>;
    expect(validate({ ...swing, kind: 'zip' })).toBe(false);
  });

  it('rejects negative or missing numbers', () => {
    const validate = ajv.getSchema('enemy.schema.json')!;
    const thug = readJson('data/enemies/thug.json') as { attack: Record<string, number> };
    expect(validate({ ...thug, attack: { ...thug.attack, damage: -1 } })).toBe(false);
    const missing: Record<string, unknown> = { ...thug };
    delete missing.aggroRange;
    expect(validate(missing)).toBe(false);
  });
});

describe('content cross-references', () => {
  it('every hero resolves and every ability id exists', () => {
    for (const h of Object.values(content.heroes)) {
      expect(() => resolveHero(h, content.abilities)).not.toThrow();
    }
  });

  it('every upgrade targets an existing hero and a real numeric parameter', () => {
    for (const u of Object.values(content.upgrades)) {
      expect(content.heroes[u.hero]).toBeDefined();
      expect(() => applyUpgrades(hero, [u])).not.toThrow();
    }
  });

  it('rejects a hero that references a missing ability', () => {
    const h = { ...content.heroes['hero.swinger']!, abilities: ['ability.nope'] };
    expect(() => resolveHero(h, content.abilities)).toThrow(/unknown ability/);
  });

  it('rejects a hero with two abilities of one kind', () => {
    const extra: AbilityData = { ...content.abilities['ability.swing']!, id: 'ability.swing2' };
    const h = { ...content.heroes['hero.swinger']!, abilities: ['ability.swing', 'ability.swing2', 'ability.zip', 'ability.strike'] };
    expect(() => resolveHero(h, { ...content.abilities, [extra.id]: extra })).toThrow(/two "swing"/);
  });
});

describe('props', () => {
  it('every prop the level places has a definition', () => {
    for (const spawn of arena.props) expect(content.props[spawn.type], spawn.type).toBeDefined();
  });

  it('heavier props are slower to carry, hit harder and need more strength to be worth it', () => {
    const car = content.props['prop.car']!;
    const crate = content.props['prop.crate']!;
    const dumpster = content.props['prop.dumpster']!;
    expect(car.carrySlow).toBeLessThan(dumpster.carrySlow);
    expect(dumpster.carrySlow).toBeLessThan(crate.carrySlow);
    expect(car.throwDamage).toBeGreaterThan(dumpster.throwDamage);
    expect(dumpster.throwDamage).toBeGreaterThan(crate.throwDamage);
  });

  it('a lift ability only goes on a hero through the data (and the schema rejects bad ones)', () => {
    const ajv = makeAjv();
    const validate = ajv.getSchema('ability.schema.json')!;
    const lift = readJson('data/abilities/lift.json') as Record<string, unknown>;
    expect(validate(lift)).toBe(true);
    expect(validate({ ...lift, kind: 'charge' })).toBe(false);
    expect(validate({ ...lift, lift: { liftRange: -1, cooldown: 0.5, strength: 1 } })).toBe(false);
    const prop = ajv.getSchema('prop.schema.json')!;
    const car = readJson('data/props/car.json') as Record<string, unknown>;
    expect(prop({ ...car, carrySlow: 1.5 })).toBe(false); // cannot make you faster than not carrying
    expect(prop({ ...car, look: 'spaceship' })).toBe(false);
  });
});

describe('upgrades widen options, they do not inflate power', () => {
  it('all shipped upgrades pass the raw-power rule', () => {
    for (const u of Object.values(content.upgrades)) expect(validateUpgrade(u)).toEqual([]);
  });

  it('flags a big damage multiplier', () => {
    const bad = {
      id: 'upgrade.test.bad',
      displayName: 'Bad',
      hero: 'hero.swinger',
      cost: 1,
      modifiers: [{ path: 'melee.steps.0.damage', op: 'mul' as const, value: 1.5 }],
    };
    expect(validateUpgrade(bad)[0]).toMatch(/exceeds raw-power cap/);
  });

  it('flags flat damage or health additions', () => {
    const bad = {
      id: 'upgrade.test.flat',
      displayName: 'Flat',
      hero: 'hero.swinger',
      cost: 1,
      modifiers: [{ path: 'health.core.max', op: 'add' as const, value: 20 }],
    };
    expect(validateUpgrade(bad).length).toBe(1);
  });

  it('allows small raw-power bumps and big utility changes', () => {
    const ok = {
      id: 'upgrade.test.ok',
      displayName: 'Ok',
      hero: 'hero.swinger',
      cost: 1,
      modifiers: [
        { path: 'health.core.max', op: 'mul' as const, value: MAX_RAW_POWER_MULTIPLIER },
        { path: 'swing.maxRange', op: 'mul' as const, value: 2 },
      ],
    };
    expect(validateUpgrade(ok)).toEqual([]);
  });

  it('applies modifiers without mutating the base hero', () => {
    const u = content.upgrades['upgrade.swinger.long_tether']!;
    const before = hero.swing!.maxRange;
    const up = applyUpgrades(hero, [u]);
    expect(up.swing!.maxRange).toBeCloseTo(before * 1.25, 9);
    expect(hero.swing!.maxRange).toBe(before);
  });

  it('refuses unknown paths and the wrong hero', () => {
    expect(() =>
      applyUpgrades(hero, [{ id: 'upgrade.x.y', displayName: 'x', hero: 'hero.swinger', cost: 0, modifiers: [{ path: 'swing.nope', op: 'mul', value: 2 }] }]),
    ).toThrow(/Unknown/);
    expect(() =>
      applyUpgrades(hero, [{ id: 'upgrade.x.z', displayName: 'x', hero: 'hero.other', cost: 0, modifiers: [{ path: 'swing.maxRange', op: 'mul', value: 2 }] }]),
    ).toThrow(/not hero.swinger/);
  });
});
