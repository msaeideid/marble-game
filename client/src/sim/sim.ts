import { createPlayerState, stepPlayer, type PlayerState } from './controller';
import type { HeroParams } from './params';
import { NEUTRAL_INTENT, type PlayerIntent } from './types';
import type { World } from './world';

/** The authoritative-style game simulation. No rendering, DOM or engine imports. */
export class Sim {
  tick = 0;
  readonly players = new Map<string, PlayerState>();

  constructor(
    readonly world: World,
    readonly hero: HeroParams,
  ) {}

  addPlayer(id: string): PlayerState {
    const state = createPlayerState(this.world.spawn, this.hero);
    this.players.set(id, state);
    return state;
  }

  /** Advance every player one fixed tick using the intents supplied this tick. */
  step(dt: number, intents: ReadonlyMap<string, PlayerIntent>): void {
    for (const [id, state] of this.players) {
      stepPlayer(state, intents.get(id) ?? NEUTRAL_INTENT, this.hero, this.world, dt);
      if (state.pos.y < this.world.killY) this.respawn(id);
    }
    this.tick++;
  }

  /** Reset in place so references held by views and tests stay valid. */
  private respawn(id: string): void {
    const state = this.players.get(id);
    if (state) Object.assign(state, createPlayerState(this.world.spawn, this.hero));
  }
}
