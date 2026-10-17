import type { PlayerState } from './controller';
import type { Vec3 } from './types';

type V3 = [number, number, number];

/**
 * The part of a player's state that the network syncs and that movement depends on. This exact shape is what the
 * Python server sends, and what the conformance scenarios in shared/conformance/ record.
 */
export interface PlayerWire {
  pos: V3;
  vel: V3;
  grounded: boolean;
  coyote: number;
  jumpBuffer: number;
  facing: number;
  energy: number;
  energyDelay: number;
  swingHeldPrev: boolean;
  charge: { timeLeft: number; dirX: number; dirZ: number } | null;
  chargeCooldown: number;
  tether: { anchor: V3; length: number; targetLength: number } | null;
  zip: { anchor: V3; timeLeft: number } | null;
}

const v3 = (v: Vec3): V3 => [v.x, v.y, v.z];
const vec = (a: V3): Vec3 => ({ x: a[0], y: a[1], z: a[2] });

export function toWire(s: PlayerState): PlayerWire {
  return {
    pos: v3(s.pos),
    vel: v3(s.vel),
    grounded: s.grounded,
    coyote: s.coyote,
    jumpBuffer: s.jumpBuffer,
    facing: s.facing,
    energy: s.energy,
    energyDelay: s.energyDelay,
    swingHeldPrev: s.swingHeldPrev,
    charge: s.charge ? { ...s.charge } : null,
    chargeCooldown: s.chargeCooldown,
    tether: s.tether
      ? { anchor: v3(s.tether.anchor), length: s.tether.length, targetLength: s.tether.targetLength }
      : null,
    zip: s.zip ? { anchor: v3(s.zip.anchor), timeLeft: s.zip.timeLeft } : null,
  };
}

/** Overwrite the synced fields of `s` with authoritative values (used when reconciling with the server). */
export function applyWire(s: PlayerState, w: PlayerWire): void {
  s.pos = vec(w.pos);
  s.prevPos = vec(w.pos);
  s.vel = vec(w.vel);
  s.grounded = w.grounded;
  s.coyote = w.coyote;
  s.jumpBuffer = w.jumpBuffer;
  s.facing = w.facing;
  s.energy = w.energy;
  s.energyDelay = w.energyDelay;
  s.swingHeldPrev = w.swingHeldPrev;
  s.charge = w.charge ? { ...w.charge } : null;
  s.chargeCooldown = w.chargeCooldown;
  s.chargeHits = [];
  s.tether = w.tether
    ? { anchor: vec(w.tether.anchor), length: w.tether.length, targetLength: w.tether.targetLength }
    : null;
  s.zip = w.zip ? { anchor: vec(w.zip.anchor), timeLeft: w.zip.timeLeft } : null;
}

/** Largest absolute difference between two wire states' numbers, or Infinity if the discrete parts differ. */
export function wireDistance(a: PlayerWire, b: PlayerWire): number {
  if (
    a.grounded !== b.grounded ||
    a.swingHeldPrev !== b.swingHeldPrev ||
    (a.tether === null) !== (b.tether === null) ||
    (a.charge === null) !== (b.charge === null) ||
    (a.zip === null) !== (b.zip === null)
  ) {
    return Infinity;
  }
  let max = 0;
  const cmp = (x: number, y: number) => {
    max = Math.max(max, Math.abs(x - y));
  };
  for (let i = 0; i < 3; i++) {
    cmp(a.pos[i]!, b.pos[i]!);
    cmp(a.vel[i]!, b.vel[i]!);
  }
  cmp(a.energy, b.energy);
  cmp(a.coyote, b.coyote);
  cmp(a.jumpBuffer, b.jumpBuffer);
  cmp(a.facing, b.facing);
  cmp(a.chargeCooldown, b.chargeCooldown);
  if (a.charge && b.charge) cmp(a.charge.timeLeft, b.charge.timeLeft);
  if (a.tether && b.tether) {
    cmp(a.tether.length, b.tether.length);
    for (let i = 0; i < 3; i++) cmp(a.tether.anchor[i]!, b.tether.anchor[i]!);
  }
  return max;
}
