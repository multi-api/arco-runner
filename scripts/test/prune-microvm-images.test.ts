import { describe, expect, it } from 'vitest';
import { planPrune } from '../prune-microvm-images.ts';

const v = (n: number) => ({ imageVersion: String(n), createdAt: new Date(n * 1000) });

describe('planPrune', () => {
  it('deletes versions older than the one before the in-use version', () => {
    expect(planPrune([v(5), v(1), v(3), v(2), v(4)], '4')).toEqual(['1', '2']);
  });
  it('keeps everything when the in-use version is the oldest or second oldest', () => {
    expect(planPrune([v(1), v(2), v(3)], '1')).toEqual([]);
    expect(planPrune([v(1), v(2), v(3)], '2')).toEqual([]);
  });
  it('refuses when fewer than 2 versions would remain', () => {
    expect(() => planPrune([v(1)], '1')).toThrow(/at least 2/);
  });
  it('refuses an unknown in-use version', () => {
    expect(() => planPrune([v(1), v(2), v(3)], '9')).toThrow(/not found/);
  });
});
