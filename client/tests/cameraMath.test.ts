import { describe, expect, it } from 'vitest';
import { cameraOffsetDir } from '../src/render/cameraMath';

describe('cameraOffsetDir', () => {
  it('sits behind the character at yaw 0 (-Z) and above for positive pitch', () => {
    const d = cameraOffsetDir(0, 0.5);
    expect(d.z).toBeLessThan(0);
    expect(d.y).toBeGreaterThan(0);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
  });

  it('is behind a character who faces +X when yaw is 90 degrees', () => {
    const d = cameraOffsetDir(Math.PI / 2, 0);
    expect(d.x).toBeCloseTo(-1, 6);
    expect(d.z).toBeCloseTo(0, 6);
  });
});
