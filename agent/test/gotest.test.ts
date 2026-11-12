import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGoTestJson, withGoJson } from '../src/tests/gotest.js';

const R = '/tmp/arco-tests/go-test.json';
const ev = (e: Record<string, unknown>): string => JSON.stringify(e);

describe('withGoJson', () => {
  it('adds -json to go test, tees the events to the report and pipes them back to text', () => {
    for (const [c, want] of [
      ['go test ./...', 'go test -json ./...'],
      ['go test', 'go test -json'],
      ['go  test -race -count=1 ./...', 'go  test -json -race -count=1 ./...'],
      ['CGO_ENABLED=0 go test ./...', 'CGO_ENABLED=0 go test -json ./...'],
      ['go generate ./... && go test ./...', 'go generate ./... && go test -json ./...'],
      ['make deps; go test -run TestA ./pkg', 'make deps; go test -json -run TestA ./pkg'],
    ] as const) {
      const r = withGoJson(c, R);
      expect(r.report).toBe('go');
      expect(r.command.startsWith(`${want} | tee ${R} | node -e '`)).toBe(true);
      expect(r.command.endsWith("'")).toBe(true);
    }
  });

  it('leaves other commands alone', () => {
    for (const c of [
      'make test', 'go vet ./...', 'go test ./... | tee out.txt', 'go test ./... > out.txt', 'go test -json ./...',
      'go test --json ./...', 'go test ./... && echo done', '(go test ./...)', 'gotest ./...', 'go testify',
    ]) {
      expect(withGoJson(c, R)).toEqual({ command: c, report: 'none' });
    }
  });
});

describe('parseGoTestJson', () => {
  it('turns tests and subtests into cases, with the failing output as message', () => {
    const text = [
      ev({ Action: 'start', Package: 'example.com/app' }),
      ev({ Action: 'run', Package: 'example.com/app', Test: 'TestOK' }),
      ev({ Action: 'output', Package: 'example.com/app', Test: 'TestOK', Output: '=== RUN   TestOK\n' }),
      ev({ Action: 'pass', Package: 'example.com/app', Test: 'TestOK' }),
      ev({ Action: 'output', Package: 'example.com/app', Test: 'TestBad', Output: '=== RUN   TestBad\n' }),
      ev({ Action: 'output', Package: 'example.com/app', Test: 'TestBad', Output: '    app_test.go:12: got 1, want 2\n' }),
      ev({ Action: 'output', Package: 'example.com/app', Test: 'TestBad', Output: '--- FAIL: TestBad (0.00s)\n' }),
      ev({ Action: 'fail', Package: 'example.com/app', Test: 'TestBad' }),
      ev({ Action: 'pass', Package: 'example.com/app', Test: 'TestT/sub' }),
      ev({ Action: 'skip', Package: 'example.com/app', Test: 'TestSkip' }),
      ev({ Action: 'fail', Package: 'example.com/app' }),
      'not json',
    ].join('\n');
    expect(parseGoTestJson(text)).toEqual([
      { class: 'example.com/app', name: 'TestOK', status: 'passed', message: '' },
      { class: 'example.com/app', name: 'TestBad', status: 'failed', message: 'app_test.go:12: got 1, want 2\n--- FAIL: TestBad (0.00s)' },
      { class: 'example.com/app', name: 'TestT/sub', status: 'passed', message: '' },
      { class: 'example.com/app', name: 'TestSkip', status: 'skipped', message: '' },
    ]);
  });

  it('reports a package that failed without a failed test (build failure, panic) as one error case', () => {
    const text = [
      ev({ ImportPath: 'example.com/broken [example.com/broken.test]', Action: 'build-output', Output: '# example.com/broken\n' }),
      ev({ ImportPath: 'example.com/broken [example.com/broken.test]', Action: 'build-output', Output: './x.go:3:1: syntax error\n' }),
      ev({ Action: 'output', Package: 'example.com/broken', Output: 'FAIL\texample.com/broken [build failed]\n' }),
      ev({ Action: 'fail', Package: 'example.com/broken', FailedBuild: 'example.com/broken [example.com/broken.test]' }),
      ev({ Action: 'output', Package: 'example.com/panics', Output: 'panic: boom\n' }),
      ev({ Action: 'fail', Package: 'example.com/panics' }),
    ].join('\n');
    expect(parseGoTestJson(text)).toEqual([
      { class: 'example.com/broken', name: '(package)', status: 'error', message: '# example.com/broken\n./x.go:3:1: syntax error' },
      { class: 'example.com/panics', name: '(package)', status: 'error', message: 'panic: boom' },
    ]);
  });

  it('throws when there is no event, so the phase falls back to the exit code', () => {
    expect(() => parseGoTestJson('')).toThrow('no go test events');
    expect(() => parseGoTestJson('ok  example.com/app 0.01s\n')).toThrow('no go test events');
  });
});

const hasGo = spawnSync('go', ['version']).status === 0;

describe.runIf(hasGo)('withGoJson with a real go test', () => {
  it('keeps the exit code under pipefail, logs readable text and writes a parsable report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arco-gotest-'));
    await writeFile(join(dir, 'go.mod'), 'module example.com/t\n\ngo 1.22\n');
    await writeFile(join(dir, 't_test.go'), [
      'package t', '', 'import "testing"', '',
      'func TestOK(t *testing.T) {}', '',
      'func TestBad(t *testing.T) { t.Fatal("nope") }', '',
    ].join('\n'));
    const report = join(dir, 'report.json');
    const { command } = withGoJson('go test ./...', report);
    const r = spawnSync('bash', ['-c', `set -o pipefail; ${command}`], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GOFLAGS: '-modcacherw', GOTOOLCHAIN: 'local', GOPROXY: 'off' },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('--- FAIL: TestBad');
    expect(r.stdout).toContain('t_test.go:7: nope');
    expect(r.stdout).not.toContain('=== RUN');
    expect(r.stdout).not.toContain('"Action"');
    const cases = parseGoTestJson(await readFile(report, 'utf8'));
    expect(cases.map((c) => [c.name, c.status])).toEqual([['TestOK', 'passed'], ['TestBad', 'failed']]);
    expect(cases[1]!.message).toContain('nope');
    execFileSync('rm', ['-rf', dir]);
  }, 60_000);
});
