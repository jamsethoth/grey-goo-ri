import { createHash } from 'node:crypto';
import { read } from './refs.mjs';

// Per-test status lines: node:test spec, TAP, jest, pytest. Each match yields [failed, ...names].
// A TAP description escapes `#` and `\`; an unescaped `#` starts a directive, and TODO or SKIP results do not
// decide the run's exit code, so they are recorded as the directive word instead of a failed flag.
const STATUS_LINES = [
  [/^\s*([✖✔])\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/, (m) => [m[1] === '✖', m[2]]],
  [/^\s*(not )?ok(?:\s+\d+)?(?:\s+-)?\s+((?:\\.|[^\\#])+?)\s*(?:#\s*(.*))?$/,
    (m) => [m[3]?.match(/^(todo|skip)\b/i)?.[1].toUpperCase() ?? Boolean(m[1]), m[2].replace(/\\(.)/g, '$1')]],
  [/^\s*([✕✓])\s+(.+?)(?:\s+\(\d+ m?s\))?\s*$/, (m) => [m[1] === '✕', m[2]]],
  // Jest's default reporter prints no per-test lines for several files, only a `● suite › test` heading per failure.
  // Only the whole diagnostic headings are excluded, so a suite named `Console` keeps its failures.
  [/^\s*●\s+(?!(?:Console|Test suite failed to run)\s*$)(.+?)\s*$/, (m) => [true, m[1], m[1].split(' › ').pop()]],
  [/^(FAILED|PASSED|ERROR)\s+(\S+)/, (m) => [m[1] !== 'PASSED', m[2], m[2].split('::').pop()]],
];

// Colour and cursor escapes, which runners emit when FORCE_COLOR is set.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function testStatuses(output) {
  const failed = new Map();
  for (const line of output.split(/\r?\n/)) {
    for (const [re, read] of STATUS_LINES) {
      const m = line.match(re);
      if (!m) continue;
      const [fail, ...names] = read(m);
      // Duplicate names are legal: a genuine failure is never overwritten by a later TODO, SKIP or pass.
      for (const name of names) failed.set(name, failed.get(name) === true || fail);
      break;
    }
  }
  return failed;
}

// A red run counts only if the runner exited nonzero on its own and a reported test is failing in its output. A failure an
// agent can fix carries its `failure`: `passed` when the named tests passed, `missing` when the output does not name them
// (T4c, N5).
export function redCheck(result, names) {
  if (result.timedOut) return { ok: false, reason: 'The red test run timed out, so it is not evidence of failing tests.' };
  if (result.code === null || result.code === 127) return { ok: false, reason: 'The test runner could not start or crashed (command not found or no exit code), so it is not evidence of failing tests.' };
  if (result.code === 0) return { ok: false, failure: 'passed', reason: 'The new tests did not fail before implementation.' };
  const missing = { ok: false, failure: 'missing', reason: `The test output does not mention any reported failing test (${names.join(', ') || 'none reported'}).` };
  const output = result.output.replace(ANSI, '');
  const statuses = testStatuses(output);
  if (statuses.size === 0) return names.some((nm) => nm && output.includes(nm)) ? { ok: true, heuristic: true } : { ...missing, heuristic: true };
  if (names.some((nm) => statuses.get(nm) === true)) return { ok: true };
  const passing = names.filter((nm) => statuses.get(nm) === false);
  if (passing.length) return { ok: false, failure: 'passed', reason: `The runner reports ${passing.join(', ')} as passing, so it is not evidence of a failing test.` };
  const excused = names.filter((nm) => typeof statuses.get(nm) === 'string');
  if (excused.length) return { ok: false, reason: `The runner marks ${excused.join(', ')} as TODO or SKIP, so its result does not count as a failing test.` };
  return missing;
}

export async function greenCheck(command, cwd, { runShell, timeoutMs = 30 * 60_000 }) {
  const t0 = Date.now();
  const r = await runShell(command, { cwd, timeoutMs });
  return { passed: r.code === 0 && !r.timedOut, code: r.code, output: r.output, timedOut: Boolean(r.timedOut), durationMs: Date.now() - t0 };
}

// Evidence stays raw for agent Briefs and is redacted where it is published. Its storage cut keeps whole lines only: a
// partial first line could start inside a local path, where redaction no longer recognises it.
const EVIDENCE_LIMIT = 65_536;
export function evidence(command, result) {
  const output = String(result.output ?? '');
  const cut = output.length - EVIDENCE_LIMIT;
  if (cut <= 0) return { command, output };
  const newline = output.indexOf('\n', cut - 1);
  const kept = newline >= 0 ? output.slice(newline + 1) : '';
  return { command, output: kept || `[${output.length} characters of output omitted]` };
}

export const DEFAULT_TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/fixtures/**'];

const globRe = (glob) => new RegExp(`^${glob.split(/(\*\*\/|\*\*|\*)/).map((part) =>
  part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')}${
  glob.includes('*') ? '' : '(?:/.*)?'}$`, 's');
const foldAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// Whether a path is a test under the repository's testPaths globs: the one rule Test Immutability and diffStats share. It
// reads a glob preflight accepts as the :(glob,icase) pathspecs that list a rollback's untracked tests do: ASCII case
// only is folded, and a glob without a wildcard also matches what is under it.
export const testPathMatcher = (globs) => {
  const res = globs.map((g) => globRe(foldAscii(g)));
  return (path) => res.some((re) => re.test(foldAscii(path)));
};

// Committed tests must be byte-identical to the baseline; renames count as both a removed and an added path.
// Ignored untracked files count too, listed one by one since a runner can still pick them up; installed
// dependencies are excluded because their own tests are not the repo's.
const DEPENDENCY_DIRS = ['**/node_modules/**', '**/site-packages/**'];

// The same test paths, for listing the untracked ones a rollback must restore.
export const testPathSet = (globs) => ({ globs, exclude: DEPENDENCY_DIRS });

export async function testImmutability(cwd, baseline, { globs, git }) {
  const all = [
    ...await git.changedSince(cwd, baseline),
    ...await git.untrackedPaths(cwd),
    ...await git.untrackedPaths(cwd, { include: 'ignored', within: { exclude: DEPENDENCY_DIRS } }),
  ];
  const isTest = testPathMatcher(globs);
  const changed = [...new Set(all)].filter(isTest).sort();
  return { ok: changed.length === 0, changed };
}

const normalise = (text) => String(text ?? '').replace(/:\d+|\bline\s+\d+|\bL\d+\b/gi, '').replace(/\s+/g, ' ').trim();

// The `repeat` Check's fingerprint of a list (R4c): each item's fields with whitespace and line numbers stripped, in any order.
export const findingsHash = (findings, fields = ['file', 'severity', 'issue']) => createHash('sha256')
  .update(findings.map((f) => fields.map((k) => normalise(f[k])).join('|')).sort().join('\n'))
  .digest('hex');

const QUANTIFIERS = { none: (n) => n === 0, any: (n) => n > 0 };
const OPS = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '=': (a, b) => a === b };

// One condition of a `response` Check (R4a, P5d): the reasons it fails, empty when it holds.
function failures(response, c) {
  if (c['all-of']) return c['all-of'].flatMap((each) => failures(response, each));
  if (Object.hasOwn(c, 'field')) {
    const v = read(response, c.field);
    return v === c.is ? [] : [`${c.field} is ${JSON.stringify(v)}, expected ${JSON.stringify(c.is)}`];
  }
  const [form] = ['none', 'any', 'all', 'count'].filter((k) => Object.hasOwn(c, k));
  const items = read(response, c[form]) ?? [];
  const where = Object.entries(c.where ?? {});
  const n = items.filter((item) => where.every(([f, v]) => [v].flat().includes(item[f]))).length;
  const op = Object.keys(OPS).find((o) => Object.hasOwn(c, o));
  // The validator rejects a count with no comparison; one that slips through fails rather than throws.
  if (form === 'count' && !op) return [`the count of ${c.count} names no comparison`];
  const holds = form === 'all' ? n === items.length : form === 'count' ? OPS[op](n, c[op]) : QUANTIFIERS[form](n);
  const expected = form === 'count' ? `${op} ${c[op]}` : { none: 'none', any: 'at least one', all: 'all' }[form];
  const matching = where.length ? ` where ${where.map(([f, v]) => `${f} is ${[v].flat().join(' or ')}`).join(' and ')}` : '';
  return holds ? [] : [`${c[form]} has ${n} of ${items.length} items${matching}; expected ${expected}`];
}

export function responseCheck(response, condition) {
  const reasons = failures(response, condition);
  return { passed: reasons.length === 0, reasons };
}
