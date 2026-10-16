import type { EnergyParams } from './params';

export interface EnergyState {
  energy: number;
  /** Seconds until regeneration resumes. */
  energyDelay: number;
}

/** Spend all-or-nothing. Returns false (and changes nothing) if there is not enough energy. */
export function trySpend(s: EnergyState, amount: number, p: EnergyParams): boolean {
  if (s.energy < amount) return false;
  s.energy -= amount;
  s.energyDelay = p.regenDelay;
  return true;
}

/** Continuous drain. Clamps at zero and returns true while there is energy left. */
export function drain(s: EnergyState, amount: number, p: EnergyParams): boolean {
  s.energy = Math.max(0, s.energy - amount);
  s.energyDelay = p.regenDelay;
  return s.energy > 0;
}

export function regen(s: EnergyState, p: EnergyParams, dt: number): void {
  if (s.energyDelay > 0) {
    s.energyDelay = Math.max(0, s.energyDelay - dt);
    return;
  }
  s.energy = Math.min(p.max, s.energy + p.regenPerSecond * dt);
}
