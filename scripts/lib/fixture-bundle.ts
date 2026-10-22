import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXED = '2026-01-01T00:00:00Z';

/**
 * Commits a copy of the fixture directory (`app/` and `packages/`, plain files in this repo) into a throwaway git
 * repository and writes it as a git bundle: `/validate` clones from it as the build user. Fixed dates and identity,
 * so the same files give the same commit.
 */
export function bundleFixture(fixtureDir: string, outFile: string): void {
  if (!existsSync(join(fixtureDir, 'app'))) throw new Error(`fixture ${fixtureDir} has no app/ directory`);
  const tmp = mkdtempSync(join(tmpdir(), 'arco-fixture-'));
  try {
    cpSync(fixtureDir, tmp, { recursive: true, filter: (src) => !/(^|\/)(\.git|node_modules|vendor)$/.test(src) });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=arco-runner', '-c', 'user.email=runner@invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: FIXED, GIT_COMMITTER_DATE: FIXED },
    });
    git('init', '-q', '-b', 'main');
    git('add', '--all', '--force', '.');
    git('commit', '-q', '-m', 'fixture');
    git('bundle', 'create', outFile, '--all');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
