import { createPlayerState, stepPlayer, type MovementParams, type PlayerState } from './controller';
import { NEUTRAL_INTENT, type PlayerIntent } from './types';
import type { World } from './world';

/** The authoritative-style game simulation. No rendering, DOM or engine imports. */
export class Sim {
  tick = 0;
  readonly players = new Map<string, PlayerState>();

  constructor(
    readonly world: World,
    readonly movement: MovementParams,
  ) {}

  addPlayer(id: string): PlayerState {
    const state = createPlayerState(this.world.spawn);
    this.players.set(id, state);
    return state;
  }

  /** Advance every player one fixed tick using the intents supplied this tick. */
  step(dt: number, intents: ReadonlyMap<string, PlayerIntent>): void {
    for (const [id, state] of this.players) {
      stepPlayer(state, intents.get(id) ?? NEUTRAL_INTENT, this.movement, this.world.colliders, dt);
      if (state.pos.y < this.world.killY) this.respawn(state);
    }
    this.tick++;
  }

  private respawn(state: PlayerState): void {
    state.pos = { ...this.world.spawn };
    state.prevPos = { ...this.world.spawn };
    state.vel = { x: 0, y: 0, z: 0 };
    state.grounded = false;
  }
}
