import type { HeroParams } from '../sim/params';
import { loadContent, resolveHero, type Content } from './content';

/** All game data, loaded once from shared/data. */
export const content: Content = loadContent();

export function getHero(id: string): HeroParams {
  const hero = content.heroes[id];
  if (!hero) throw new Error(`Unknown hero "${id}"`);
  return resolveHero(hero, content.abilities);
}
