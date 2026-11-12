/** `go test -json` for `build.tests`: the command rewrite, the log filter and the report parser (into JUnitCase). */

import type { JUnitCase } from './junit.js';
import { splitChain } from './junit.js';

/** `go test` after optional VAR=value assignments (unquoted values only), at the start of a chain segment. */
const GO_TEST = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*go\s+test(?=\s|$)/;
const MAX_OUTPUT = 64 * 1024;

/**
 * Turns the event stream back into `go test`'s usual text for the log: every Output except the `=== RUN/PAUSE/CONT/NAME`
 * lines -json adds. A line that is not JSON passes through. Single-quoted for sh, so it holds no single quote.
 */
const FILTER = 'const r=require("readline").createInterface({input:process.stdin});'
  + 'r.on("line",l=>{let e;try{e=JSON.parse(l)}catch{process.stdout.write(l+"\\n");return}'
  + 'if(e&&e.Action==="output"&&typeof e.Output==="string"&&!/^=== (RUN|PAUSE|CONT|NAME) /.test(e.Output))process.stdout.write(e.Output)})';

/**
 * When the last command of the chain is `go test` (after VAR=value assignments), adds `-json` and pipes the events into
 * `reportPath` and back to readable text, so the log reads as usual. The test phase runs with pipefail, so the exit code
 * stays go test's. Left alone (no report) with a pipe, redirect, background, subshell, substitution or newline in that
 * command, or when it already asks for -json.
 */
export function withGoJson(command: string, reportPath: string): { command: string; report: 'go' | 'none' } {
  const none = { command, report: 'none' as const };
  const segments = splitChain(command);
  const last = segments[segments.length - 1]!;
  if (!command.endsWith(last)) return none;
  if (/[|<>&`()\n\r]/.test(last)) return none;
  const m = GO_TEST.exec(last);
  if (!m) return none;
  if (last.slice(m[0].length).split(/\s+/).some((w) => /^--?json(?:=|$)/.test(w))) return none;
  const head = command.slice(0, command.length - last.length);
  const rewritten = `${last.slice(0, m[0].length)} -json${last.slice(m[0].length)}`.trimEnd();
  return { command: `${head}${rewritten} | tee ${reportPath} | node -e '${FILTER}'`, report: 'go' };
}

interface GoEvent { Action?: unknown; Package?: unknown; Test?: unknown; Output?: unknown; ImportPath?: unknown; FailedBuild?: unknown }

const append = (map: Map<string, { text: string; truncated: boolean }>, key: string, text: string): void => {
  const cur = map.get(key) ?? { text: '', truncated: false };
  if (cur.text.length + text.length > MAX_OUTPUT) cur.truncated = true;
  if (cur.text.length < MAX_OUTPUT) cur.text += text.slice(0, MAX_OUTPUT - cur.text.length);
  map.set(key, cur);
};

const tidy = (s: string): string => s.split('\n').filter((l) => !/^=== (RUN|PAUSE|CONT|NAME) /.test(l)).join('\n').trim();

/**
 * Parses `go test -json` output (one event per line; lines that are not events are skipped). Each test (subtests too) is
 * a case of class <package>; a package that failed with no failed test of its own (a build failure, a panic in TestMain,
 * a timeout) is one `error` case named `(package)` carrying its output. Throws when there is no event at all.
 */
export function parseGoTestJson(text: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  const testOut = new Map<string, { text: string; truncated: boolean }>();
  const pkgOut = new Map<string, { text: string; truncated: boolean }>();
  const buildOut = new Map<string, { text: string; truncated: boolean }>();
  const failedTests = new Set<string>();
  let events = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: GoEvent;
    try { e = JSON.parse(line) as GoEvent; } catch { continue; }
    if (typeof e !== 'object' || e === null) continue;
    events++;
    const action = typeof e.Action === 'string' ? e.Action : '';
    const pkg = typeof e.Package === 'string' ? e.Package : '';
    const test = typeof e.Test === 'string' ? e.Test : '';
    const output = typeof e.Output === 'string' ? e.Output : '';
    if (action === 'build-output' && typeof e.ImportPath === 'string') { append(buildOut, e.ImportPath, output); continue; }
    if (action === 'output') { append(test ? testOut : pkgOut, test ? `${pkg}\u0000${test}` : pkg, output); continue; }
    if (action !== 'pass' && action !== 'fail' && action !== 'skip') continue;
    if (test) {
      const status = action === 'pass' ? 'passed' : action === 'skip' ? 'skipped' : 'failed';
      const c: JUnitCase = { class: pkg, name: test, status, message: '' };
      if (status === 'failed') {
        failedTests.add(pkg);
        const out = testOut.get(`${pkg}\u0000${test}`);
        c.message = tidy(out?.text ?? '');
        if (out?.truncated) c.truncated = true;
      }
      cases.push(c);
    } else if (action === 'fail' && !failedTests.has(pkg)) {
      const build = typeof e.FailedBuild === 'string' ? buildOut.get(e.FailedBuild) : undefined;
      const out = build ?? pkgOut.get(pkg);
      const c: JUnitCase = { class: pkg, name: '(package)', status: 'error', message: tidy(out?.text ?? '') };
      if (out?.truncated) c.truncated = true;
      cases.push(c);
    }
  }
  if (events === 0) throw new Error('no go test events');
  return cases;
}
