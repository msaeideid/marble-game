import { describe, expect, it } from 'vitest';
import { FixedStepper } from '../src/sim/fixedStep';

describe('FixedStepper', () => {
  it('runs a constant number of steps regardless of frame split', () => {
    const a = new FixedStepper(1 / 30);
    const b = new FixedStepper(1 / 30);
    let ta = 0;
    let tb = 0;
    for (let i = 0; i < 60; i++) a.advance(1 / 60, () => ta++);
    for (let i = 0; i < 20; i++) b.advance(1 / 20, () => tb++);
    expect(ta).toBe(30);
    expect(tb).toBe(30);
  });

  it('caps catch-up steps after a long stall', () => {
    const s = new FixedStepper(1 / 30, 5);
    let n = 0;
    s.advance(10, () => n++);
    expect(n).toBe(5);
  });

  it('returns an interpolation alpha in [0,1)', () => {
    const s = new FixedStepper(0.1);
    const alpha = s.advance(0.25, () => {});
    expect(alpha).toBeCloseTo(0.5, 5);
  });
});
