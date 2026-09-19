import { describe, expect, it } from 'vitest';
import { mmss } from '../format';

describe('format helpers', () => {
  it('formats durations as mm:ss and never negative', () => {
    expect(mmss(0)).toBe('00:00');
    expect(mmss(32_000)).toBe('00:32');
    expect(mmss(90_000)).toBe('01:30');
    expect(mmss(-5)).toBe('00:00');
  });
});
