export interface MovementParams {
  runSpeed: number;
  groundAccel: number;
  airAccel: number;
  gravity: number;
  jumpSpeed: number;
  maxFallSpeed: number;
  coyoteTime: number;
  jumpBufferTime: number;
  halfWidth: number;
  height: number;
}

export interface EnergyParams {
  max: number;
  regenPerSecond: number;
  /** Seconds after spending energy before regeneration resumes. */
  regenDelay: number;
}

export interface SwingParams {
  /** Height of the tether hand above the feet. */
  handHeight: number;
  maxRange: number;
  minLength: number;
  attachCost: number;
  drainPerSecond: number;
  reelSpeed: number;
  reelDrainPerSecond: number;
  /** On attach the rope is shortened (at this speed) so the swing arc clears the ground by `arcClearance`. */
  autoReelSpeed: number;
  arcClearance: number;
  /** How quickly the player's velocity is pulled toward the reel-in speed along the rope (1/s). */
  pullGain: number;
  /** Steering acceleration (m/s^2) while tethered. */
  airControl: number;
  /** Extra speed (m/s) added along the velocity when the tether is released while moving fast. */
  releaseBoost: number;
  maxSpeed: number;
  /** Slack allowed when checking that the rope has a clear line to its anchor. */
  ropeClearTolerance: number;
}

export interface ZipParams {
  range: number;
  speed: number;
  cost: number;
  /** Zip ends when the hand is this close to the anchor. */
  arriveDistance: number;
  maxDuration: number;
  /** Fraction of zip velocity kept when the zip ends. */
  exitKeep: number;
  /** Upward speed added when the zip ends. */
  popSpeed: number;
  /** A vertical-face hit this close to a roof edge pulls the player up onto the roof. */
  ledgeSnap: number;
}

/** Everything the sim needs to know about how one hero moves. Loaded from shared/data/heroes. */
export interface HeroParams {
  movement: MovementParams;
  energy: EnergyParams;
  swing: SwingParams;
  zip: ZipParams;
}
