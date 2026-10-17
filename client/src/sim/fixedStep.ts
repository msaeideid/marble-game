/** The simulation tick: 30 Hz on the client and on the server. */
export const SIM_DT = 1 / 30;

/**
 * Fixed-timestep accumulator. The sim advances in constant steps so that results
 * do not depend on frame rate (and can be reproduced on a server later).
 */
export class FixedStepper {
  private accumulator = 0;

  constructor(
    readonly stepSeconds: number,
    private readonly maxStepsPerFrame = 5,
  ) {}

  /** Feed a frame delta (seconds). Calls `step` zero or more times and returns the interpolation alpha in [0,1). */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    this.accumulator += Math.min(frameSeconds, this.stepSeconds * this.maxStepsPerFrame);
    let steps = 0;
    while (this.accumulator >= this.stepSeconds && steps < this.maxStepsPerFrame) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      steps++;
    }
    return this.accumulator / this.stepSeconds;
  }
}
