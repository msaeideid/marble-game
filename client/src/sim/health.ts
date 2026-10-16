import type { HealthParams } from './params';

export interface HealthState {
  shield: number;
  core: number;
  /** Seconds until the shield starts regenerating. */
  shieldDelay: number;
  /** Seconds until the core starts regenerating. */
  coreDelay: number;
}

export interface DamageResult {
  shieldLost: number;
  coreLost: number;
  defeated: boolean;
}

export function createHealth(p: HealthParams): HealthState {
  return { shield: p.shield.max, core: p.core.max, shieldDelay: 0, coreDelay: 0 };
}

/** The shield absorbs damage first; the remainder hits the core. Damage resets both regen delays. */
export function applyDamage(h: HealthState, amount: number, p: HealthParams): DamageResult {
  const shieldLost = Math.min(h.shield, amount);
  const coreLost = Math.min(h.core, amount - shieldLost);
  h.shield -= shieldLost;
  h.core -= coreLost;
  h.shieldDelay = p.shield.regenDelay;
  h.coreDelay = p.core.regenDelay;
  return { shieldLost, coreLost, defeated: h.core <= 0 };
}

export function regenHealth(h: HealthState, p: HealthParams, dt: number): void {
  if (h.core <= 0) return;
  if (h.shieldDelay > 0) h.shieldDelay = Math.max(0, h.shieldDelay - dt);
  else h.shield = Math.min(p.shield.max, h.shield + p.shield.regenPerSecond * dt);
  if (h.coreDelay > 0) h.coreDelay = Math.max(0, h.coreDelay - dt);
  else h.core = Math.min(p.core.max, h.core + p.core.regenPerSecond * dt);
}
