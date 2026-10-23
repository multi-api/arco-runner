import { Redactor } from '@multiapi/arco-cloud-client';
import { describe, expect, it } from 'vitest';
import { cutBytes, parseJUnit, summarize, withJUnit, type JUnitCase } from '../src/tests/junit.js';

const P = '/tmp/arco-tests/junit.xml';
const id = new Redactor();
const masker = (...secrets: string[]): Redactor => { const r = new Redactor(); for (const x of secrets) r.add(x); return r; };

describe('withJUnit', () => {
  it('appends the flag to php artisan test, vendor/bin/pest and vendor/bin/phpunit', () => {
    for (const c of ['php artisan test --parallel', './vendor/bin/pest', 'vendor/bin/phpunit --filter X', 'APP_DEBUG=1 php artisan test']) {
      expect(withJUnit(c, P)).toEqual({ command: `${c} --log-junit=${P}`, report: 'junit' });
    }
  });
  it('appends to the last command of a chain only', () => {
    const c = 'vendor/bin/pint --test && php artisan test';
    expect(withJUnit(c, P)).toEqual({ command: `${c} --log-junit=${P}`, report: 'junit' });
    const d = 'php artisan test && echo done';
    expect(withJUnit(d, P)).toEqual({ command: d, report: 'none' });
    const q = 'echo "a && b" ; php artisan test';
    expect(withJUnit(q, P).report).toBe('junit');
  });
  it('appends nothing when the last segment has a pipe, redirect, background, subshell or an existing --log-junit', () => {
    for (const c of [
      'php artisan test | tee x', 'php artisan test > out', 'php artisan test &', 'php artisan test $(id)',
      'php artisan test `id`', 'php artisan test --log-junit=foo', 'php artisan test\nrm x',
    ]) expect(withJUnit(c, P)).toEqual({ command: c, report: 'none' });
  });
  it('stays conservative on quoted operators and quoted assignments', () => {
    const q = 'php artisan test --filter "a|b"';
    expect(withJUnit(q, P)).toEqual({ command: q, report: 'none' });
    // A quoted assignment value with a space is not recognised as an assignment: no flag.
    const a = 'FOO="a b" php artisan test';
    expect(withJUnit(a, P)).toEqual({ command: a, report: 'none' });
  });
  it('appends nothing to other commands', () => {
    for (const c of ['composer test', 'phpunit', 'php artisan testing', 'vendor/bin/pestx']) {
      expect(withJUnit(c, P)).toEqual({ command: c, report: 'none' });
    }
  });
});

const PHPUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="Unit" tests="5"><testsuite name="Nested">
<testcase name="ok" class="Tests\\A" file="a.php"/>
<testcase name="bad" class="Tests\\A"><failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that &lt;b&gt; &#x41; is true.
/a.php:10</failure></testcase>
<testcase name="boom" class="Tests\\B"><error type="RuntimeException"><![CDATA[Oops <raw> & more]]></error></testcase>
<testcase name="later" class="Tests\\B"><skipped/></testcase>
</testsuite></testsuite></testsuites>`;
const PEST = `<testsuites><testsuite name="x"><testcase name="it works" classname="Tests.Feature.X">
<failure type="Pest" message="expected 1 got 2">trace</failure></testcase>
<testcase name="skip me" classname="Tests.Feature.X"><skipped message="not now"/></testcase></testsuite></testsuites>`;

describe('parseJUnit', () => {
  it('parses PHPUnit 11 and Pest JUnit', () => {
    expect(parseJUnit(PHPUNIT)).toEqual([
      { class: 'Tests\\A', name: 'ok', status: 'passed', message: '' },
      { class: 'Tests\\A', name: 'bad', status: 'failed', message: 'Failed asserting that <b> A is true.\n/a.php:10' },
      { class: 'Tests\\B', name: 'boom', status: 'error', message: 'Oops <raw> & more' },
      { class: 'Tests\\B', name: 'later', status: 'skipped', message: '' },
    ]);
    expect(parseJUnit(PEST)).toEqual([
      { class: 'Tests.Feature.X', name: 'it works', status: 'failed', message: 'expected 1 got 2' },
      { class: 'Tests.Feature.X', name: 'skip me', status: 'skipped', message: 'not now' },
    ]);
  });
  it('throws on malformed XML', () => {
    for (const x of ['', 'not xml', '<a><b></a>', '<testsuite><testcase>', '<a x=1/>', '<a><![CDATA[x</a>', '<a><!-- x</a>', '<a', '<a/><b/>']) {
      expect(() => parseJUnit(x), x).toThrow(Error);
    }
  });
  it('throws on a DOCTYPE internal subset and on oversized attribute values', () => {
    expect(() => parseJUnit('<!DOCTYPE a [<!ENTITY x "y">]><a/>')).toThrow(/DOCTYPE/);
    expect(() => parseJUnit(`<a name="${'x'.repeat(1024 * 1024 + 1)}"/>`)).toThrow(/too long/);
    expect(parseJUnit(`<testcase name="${'x'.repeat(1024 * 1024)}"/>`)).toHaveLength(1);
  });
  it('bounds hostile input', () => {
    expect(() => parseJUnit('<a>'.repeat(10_000))).toThrow(/too deeply/);
    const attrs = Array.from({ length: 1000 }, (_, i) => `a${i}="x"`).join(' ');
    expect(() => parseJUnit(`<a ${attrs}/>`)).toThrow(/too many attributes/);
    expect(() => parseJUnit('<a ' + 'b="'.repeat(1) + 'x'.repeat(100000))).toThrow(Error);
    expect(() => parseJUnit('<' + 'a'.repeat(100000))).toThrow(Error);
  });
});

describe('summarize', () => {
  const fail = (i: number): JUnitCase => ({ class: 'C', name: `t${i}`, status: 'failed', message: 'm' });
  it('summarizes counts and caps failures at 50', () => {
    const s = summarize(Array.from({ length: 60 }, (_, i) => fail(i)), 1250, id);
    expect(s).toMatchObject({ passed: 0, failed: 60, errors: 0, skipped: 0, duration_s: 1.3, report: 'junit' });
    expect(s.failures).toHaveLength(50);
    expect(summarize([{ class: '', name: 'a', status: 'passed', message: '' }], 1234, id).duration_s).toBe(1.2);
  });
  it('masks a message before cutting it to 2048 bytes', () => {
    const secret = 'S3CR3T-VALUE-XYZ';
    const msg = 'a'.repeat(2040) + secret + 'b'.repeat(960);
    const redact = masker(secret);
    const out = summarize([{ class: 'C', name: 'n', status: 'failed', message: msg }], 0, redact).failures![0]!.message;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
    expect(out.slice(2040, 2043)).toBe('***');
    expect(out).not.toContain('S3CR');
    const e = summarize([{ class: 'C', name: 'n', status: 'error', message: 'é'.repeat(3000) }], 0, id).failures![0]!.message;
    expect(e).not.toContain('�');
    expect(Buffer.byteLength(e)).toBeLessThanOrEqual(2048);
    expect(cutBytes('é'.repeat(5), 3)).toBe('é');
  });
  it('bounds huge class, name and message values', () => {
    const secret = 'TOPSECRET';
    const redact = masker(secret);
    const f = summarize([{
      class: 'c'.repeat(5_000_000), status: 'failed' as const, name: 'n'.repeat(5_000_000),
      message: 'x'.repeat(100) + secret + 'y'.repeat(3_000_000),
    }], 0, redact).failures![0]!;
    expect(Buffer.byteLength(f.name)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(f.class)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(f.message)).toBeLessThanOrEqual(2048);
    expect(f.message.slice(100, 103)).toBe('***');
    expect(f.message).not.toContain(secret);
  });
  // Masking shrinks text, so a secret cut at a pre-cut (or parser) boundary used to slide unmasked into the final window.
  const SECRET = 'S3CR3T-' + 'Z'.repeat(996); // 1003 bytes; 'S' and 'Z' appear nowhere else
  const leaks = (out: string): boolean => /[SZ]/.test(out.replace(/\*\*\*/g, ''));
  it('never leaves a prefix of a long secret repeated in a failure message (attribute)', () => {
    const r = masker(SECRET);
    for (let pad = 0; pad < 1100; pad += 37) {
      const msg = 'a'.repeat(pad) + (SECRET + ' ').repeat(70);
      const f = summarize([{ class: 'C', name: 'n', status: 'failed', message: msg }], 0, r).failures![0]!;
      expect(leaks(f.message), `pad ${pad}`).toBe(false);
      expect(Buffer.byteLength(f.message)).toBeLessThanOrEqual(2048);
    }
  });
  it('never leaves a prefix of a long secret repeated in a failure body cut by the parser', () => {
    const r = masker(SECRET);
    for (let pad = 0; pad < 1100; pad += 101) {
      const body = 'a'.repeat(pad) + (SECRET + ' ').repeat(70);
      const xml = `<testsuites><testsuite><testcase class="C" name="n"><failure>${body}</failure></testcase></testsuite></testsuites>`;
      const f = summarize(parseJUnit(xml), 0, r).failures![0]!;
      expect(leaks(f.message), `pad ${pad}`).toBe(false);
    }
  });
  it('never leaves a prefix of a token repeated in a test name or class', () => {
    const token = 'S3CR3T-TOKEN' + 'Z'.repeat(88); // 100 bytes
    const r = masker(token);
    for (let pad = 0; pad < 120; pad += 7) {
      const label = 'with data set "' + 'a'.repeat(pad) + (token + ',').repeat(700);
      const f = summarize([{ class: label, name: label, status: 'failed', message: 'm' }], 0, r).failures![0]!;
      expect(leaks(f.name), `name pad ${pad}`).toBe(false);
      expect(leaks(f.class), `class pad ${pad}`).toBe(false);
      expect(Buffer.byteLength(f.name)).toBeLessThanOrEqual(512);
    }
  });
  it('never leaves a prefix of an encoded secret variant at a cut', () => {
    const b64 = Buffer.from(SECRET).toString('base64');
    const r = masker(SECRET);
    for (let pad = 0; pad < 1400; pad += 53) {
      const msg = 'a'.repeat(pad) + (b64 + ' ').repeat(50);
      const out = summarize([{ class: 'C', name: 'n', status: 'failed', message: msg }], 0, r).failures![0]!.message;
      expect(out.replace(/\*\*\*/g, '')).toMatch(/^[a ]*$/);
    }
  });
  it('keeps text that merely looks like a secret prefix when nothing was cut', () => {
    const f = summarize([{ class: 'C', name: 'n', status: 'failed', message: 'value S3CR' }], 0, masker(SECRET)).failures![0]!;
    expect(f.message).toBe('value S3CR');
  });
  it('returns null counts for report none', () => {
    expect(summarize(null, 1234, id)).toEqual({ passed: null, failed: null, errors: null, skipped: null, duration_s: 1.2, report: 'none' });
  });
});
