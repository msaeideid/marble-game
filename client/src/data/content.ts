import type {
  EnemyParams,
  EnergyParams,
  HealthParams,
  HeroParams,
  MeleeParams,
  MovementParams,
  SwingParams,
  ZipParams,
} from '../sim/params';

/** Shapes of the JSON files in shared/data (validated against shared/schemas by the test suite). */
export interface HeroData {
  id: string;
  displayName: string;
  movement: MovementParams;
  energy: EnergyParams;
  health: HealthParams;
  respawnDelay: number;
  abilities: string[];
}

export interface AbilityData {
  id: string;
  kind: 'swing' | 'zip' | 'melee';
  displayName: string;
  swing?: SwingParams;
  zip?: ZipParams;
  melee?: MeleeParams;
}

export interface UpgradeData {
  id: string;
  displayName: string;
  hero: string;
  cost: number;
  modifiers: { path: string; op: 'mul' | 'add'; value: number }[];
}

/** Everything the game loads from shared/data. */
export interface Content {
  heroes: Record<string, HeroData>;
  abilities: Record<string, AbilityData>;
  enemies: Record<string, EnemyParams>;
  upgrades: Record<string, UpgradeData>;
}

function indexById<T extends { id: string }>(modules: Record<string, T>, what: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [file, item] of Object.entries(modules)) {
    if (out[item.id]) throw new Error(`Duplicate ${what} id "${item.id}" (${file})`);
    out[item.id] = item;
  }
  return out;
}

export function loadContent(): Content {
  return {
    heroes: indexById(
      import.meta.glob<HeroData>('@shared/data/heroes/*.json', { eager: true, import: 'default' }),
      'hero',
    ),
    abilities: indexById(
      import.meta.glob<AbilityData>('@shared/data/abilities/*.json', { eager: true, import: 'default' }),
      'ability',
    ),
    enemies: indexById(
      import.meta.glob<EnemyParams>('@shared/data/enemies/*.json', { eager: true, import: 'default' }),
      'enemy',
    ),
    upgrades: indexById(
      import.meta.glob<UpgradeData>('@shared/data/upgrades/*.json', { eager: true, import: 'default' }),
      'upgrade',
    ),
  };
}

/** Combine a hero with the abilities it references into the flat params the sim consumes. */
export function resolveHero(hero: HeroData, abilities: Record<string, AbilityData>): HeroParams {
  const byKind: Partial<Record<AbilityData['kind'], AbilityData>> = {};
  for (const id of hero.abilities) {
    const ability = abilities[id];
    if (!ability) throw new Error(`Hero ${hero.id} references unknown ability "${id}"`);
    if (byKind[ability.kind]) throw new Error(`Hero ${hero.id} has two "${ability.kind}" abilities`);
    byKind[ability.kind] = ability;
  }
  const swing = byKind.swing?.swing;
  const zip = byKind.zip?.zip;
  const melee = byKind.melee?.melee;
  if (!swing || !zip || !melee) throw new Error(`Hero ${hero.id} is missing a swing, zip or melee ability`);
  return {
    id: hero.id,
    displayName: hero.displayName,
    movement: hero.movement,
    energy: hero.energy,
    health: hero.health,
    respawnDelay: hero.respawnDelay,
    swing,
    zip,
    melee,
  };
}
