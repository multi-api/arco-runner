import { describe, expect, it } from 'vitest';
import { planPrune } from '../prune-microvm-images.ts';

const v = (n: number) => ({ imageVersion: String(n), createdAt: new Date(n * 1000), state: 'SUCCESSFUL' });

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
  it('ignores FAILED versions when choosing the previous one and counting the floor', () => {
    const failed = { imageVersion: '3', createdAt: new Date(3000), state: 'FAILED' };
    expect(planPrune([v(1), v(2), failed, v(4), v(5)], '4')).toEqual(['1']);
    expect(() => planPrune([v(1), failed], '1')).toThrow(/at least 2/);
  });
  it('refuses an unknown in-use version', () => {
    expect(() => planPrune([v(1), v(2), v(3)], '9')).toThrow(/not a SUCCESSFUL/);
  });
});
