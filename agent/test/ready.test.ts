import { describe, expect, it } from 'vitest';
import { writableBy } from '../src/ready.js';

const id = { uid: 1000, gid: 1000 };

describe('writableBy', () => {
  it('root-owned 0755 is not writable by build', () => {
    expect(writableBy({ uid: 0, gid: 0, mode: 0o40755 }, id)).toBe(false);
  });
  it('detects owner, group and other write bits', () => {
    expect(writableBy({ uid: 1000, gid: 0, mode: 0o40755 }, id)).toBe(true);
    expect(writableBy({ uid: 0, gid: 1000, mode: 0o40775 }, id)).toBe(true);
    expect(writableBy({ uid: 0, gid: 0, mode: 0o40757 }, id)).toBe(true);
  });
});
