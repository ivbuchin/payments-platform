import { computeBackoffMs } from './backoff';

const opts = { baseMs: 1000, maxMs: 60_000 };

describe('computeBackoffMs', () => {
  it('потолок растёт экспоненциально', () => {
    const max = () => 0.999999;
    expect([1, 2, 3, 4].map((n) => computeBackoffMs(n, opts, max))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('не превышает максимум', () => {
    expect(computeBackoffMs(30, opts, () => 0.999999)).toBeLessThanOrEqual(60_000);
  });

  it('джиттер даёт значения от 1 мс до потолка', () => {
    expect(computeBackoffMs(3, opts, () => 0)).toBe(1);
    expect(computeBackoffMs(3, opts, () => 0.5)).toBe(2001);
  });
});
