import type {
  ChargeParams,
  EnemyParams,
  EnergyParams,
  FlightParams,
  HealthParams,
  HeroParams,
  LaserParams,
  LiftParams,
  MeleeParams,
  MovementParams,
  PropParams,
  RocketParams,
  SnareParams,
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
  respawnInvulnerable: number;
  abilities: string[];
}

export interface AbilityData {
  id: string;
  kind: 'swing' | 'zip' | 'melee' | 'snare' | 'charge' | 'lift' | 'flight' | 'laser' | 'rockets';
  displayName: string;
  swing?: SwingParams;
  zip?: ZipParams;
  melee?: MeleeParams;
  snare?: SnareParams;
  charge?: ChargeParams;
  lift?: LiftParams;
  flight?: FlightParams;
  laser?: LaserParams;
  rockets?: RocketParams;
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
  props: Record<string, PropParams>;
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
    props: indexById(
      import.meta.glob<PropParams>('@shared/data/props/*.json', { eager: true, import: 'default' }),
      'prop',
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
  const melee = byKind.melee?.melee;
  if (!melee) throw new Error(`Hero ${hero.id} has no melee ability`);
  const out: HeroParams = {
    id: hero.id,
    displayName: hero.displayName,
    movement: hero.movement,
    energy: hero.energy,
    health: hero.health,
    respawnDelay: hero.respawnDelay,
    respawnInvulnerable: hero.respawnInvulnerable,
    melee,
  };
  if (byKind.swing?.swing) out.swing = byKind.swing.swing;
  if (byKind.zip?.zip) out.zip = byKind.zip.zip;
  if (byKind.snare?.snare) out.snare = byKind.snare.snare;
  if (byKind.charge?.charge) out.charge = byKind.charge.charge;
  if (byKind.lift?.lift) out.lift = byKind.lift.lift;
  if (byKind.flight?.flight) out.flight = byKind.flight.flight;
  if (byKind.laser?.laser) out.laser = byKind.laser.laser;
  if (byKind.rockets?.rockets) out.rockets = byKind.rockets.rockets;
  if (out.zip && !out.swing) throw new Error(`Hero ${hero.id} has a zip but no swing`);
  return out;
}
