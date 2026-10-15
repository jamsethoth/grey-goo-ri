import { createHash } from 'node:crypto';
import { runGit } from './git.mjs';

// Per-test status lines: node:test spec, TAP, jest, pytest. Each match yields [failed, name].
const STATUS_LINES = [
  [/^\s*([✖✔])\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/, (m) => [m[1] === '✖', m[2]]],
  [/^\s*(not )?ok(?:\s+\d+)?(?:\s+-)?\s+(.+?)(?:\s+#.*)?\s*$/, (m) => [Boolean(m[1]), m[2]]],
  [/^\s*([✕✓])\s+(.+?)(?:\s+\(\d+ m?s\))?\s*$/, (m) => [m[1] === '✕', m[2]]],
  [/^(FAILED|PASSED|ERROR)\s+(\S+)/, (m) => [m[1] !== 'PASSED', m[2].split('::').pop()]],
];

function testStatuses(output) {
  const failed = new Map();
  for (const line of output.split(/\r?\n/)) {
    for (const [re, read] of STATUS_LINES) {
      const m = line.match(re);
      if (!m) continue;
      const [fail, name] = read(m);
      failed.set(name, fail || failed.get(name) === true);
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
  const statuses = testStatuses(result.output);
  if (statuses.size === 0) return names.some((nm) => nm && result.output.includes(nm)) ? { ok: true, heuristic: true } : { ...missing, heuristic: true };
  if (names.some((nm) => statuses.get(nm) === true)) return { ok: true };
  const passing = names.filter((nm) => statuses.get(nm) === false);
  if (passing.length) return { ok: false, reason: `The runner reports ${passing.join(', ')} as passing, so it is not evidence of a failing test.` };
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
export async function testImmutability(cwd, baseline, globs = DEFAULT_TEST_GLOBS) {
  const lines = async (args) => (await runGit(args, { cwd })).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const paths = [...await lines(['diff', '--name-only', '--no-renames', baseline]), ...await lines(['ls-files', '--others', '--exclude-standard'])];
  const res = globs.map(globRe);
  const changed = [...new Set(paths)].filter((p) => res.some((re) => re.test(p))).sort();
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
