import type { UpgradeData } from '../data/content';
import type { HeroParams } from './params';

/**
 * Upgrades widen options; they do not inflate raw power. Paths that scale damage or durability are
 * limited to a small multiplier so upgraded and fresh players stay on even footing in co-op.
 */
const RAW_POWER_PATH = /(damage|knockback|health|shield|\.max$)/i;
/** Largest allowed total multiplier on a raw-power path from any one upgrade. */
export const MAX_RAW_POWER_MULTIPLIER = 1.1;

export function validateUpgrade(u: UpgradeData): string[] {
  const problems: string[] = [];
  for (const m of u.modifiers) {
    if (!RAW_POWER_PATH.test(m.path)) continue;
    if (m.op === 'mul' && m.value > MAX_RAW_POWER_MULTIPLIER) {
      problems.push(`${u.id}: ${m.path} x${m.value} exceeds raw-power cap x${MAX_RAW_POWER_MULTIPLIER}`);
    }
    if (m.op === 'add' && m.value > 0) {
      problems.push(`${u.id}: ${m.path} +${m.value} adds raw power; use a mul within the cap`);
    }
  }
  return problems;
}

function resolvePath(root: unknown, path: string): { parent: Record<string, number>; key: string } {
  const parts = path.split('.');
  let node = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) throw new Error(`Unknown upgrade path "${path}"`);
    node = next as Record<string, unknown>;
  }
  const key = parts[parts.length - 1]!;
  if (typeof node[key] !== 'number') throw new Error(`Unknown or non-numeric upgrade path "${path}"`);
  return { parent: node as Record<string, number>, key };
}

/** Returns a new HeroParams with every modifier applied. The input is not changed. */
export function applyUpgrades(hero: HeroParams, upgrades: readonly UpgradeData[]): HeroParams {
  const out = structuredClone(hero);
  for (const u of upgrades) {
    if (u.hero !== hero.id) throw new Error(`Upgrade ${u.id} is for ${u.hero}, not ${hero.id}`);
    for (const m of u.modifiers) {
      const { parent, key } = resolvePath(out, m.path);
      parent[key] = m.op === 'mul' ? parent[key]! * m.value : parent[key]! + m.value;
    }
  }
  return out;
}
