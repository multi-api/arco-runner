import type { Batcher } from '@multiapi/arco-cloud-client';
import { describe, expect, it } from 'vitest';
import { Steps } from '../src/job/steps.js';

describe('Steps', () => {
  it('done and warning carry params and elapsed_ms', () => {
    const events: any[] = [];
    let t = 1000;
    const steps = new Steps({ addEvent: (e: unknown) => events.push(e) } as unknown as Batcher, () => new Date(t));
    steps.start('a');
    steps.start('b');
    t = 1500;
    steps.done('a', 'ok', { passed: 3 });
    steps.warning('b', 'careful', { failed: 1 });
    steps.done('a');
    expect(events[2]).toMatchObject({ key: 'a', status: 'done', message: 'ok', params: { passed: 3 }, elapsed_ms: 500 });
    expect(events[3]).toMatchObject({ key: 'b', status: 'warning', message: 'careful', params: { failed: 1 }, elapsed_ms: 500 });
    expect(events[4].params).toEqual({});
  });
});
