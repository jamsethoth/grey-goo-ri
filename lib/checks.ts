import * as config from './config.ts';
import type * as exec from './exec.ts';
import * as procedures from './procedures.ts';
import * as referencePaths from './reference-paths.ts';

// A test's status in a runner's output: failed, passed, or the TODO or SKIP directive that excuses it.
type TestStatus = boolean | string;
// Per-test status lines: node:test spec, TAP, jest, pytest. Each match yields [failed, ...names].
// A TAP description escapes `#` and `\`; an unescaped `#` starts a directive, and TODO or SKIP results do not
// decide the run's exit code, so they are recorded as the directive word instead of a failed flag.
const STATUS_LINES: [RegExp, (match: RegExpMatchArray) => [TestStatus, ...string[]]][] = [
  [/^\s*([✖✔])\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/, (match) => [match[1] === '✖', match[2]]],
  [
    /^\s*(not )?ok(?:\s+\d+)?(?:\s+-)?\s+((?:\\.|[^\\#])+?)\s*(?:#\s*(.*))?$/,
    (match) => [
      match[3]?.match(/^(todo|skip)\b/i)?.[1].toUpperCase() ?? Boolean(match[1]),
      match[2].replace(/\\(.)/g, '$1'),
    ],
  ],
  [/^\s*([✕✓])\s+(.+?)(?:\s+\(\d+ m?s\))?\s*$/, (match) => [match[1] === '✕', match[2]]],
  // Jest's default reporter prints no per-test lines for several files, only a `● suite › test` heading per failure.
  // Only the whole diagnostic headings are excluded, so a suite named `Console` keeps its failures.
  [
    /^\s*●\s+(?!(?:Console|Test suite failed to run)\s*$)(.+?)\s*$/,
    (match) => [true, match[1], match[1].split(' › ').pop() as string],
  ],
  [
    /^(FAILED|PASSED|ERROR)\s+(\S+)/,
    (match) => [match[1] !== 'PASSED', match[2], match[2].split('::').pop() as string],
  ],
];

// Colour and cursor escapes, which runners emit when FORCE_COLOR is set.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function testStatuses(output: string) {
  const failed = new Map<string, TestStatus>();
  for (const line of output.split(/\r?\n/)) {
    for (const [pattern, statusOf] of STATUS_LINES) {
      const match = line.match(pattern);
      if (!match) continue;
      const [fail, ...names] = statusOf(match);
      // Duplicate names are legal: a genuine failure is never overwritten by a later TODO, SKIP or pass.
      for (const name of names) failed.set(name, failed.get(name) === true || fail);
      break;
    }
  }
  return failed;
}

// A command's run as exec.runShell reports it, as far as a Check reads it.
export type ShellRun = Pick<exec.ShellResult, 'code' | 'output'> &
  Partial<Pick<exec.ShellResult, 'cleanup'>> & { timedOut?: boolean };

// A Red Check's result: on a failure an agent can fix, `failure` says which (T4c, N5).
export interface RedCheck {
  ok: boolean;
  failure?: 'passed' | 'missing';
  reason?: string;
  foundByNameOnly?: boolean;
}

// The Red Check where the runner reports per test: a named test failing, passing, or excused.
function fromStatuses(statuses: Map<string, TestStatus>, names: string[], missing: RedCheck): RedCheck {
  if (names.some((name) => statuses.get(name) === true)) return { ok: true };
  const passing = names.filter((name) => statuses.get(name) === false);
  if (passing.length)
    return {
      ok: false,
      failure: 'passed',
      reason: `The runner reports ${passing.join(', ')} as passing, so it is not evidence of a failing test.`,
    };
  const excused = names.filter((name) => typeof statuses.get(name) === 'string');
  if (excused.length)
    return {
      ok: false,
      reason: `The runner marks ${excused.join(', ')} as TODO or SKIP, so its result does not count as a failing test.`,
    };
  return missing;
}

// A red run counts only if the runner exited nonzero on its own and a reported test is failing in its output. A
// failure an agent can fix carries its `failure`: `passed` when the named tests passed, `missing` when the output does
// not name them (T4c, N5).
export function redCheck(result: ShellRun, names: string[]): RedCheck {
  if (result.timedOut)
    return { ok: false, reason: 'The red test run timed out, so it is not evidence of failing tests.' };
  if (result.code === null || result.code === 127)
    return {
      ok: false,
      reason:
        'The test runner could not start or crashed (command not found or no exit code), ' +
        'so it is not evidence of failing tests.',
    };
  if (result.code === 0)
    return { ok: false, failure: 'passed', reason: 'The new tests did not fail before implementation.' };
  const missing: RedCheck = {
    ok: false,
    failure: 'missing',
    reason: `The test output does not mention any reported failing test (${names.join(', ') || 'none reported'}).`,
  };
  const output = result.output.replace(ANSI, '');
  const statuses = testStatuses(output);
  if (statuses.size === 0)
    return names.some((name) => name && output.includes(name))
      ? { ok: true, foundByNameOnly: true }
      : { ...missing, foundByNameOnly: true };
  return fromStatuses(statuses, names, missing);
}

type RunShell = (command: string, options: { cwd: string; timeoutMs: number }) => Promise<ShellRun>;

export async function greenCheck(
  command: string,
  cwd: string,
  { runShell, timeoutMs = 30 * 60_000 }: { runShell: RunShell; timeoutMs?: number },
) {
  const startedMs = Date.now();
  const run = await runShell(command, { cwd, timeoutMs });
  return {
    passed: run.code === 0 && !run.timedOut,
    code: run.code,
    output: run.output,
    timedOut: Boolean(run.timedOut),
    durationMs: Date.now() - startedMs,
    cleanup: run.cleanup,
  };
}

// Evidence stays raw for agent Briefs and is redacted where it is published. Its storage cut keeps whole lines only: a
// partial first line could start inside a local path, where redaction no longer recognises it.
const EVIDENCE_LIMIT = 65_536;
export function checkEvidence(command: string, result: { output?: unknown }) {
  const output = String(result.output ?? '');
  const cut = output.length - EVIDENCE_LIMIT;
  if (cut <= 0) return { command, output };
  const newline = output.indexOf('\n', cut - 1);
  const kept = newline >= 0 ? output.slice(newline + 1) : '';
  return { command, output: kept || `[${output.length} characters of output omitted]` };
}

function globPart(part: string) {
  if (part === '**/') return '(?:.*/)?';
  if (part === '**') return '.*';
  if (part === '*') return '[^/]*';
  return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
const globRe = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map(globPart)
      .join('')}${glob.includes('*') ? '' : '(?:/.*)?'}$`,
    's',
  );
const foldAscii = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// Whether a path is a test under the repository's testPaths globs: the one rule Test Immutability and diffStats share.
// It reads a glob preflight accepts as the :(glob,icase) pathspecs that list a rollback's untracked tests do: ASCII
// case only is folded, and a glob without a wildcard also matches what is under it.
export const testPathMatcher = (globs: string[]) => {
  const patterns = globs.map((glob) => globRe(foldAscii(glob)));
  return (path: string) => patterns.some((pattern) => pattern.test(foldAscii(path)));
};

// Committed tests must be byte-identical to the baseline; renames count as both a removed and an added path.
// Ignored untracked files count too, listed one by one since a runner can still pick them up; installed
// dependencies are excluded because their own tests are not the repo's.
const DEPENDENCY_DIRS = ['**/node_modules/**', '**/site-packages/**'];

// The same test paths, for listing the untracked ones a rollback must restore.
export const testPathSet = (globs: string[]) => ({ globs, exclude: DEPENDENCY_DIRS });

// The git verbs Test Immutability reads (lib/git.ts).
export interface ChangedPaths {
  changedSince(cwd: string, baseline: string): Promise<string[]>;
  untrackedPaths(cwd: string, options?: { include: 'ignored'; within: { exclude: string[] } }): Promise<string[]>;
}

export async function testImmutability(
  cwd: string,
  baseline: string,
  { globs, git }: { globs: string[]; git: ChangedPaths },
) {
  const all = [
    ...(await git.changedSince(cwd, baseline)),
    ...(await git.untrackedPaths(cwd)),
    ...(await git.untrackedPaths(cwd, { include: 'ignored', within: { exclude: DEPENDENCY_DIRS } })),
  ];
  const isTest = testPathMatcher(globs);
  const changed = [...new Set(all)].filter(isTest).sort();
  return { ok: changed.length === 0, changed };
}

const normalise = (text: unknown) =>
  String(text ?? '')
    .replace(/:\d+|\bline\s+\d+|\bL\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

// The `repeat` Check's fingerprint of a list (R4c): each item's fields with whitespace and line numbers stripped, in
// any order.
export const findingsHash = (findings: Record<string, unknown>[], fields = ['file', 'severity', 'issue']) =>
  config.sha256(
    findings
      .map((finding) => fields.map((field) => normalise(finding[field])).join('|'))
      .sort()
      .join('\n'),
  );

// A `response` Check's condition (R4a, P5d): all of several, a field's value, or how many items of a list match
// `where`, as none, any, all or a count compared by one operator.
export interface ResponseCondition extends Partial<Record<procedures.Operator, number>> {
  allOf?: ResponseCondition[];
  field?: string;
  is?: unknown;
  none?: string;
  any?: string;
  all?: string;
  count?: string;
  where?: Record<string, unknown>;
}
const QUANTIFIERS = { none: (count: number) => count === 0, any: (count: number) => count > 0 };

// A quantified condition's reasons: how many items matched `where`, against what was expected.
function quantifierFailures(response: unknown, condition: ResponseCondition) {
  const [form] = (['none', 'any', 'all', 'count'] as const).filter((key) => Object.hasOwn(condition, key));
  const items = (referencePaths.read(response, condition[form]) ?? []) as Record<string, unknown>[];
  const where = Object.entries(condition.where ?? {});
  const matching = items.filter((item) => where.every(([field, value]) => [value].flat().includes(item[field]))).length;
  const operator = procedures.OPERATORS.find((key) => Object.hasOwn(condition, key));
  // The validator rejects a count with no comparison; one that slips through fails rather than throws.
  if (form === 'count' && !operator) return [`the count of ${condition.count} names no comparison`];
  let held;
  if (form === 'all') held = matching === items.length;
  else if (form === 'count')
    held = procedures.COMPARISONS[operator as procedures.Operator](
      matching,
      condition[operator as procedures.Operator] as number,
    );
  else held = QUANTIFIERS[form as 'none' | 'any'](matching);
  const expected =
    form === 'count'
      ? `${operator} ${condition[operator as procedures.Operator]}`
      : { none: 'none', any: 'at least one', all: 'all' }[form];
  const described = where.length
    ? ` where ${where.map(([field, value]) => `${field} is ${[value].flat().join(' or ')}`).join(' and ')}`
    : '';
  return held ? [] : [`${condition[form]} has ${matching} of ${items.length} items${described}; expected ${expected}`];
}

// One condition of a `response` Check (R4a, P5d): the reasons it fails, empty when it holds.
function failures(response: unknown, condition: ResponseCondition): string[] {
  if (condition.allOf) return condition.allOf.flatMap((each) => failures(response, each));
  if (Object.hasOwn(condition, 'field')) {
    const value = referencePaths.read(response, condition.field);
    return value === condition.is
      ? []
      : [`${condition.field} is ${JSON.stringify(value)}, expected ${JSON.stringify(condition.is)}`];
  }
  return quantifierFailures(response, condition);
}

export function responseCheck(response: unknown, condition: ResponseCondition) {
  const reasons = failures(response, condition);
  return { passed: reasons.length === 0, reasons };
}
