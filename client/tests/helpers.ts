import arena from '@shared/levels/arena.json';
import { content, getHero } from '../src/data';
import type { HeroParams } from '../src/sim/params';
import { Sim } from '../src/sim/sim';
import { NEUTRAL_INTENT, type PlayerIntent } from '../src/sim/types';
import { World } from '../src/sim/world';

export const DT = 1 / 30;
export const hero: HeroParams = getHero('hero.swinger');
export { content };

export function makeSim(withPlayer = true): Sim {
  const sim = new Sim(new World(arena), hero, content.enemies);
  if (withPlayer) sim.addPlayer('p1');
  return sim;
}

export const intent = (over: Partial<PlayerIntent> = {}): PlayerIntent => ({ ...NEUTRAL_INTENT, ...over });

export function run(sim: Sim, ticks: number, make: (i: number) => PlayerIntent): void {
  for (let i = 0; i < ticks; i++) sim.step(DT, new Map([['p1', make(i)]]));
}
