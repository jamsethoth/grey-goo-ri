import { createHash } from 'node:crypto';
import { runGit } from './git.mjs';

// Per-test status lines: node:test spec, TAP, jest, pytest. Each match yields [failed, ...names].
// A TAP description escapes `#` and `\`; an unescaped `#` starts a directive, and TODO or SKIP results do not
// decide the run's exit code, so they are recorded as the directive word instead of a failed flag.
const STATUS_LINES = [
  [/^\s*([✖✔])\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/, (m) => [m[1] === '✖', m[2]]],
  [/^\s*(not )?ok(?:\s+\d+)?(?:\s+-)?\s+((?:\\.|[^\\#])+?)\s*(?:#\s*(.*))?$/,
    (m) => [m[3]?.match(/^(todo|skip)\b/i)?.[1].toUpperCase() ?? Boolean(m[1]), m[2].replace(/\\(.)/g, '$1')]],
  [/^\s*([✕✓])\s+(.+?)(?:\s+\(\d+ m?s\))?\s*$/, (m) => [m[1] === '✕', m[2]]],
  // Jest's default reporter prints no per-test lines for several files, only a `● suite › test` heading per failure.
  [/^\s*●\s+(?!Console\b|Test suite failed to run\b)(.+?)\s*$/, (m) => [true, m[1], m[1].split(' › ').pop()]],
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

// A red run counts only if the runner exited nonzero on its own and a reported test is failing in its output.
export function redCheck(result, names) {
  if (result.timedOut) return { ok: false, reason: 'The red test run timed out, so it is not evidence of failing tests.' };
  if (result.code === null || result.code === 127) return { ok: false, reason: 'The test runner could not start or crashed (command not found or no exit code), so it is not evidence of failing tests.' };
  if (result.code === 0) return { ok: false, reason: 'The new tests did not fail before implementation.' };
  const missing = { ok: false, reason: `The test output does not mention any reported failing test (${names.join(', ') || 'none reported'}).` };
  const output = result.output.replace(ANSI, '');
  const statuses = testStatuses(output);
  if (statuses.size === 0) return names.some((nm) => nm && output.includes(nm)) ? { ok: true, heuristic: true } : { ...missing, heuristic: true };
  if (names.some((nm) => statuses.get(nm) === true)) return { ok: true };
  const passing = names.filter((nm) => statuses.get(nm) === false);
  if (passing.length) return { ok: false, reason: `The runner reports ${passing.join(', ')} as passing, so it is not evidence of a failing test.` };
  const excused = names.filter((nm) => typeof statuses.get(nm) === 'string');
  if (excused.length) return { ok: false, reason: `The runner marks ${excused.join(', ')} as TODO or SKIP, so its result does not count as a failing test.` };
  return missing;
}

export async function greenCheck(command, cwd, { runShell, timeoutMs = 30 * 60_000 }) {
  const t0 = Date.now();
  const r = await runShell(command, { cwd, timeoutMs });
  return { passed: r.code === 0 && !r.timedOut, code: r.code, output: r.output, timedOut: Boolean(r.timedOut), durationMs: Date.now() - t0 };
}

export const evidence = (command, result) => ({ command, output: result.output.slice(-3000) });

export const DEFAULT_TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/fixtures/**'];

const globRe = (glob) => new RegExp(`^${glob.split(/(\*\*\/|\*\*|\*)/).map((part) =>
  part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')}$`);

// Committed tests must be byte-identical to the baseline; renames count as both a removed and an added path.
// Ignored untracked files count too, listed one by one since a runner can still pick them up; installed
// dependencies are excluded because their own tests are not the repo's.
const DEPENDENCY_DIRS = [':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/site-packages/**'];

export async function testImmutability(cwd, baseline, globs = DEFAULT_TEST_GLOBS) {
  const paths = async ([verb, ...args]) => (await runGit([verb, '-z', ...args], { cwd })).stdout.split('\0').filter(Boolean);
  const all = [
    ...await paths(['diff', '--name-only', '--no-renames', baseline]),
    ...await paths(['ls-files', '--others', '--exclude-standard']),
    ...await paths(['ls-files', '--others', '--ignored', '--exclude-standard', '--', '.', ...DEPENDENCY_DIRS]),
  ];
  const res = globs.map(globRe);
  const changed = [...new Set(all)].filter((p) => res.some((re) => re.test(p))).sort();
  return { ok: changed.length === 0, changed };
}

const normaliseIssue = (issue) => issue.replace(/:\d+|\bline\s+\d+|\bL\d+\b/gi, '').replace(/\s+/g, ' ').trim();

export const findingsHash = (findings) => createHash('sha256')
  .update(findings.map((f) => `${f.file}|${f.severity}|${normaliseIssue(f.issue)}`).sort().join('\n'))
  .digest('hex');

export function reviewPass(response) {
  const reasons = [];
  if (response.dodMet !== true) reasons.push('The review does not confirm the definition of done is met.');
  if (response.tddEvidenceOk !== true) reasons.push('The review does not accept the TDD evidence.');
  for (const f of response.findings ?? []) if (f.severity === 'blocker' || f.severity === 'major') reasons.push(`${f.severity} finding in ${f.file}: ${f.issue}`);
  return { passed: reasons.length === 0, reasons };
}
