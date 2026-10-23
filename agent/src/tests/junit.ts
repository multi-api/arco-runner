/** Flag rule for the JUnit report of `build.tests`, and a dependency-free JUnit parser and summary. */

export const JUNIT_PATH = '/tmp/arco-tests/junit.xml';

export interface JUnitCase { class: string; name: string; status: 'passed' | 'failed' | 'error' | 'skipped'; message: string }
export interface TestsParams {
  passed: number | null; failed: number | null; errors: number | null; skipped: number | null;
  duration_s: number; report: 'junit' | 'none';
  failures?: { class: string; name: string; message: string }[];
}

const MAX_FAILURES = 50;
const MAX_MESSAGE_BYTES = 2048;
const MAX_DEPTH = 256;
const MAX_ATTRS = 128;
const MAX_ELEMENTS = 2_000_000;
const MAX_ATTR_VALUE = 1024 * 1024;
const MAX_RAW_MESSAGE_BYTES = 64 * 1024;
const MAX_LABEL_BYTES = 512;
const MAX_NODE_TEXT = 64 * 1024;

/** Splits on top-level `&&`, `||` and `;` outside single and double quotes. */
function splitChain(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]!;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) { cur += c + command[++i]!; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const RUNNER = /^(?:php\s+artisan\s+test|(?:\.\/)?vendor\/bin\/(?:pest|phpunit))(?:\s|$)/;

function startsWithRunner(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return RUNNER.test(words.slice(i).join(' '));
}

/** Appends `--log-junit=<reportPath>` to the last command of the chain when it is a PHP test runner. */
export function withJUnit(command: string, reportPath: string): { command: string; report: 'junit' | 'none' } {
  const none = { command, report: 'none' as const };
  const segments = splitChain(command);
  const last = segments[segments.length - 1]!;
  if (!startsWithRunner(last)) return none;
  // A pipe, redirect, background, subshell, substitution, backtick or newline: the flag could land on another command.
  if (/[|<>&`()\n\r]/.test(last)) return none;
  if (/--log-junit\b/.test(last)) return none;
  return { command: `${command.trimEnd()} --log-junit=${reportPath}`, report: 'junit' };
}

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e]!;
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return String.fromCodePoint(cp);
  });
}

interface Node { name: string; attrs: Record<string, string>; text: string; kids: Node[] }

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isNameChar = (c: string): boolean => !isSpace(c) && c !== '=' && c !== '>' && c !== '/' && c !== '<' && c !== '"' && c !== "'";

/** Parses a tag body starting after `<`; returns the new position after `>`. */
function parseStartTag(xml: string, from: number): { node: Node; selfClosing: boolean; end: number } {
  let i = from;
  const n = xml.length;
  let s = i;
  while (i < n && isNameChar(xml[i]!)) i++;
  if (i === s) throw new Error('malformed XML: empty tag name');
  const node: Node = { name: xml.slice(s, i), attrs: {}, text: '', kids: [] };
  let count = 0;
  for (;;) {
    while (i < n && isSpace(xml[i]!)) i++;
    if (i >= n) throw new Error('malformed XML: unterminated tag');
    const c = xml[i]!;
    if (c === '>') return { node, selfClosing: false, end: i + 1 };
    if (c === '/') {
      if (xml[i + 1] !== '>') throw new Error('malformed XML: stray "/" in tag');
      return { node, selfClosing: true, end: i + 2 };
    }
    s = i;
    while (i < n && isNameChar(xml[i]!)) i++;
    if (i === s) throw new Error('malformed XML: bad attribute name');
    const attr = xml.slice(s, i);
    while (i < n && isSpace(xml[i]!)) i++;
    if (xml[i] !== '=') throw new Error('malformed XML: attribute without value');
    i++;
    while (i < n && isSpace(xml[i]!)) i++;
    const q = xml[i];
    if (q !== '"' && q !== "'") throw new Error('malformed XML: unquoted attribute value');
    const close = xml.indexOf(q, i + 1);
    if (close < 0) throw new Error('malformed XML: unterminated attribute value');
    if (close - i - 1 > MAX_ATTR_VALUE) throw new Error('malformed XML: attribute value too long');
    if (++count > MAX_ATTRS) throw new Error('malformed XML: too many attributes');
    node.attrs[attr] = decode(xml.slice(i + 1, close));
    i = close + 1;
  }
}

/** Parses PHPUnit and Pest JUnit XML. Throws `Error` on malformed input; its work is linear in the input. */
export function parseJUnit(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  const stack: Node[] = [];
  let caseDepth = -1;
  let elements = 0;
  let sawRoot = false;
  let closedRoot = false;
  let i = 0;
  const n = xml.length;
  const addText = (t: string): void => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (t.trim() !== '') throw new Error('malformed XML: text outside the root element');
      return;
    }
    if (caseDepth >= 0 && top.text.length < MAX_NODE_TEXT) top.text += t.slice(0, MAX_NODE_TEXT - top.text.length);
  };
  const finishCase = (node: Node): void => {
    let status: JUnitCase['status'] = 'passed';
    let source: Node | null = null;
    for (const k of node.kids) {
      const s = k.name === 'error' ? 'error' : k.name === 'failure' ? 'failed' : k.name === 'skipped' ? 'skipped' : null;
      if (!s) continue;
      const rank = (x: string): number => (x === 'error' || x === 'failed' ? 2 : 1);
      if (!source || rank(s) > rank(status)) { status = s; source = k; }
    }
    const message = source ? ((source.attrs.message ?? '') !== '' ? source.attrs.message! : source.text.trim()) : '';
    cases.push({ class: node.attrs.class || node.attrs.classname || '', name: node.attrs.name ?? '', status, message });
  };
  const closeNode = (node: Node, depth: number): void => {
    if (node.name === 'testcase' && depth === caseDepth) { caseDepth = -1; finishCase(node); return; }
    const parent = stack[stack.length - 1];
    if (caseDepth >= 0 && parent && stack.length - 1 === caseDepth && parent.kids.length < 64) parent.kids.push(node);
  };
  const open = (node: Node, selfClosing: boolean): void => {
    if (closedRoot) throw new Error('malformed XML: content after the root element');
    if (++elements > MAX_ELEMENTS) throw new Error('malformed XML: too many elements');
    sawRoot = true;
    if (stack.length >= MAX_DEPTH) throw new Error('malformed XML: nested too deeply');
    if (node.name === 'testcase' && caseDepth < 0) caseDepth = stack.length;
    if (selfClosing) {
      const depth = stack.length;
      if (node.name === 'testcase' && depth === caseDepth) { caseDepth = -1; finishCase(node); } else closeNode(node, depth);
      if (stack.length === 0) closedRoot = true;
      return;
    }
    stack.push(node);
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { addText(decode(xml.slice(i))); break; }
    if (lt > i) addText(decode(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('malformed XML: unterminated comment');
      i = e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('malformed XML: unterminated CDATA');
      if (stack.length === 0) throw new Error('malformed XML: CDATA outside the root element');
      addText(xml.slice(lt + 9, e));
      i = e + 3;
    } else if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) throw new Error('malformed XML: unterminated processing instruction');
      i = e + 2;
    } else if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new Error('malformed XML: unterminated declaration');
      if (xml.slice(lt, e).includes('[')) throw new Error('malformed XML: DOCTYPE internal subset not supported');
      i = e + 1;
    } else if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new Error('malformed XML: unterminated end tag');
      const name = xml.slice(lt + 2, e).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error('malformed XML: mismatched end tag');
      closeNode(node, stack.length);
      if (stack.length === 0) closedRoot = true;
      i = e + 1;
    } else {
      const t = parseStartTag(xml, lt + 1);
      open(t.node, t.selfClosing);
      i = t.end;
    }
  }
  if (stack.length > 0) throw new Error('malformed XML: unclosed element');
  if (!sawRoot) throw new Error('malformed XML: no root element');
  return cases;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character; no marker. */
export function cutBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Counts, plus up to 50 failures whose messages are masked first and then cut to 2 KB. */
export function summarize(cases: JUnitCase[] | null, durationMs: number, redact: (s: string) => string): TestsParams {
  const duration_s = Math.round(durationMs / 100) / 10;
  if (cases === null) return { passed: null, failed: null, errors: null, skipped: null, duration_s, report: 'none' };
  const count = (s: JUnitCase['status']): number => cases.filter((c) => c.status === s).length;
  const params: TestsParams = {
    passed: count('passed'), failed: count('failed'), errors: count('error'), skipped: count('skipped'), duration_s, report: 'junit',
  };
  const failures = cases
    .filter((c) => c.status === 'failed' || c.status === 'error')
    .slice(0, MAX_FAILURES)
    .map((c) => ({
      class: cutBytes(redact(cutBytes(c.class, MAX_LABEL_BYTES * 2)), MAX_LABEL_BYTES),
      name: cutBytes(redact(cutBytes(c.name, MAX_LABEL_BYTES * 2)), MAX_LABEL_BYTES),
      // Pre-cut bounds the redaction work; secrets are far shorter than the slack up to 2 KB, so mask-then-cut still holds.
      message: cutBytes(redact(cutBytes(c.message, MAX_RAW_MESSAGE_BYTES)), MAX_MESSAGE_BYTES),
    }));
  if (failures.length > 0) params.failures = failures;
  return params;
}
