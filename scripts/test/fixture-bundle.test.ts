import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleFixture } from '../lib/fixture-bundle.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fixture-bundle-')); dirs.push(d); return d; };

describe('bundleFixture', () => {
  it('bundles app/ and packages/ as plain files, keeping the exec bit, and clones back', () => {
    const fixture = tmp();
    mkdirSync(join(fixture, 'app'));
    mkdirSync(join(fixture, 'packages/p/bin'), { recursive: true });
    writeFileSync(join(fixture, 'app/composer.json'), '{}');
    writeFileSync(join(fixture, 'packages/p/bin/tool'), '#!/bin/sh\n');
    chmodSync(join(fixture, 'packages/p/bin/tool'), 0o755);
    const out = join(tmp(), 'app.bundle');
    bundleFixture(fixture, out);
    const clone = join(tmp(), 'c');
    execFileSync('git', ['clone', '-q', out, clone]);
    expect(statSync(join(clone, 'app/composer.json')).isFile()).toBe(true);
    expect(statSync(join(clone, 'packages/p/bin/tool')).mode & 0o111).not.toBe(0);
  });

  it('gives the same commit for the same files', () => {
    const fixture = tmp();
    mkdirSync(join(fixture, 'app'));
    writeFileSync(join(fixture, 'app/a'), 'x');
    const heads = [0, 1].map(() => {
      const out = join(tmp(), 'app.bundle');
      bundleFixture(fixture, out);
      return execFileSync('git', ['bundle', 'list-heads', out], { encoding: 'utf8' });
    });
    expect(heads[0]).toBe(heads[1]);
  });

  it('refuses a fixture without app/', () => {
    expect(() => bundleFixture(tmp(), join(tmp(), 'x.bundle'))).toThrow(/no app\/ directory/);
  });
});
