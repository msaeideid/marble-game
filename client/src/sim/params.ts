/** An upright collision box centred on the feet. */
export interface BoxSize {
  halfWidth: number;
  height: number;
}

export interface MovementParams extends BoxSize {
  runSpeed: number;
  groundAccel: number;
  airAccel: number;
  gravity: number;
  jumpSpeed: number;
  maxFallSpeed: number;
  coyoteTime: number;
  jumpBufferTime: number;
  /** Height of the hands above the feet: the origin for aiming tethers, zips and snares. */
  handHeight: number;
}

/** A regenerating pool (energy, shield, core health). */
export interface PoolParams {
  max: number;
  regenPerSecond: number;
  /** Seconds after spending or taking damage before regeneration resumes. */
  regenDelay: number;
}

export type EnergyParams = PoolParams;

/** Health is a regenerating shield over a slower core. */
export interface HealthParams {
  shield: PoolParams;
  core: PoolParams;
}

export interface MeleeStep {
  damage: number;
  knockback: number;
}

export interface MeleeParams {
  cost: number;
  range: number;
  arcDegrees: number;
  verticalReach: number;
  windup: number;
  recovery: number;
  /** After a hit, how long the next press continues the combo instead of restarting it. */
  comboWindow: number;
  /** A press this early before the attack is free is remembered. */
  inputBuffer: number;
  steps: MeleeStep[];
}

export interface SnareParams {
  cost: number;
  cooldown: number;
  range: number;
  /** How far off the aim line an enemy can be and still be caught. */
  radius: number;
  /** Seconds the enemy is held (cannot move or attack). */
  duration: number;
}

export interface ChargeParams {
  cost: number;
  cooldown: number;
  speed: number;
  duration: number;
  /** Walls with a `breakable` tier at or below this are smashed; stronger ones stop the charge. */
  breakPower: number;
  /** Damage and knockback dealt once to each enemy the charge runs into. */
  damage: number;
  knockback: number;
  hitRadius: number;
}

export interface LiftParams {
  /** How close (beyond the prop's own size) a prop must be to lift it. */
  liftRange: number;
  /** Seconds before the next lift or throw. */
  cooldown: number;
  /** Multiplier on a prop's throw speed (the hero's strength). */
  strength: number;
}

/** Jet flight: press jump in the air to take off, hold jump to climb, hold descend to drop; drains the shared energy. */
export interface FlightParams {
  /** Energy to take off. */
  startCost: number;
  hoverDrainPerSecond: number;
  /** Extra drain while climbing. */
  climbDrainPerSecond: number;
  /** Horizontal speed while flying. */
  speed: number;
  /** How fast velocity eases toward the wanted velocity (m/s^2). */
  accel: number;
  climbSpeed: number;
  descendSpeed: number;
}

/** A held-to-fire hitscan weapon: one bolt every `fireInterval` seconds while the button is down. */
export interface LaserParams {
  range: number;
  fireInterval: number;
  /** Energy per bolt. */
  shotCost: number;
  damage: number;
  /** How far (m) off the aim line an enemy's body can be and still be hit. */
  aimAssist: number;
}

/** A homing rocket that locks the enemy nearest the crosshair and bursts for area damage. */
export interface RocketParams {
  cost: number;
  cooldown: number;
  speed: number;
  /** Turn rate toward the locked target (radians per second). */
  turnRate: number;
  lifetime: number;
  /** Rocket size for hit tests. */
  radius: number;
  lockRange: number;
  /** An enemy this close to the crosshair direction (degrees) can be locked. */
  lockAngleDegrees: number;
  splashRadius: number;
  /** Damage at the centre of the blast. */
  damage: number;
  /** Fraction of `damage` still dealt at the very edge of the blast (0..1). */
  edgeFalloff: number;
  knockback: number;
}

/** A liftable, throwable world object (car, crate, dumpster). Loaded from shared/data/props. */
export interface PropParams {
  id: string;
  displayName: string;
  size: BoxSize;
  /** Movement speed multiplier while carrying it (heavier = smaller). Jump uses its square root. */
  carrySlow: number;
  throwSpeed: number;
  throwDamage: number;
  throwKnockback: number;
  /** Breakable walls up to this tier are smashed when it is thrown hard into them. */
  breakPower: number;
  /** Hard impacts it survives before breaking. */
  hp: number;
  respawnTime: number;
  /** Visual hints only. */
  look: 'car' | 'crate' | 'dumpster';
  color: number[];
}

export interface EnemyParams {
  id: string;
  displayName: string;
  health: HealthParams;
  move: { speed: number; halfWidth: number; height: number };
  aggroRange: number;
  attack: {
    range: number;
    damage: number;
    windup: number;
    recovery: number;
    cooldown: number;
    knockback: number;
  };
  /** Seconds an enemy is staggered (cannot act) after being hit. */
  staggerTime: number;
  /** After a stagger ends, hits do damage but cannot interrupt for this many seconds (prevents stun-lock). */
  poiseTime: number;
  powerDownTime: number;
}

export interface SwingParams {
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
  id: string;
  displayName: string;
  movement: MovementParams;
  energy: EnergyParams;
  health: HealthParams;
  respawnDelay: number;
  /** Seconds of damage immunity after (re)spawning at base. */
  respawnInvulnerable: number;
  /** Optional ability kits: a hero has the ones its ability list names. Every hero has a melee attack. */
  swing?: SwingParams;
  zip?: ZipParams;
  melee: MeleeParams;
  snare?: SnareParams;
  charge?: ChargeParams;
  lift?: LiftParams;
  flight?: FlightParams;
  laser?: LaserParams;
  rockets?: RocketParams;
}
