import type {
  ChainParams,
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
  TempestParams,
  ZipParams,
} from '../sim/params';
import type { MissionData } from '../campaign/missions';
import type { LevelData } from '../sim/world';

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
  kind: 'swing' | 'zip' | 'melee' | 'snare' | 'charge' | 'lift' | 'flight' | 'laser' | 'rockets' | 'chain' | 'tempest';
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
  chain?: ChainParams;
  tempest?: TempestParams;
}

export interface UpgradeData {
  id: string;
  displayName: string;
  hero: string;
  cost: number;
  description?: string;
  /** What it takes to buy it: a player level and/or story flags (a world beaten). */
  requires?: { level?: number; flags?: string[] };
  modifiers: { path: string; op: 'mul' | 'add'; value: number }[];
}

/** Everything the game loads from shared/data. */
export interface Content {
  heroes: Record<string, HeroData>;
  abilities: Record<string, AbilityData>;
  enemies: Record<string, EnemyParams>;
  upgrades: Record<string, UpgradeData>;
  props: Record<string, PropParams>;
  missions: Record<string, MissionData>;
  /** Every level by id (shared/levels). */
  levels: Record<string, LevelData>;
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
    missions: indexById(
      import.meta.glob<MissionData>('@shared/data/missions/*.json', { eager: true, import: 'default' }),
      'mission',
    ),
    levels: indexById(
      import.meta.glob<LevelData>('@shared/levels/*.json', { eager: true, import: 'default' }),
      'level',
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
  if (byKind.chain?.chain) out.chain = byKind.chain.chain;
  if (byKind.tempest?.tempest) out.tempest = byKind.tempest.tempest;
  if (out.zip && !out.swing) throw new Error(`Hero ${hero.id} has a zip but no swing`);
  return out;
}
