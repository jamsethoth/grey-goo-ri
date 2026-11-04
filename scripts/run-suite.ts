// The one command Codex may run outside its sandbox (ADR 0010). It takes a stage from a closed set (ADR 0016) and drops
// every environment variable that could make node load other code.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const USAGE = `usage: node scripts/run-suite.ts [fast [boundary ...]]
       node scripts/run-suite.ts check
       node scripts/run-suite.ts coverage [update]
  no arguments: the full suite
  fast: test/unit/, plus test/contract/<boundary>/ for each boundary named
  check: the format check, lint and the type check, no tests
  coverage: test/unit/ with line and function coverage of lib/, held to coverage-baseline.json; update records a rise`;
// ADR 0018: each runs as node plus the package's own bin script, never through a shell or an npm .cmd shim. The format
// check runs first, so lint judges formatted code.
const CHECKS = [
  ['node_modules/prettier/bin/prettier.cjs', '--check', '.'],
  ['node_modules/eslint/bin/eslint.js', '.'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
];
const UNIT = 'test/unit/**/*.test.{mjs,ts}';
export const LCOV = 'coverage/lcov.info';
export const BASELINE = 'coverage-baseline.json';
// test/unit/ may not reach the process boundaries (test/unit/layout.test.mjs), so their lines are not unit-testable;
// lib/process-tree.ts and lib/containment.ts are reached only through lib/exec.ts. Their contract suites cover them;
// their decisions are in lib/command-cleanup.ts, which is measured.
const NOT_UNIT = ['lib/exec.ts', 'lib/git.ts', 'lib/process-tree.ts', 'lib/containment.ts'];

// Its message is the whole usage text. lib/options.ts has its own UsageError, which this launcher does not load: it
// loads only node: built-ins (ADR 0010, ADR 0016).
export class SuiteUsageError extends Error {
  constructor() {
    super(USAGE);
    this.name = 'SuiteUsageError';
  }
}

// What the launcher runs: node, in the repository root, with this environment, once per step in order. `coverage` is
// set for the coverage stage, and says whether a rise is recorded or refused.
export interface SuiteCommand {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  steps: string[][];
  coverage?: 'check' | 'update';
}

// No arguments is the full stage. `fast` is test/unit/ plus the named contract suites, whose paths are built from the
// directory names on disk, never from the argument text. `check` runs no tests, so it gives null.
function stage(argv: string[]): string[] | null {
  if (argv.length === 0) return [];
  if (argv[0] === 'check') {
    if (argv.length > 1) throw new SuiteUsageError();
    return null;
  }
  if (argv[0] !== 'fast') throw new SuiteUsageError();
  const boundaries = readdirSync(join(root, 'test', 'contract'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return [
    UNIT,
    ...argv.slice(1).map((arg) => {
      const name = boundaries.find((boundary) => boundary === arg);
      if (!name) throw new SuiteUsageError();
      return `test/contract/${name}/**/*.test.{mjs,ts}`;
    }),
  ];
}

export function suiteCommand(env: Record<string, string | undefined>, argv: string[]): SuiteCommand {
  const kept = Object.entries(env).filter(([key]) => {
    const upper = key.toUpperCase(); // Windows environment keys are case-insensitive
    return upper !== 'NODE_OPTIONS' && upper !== 'NODE_PATH' && !upper.startsWith('NPM_CONFIG_');
  });
  // Saturating the machine slows every test: on a 20-core machine the suite took 680 s at 2 files at once, 440 s at 4,
  // 345 s at 8 and 339 s at 12 (grey-goo-ri issue #143), against 652 s at the default 19 (grey-goo-ri PR #141). Small
  // CI runners keep their default of one fewer than their cores.
  const concurrency = Math.min(12, Math.max(1, availableParallelism() - 1));
  const base = { command: process.execPath, cwd: root, env: Object.fromEntries(kept) };
  // The check job and the suite stages already run CHECKS, so the coverage stage runs only the measured tests.
  if (argv[0] === 'coverage') {
    if (argv.length > 2 || (argv.length === 2 && argv[1] !== 'update')) throw new SuiteUsageError();
    const test = ['--test', `--test-concurrency=${concurrency}`, '--experimental-test-coverage'];
    // include-all counts a module no test loads, so a new untested file lowers the figures instead of hiding.
    const scope = ['--test-coverage-include-all', '--test-coverage-include=lib/**'];
    const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov'];
    const steps = [
      [
        ...test,
        ...scope,
        ...NOT_UNIT.map((path) => `--test-coverage-exclude=${path}`),
        ...reporters,
        `--test-reporter-destination=${LCOV}`,
        UNIT,
      ],
    ];
    return { ...base, steps, coverage: argv[1] === 'update' ? 'update' : 'check' };
  }
  const files = stage(argv);
  const steps = files ? [...CHECKS, ['--test', `--test-concurrency=${concurrency}`, ...files]] : CHECKS;
  return { ...base, steps };
}

// The summed line and function totals of an lcov report as percentages, floored to two places. Branches are left out:
// node merges each test process's V8 branch ranges, so the branches found in one file move by one or two between runs
// of the same tree.
export function coverageTotals(lcov: string): Record<'lines' | 'functions', number> {
  const sum = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
  for (const [, key, count] of lcov.matchAll(/^(LF|LH|FNF|FNH):(\d+)\r?$/gm))
    sum[key as keyof typeof sum] += Number(count);
  const percent = (hit: number, found: number) => (found ? Math.floor((10000 * hit) / found) / 100 : 100);
  return { lines: percent(sum.LH, sum.LF), functions: percent(sum.FNH, sum.FNF) };
}

// The ratchet: each figure that fell below the recorded one, and each that rose above it. A missing record rose.
export function compareCoverage(
  recorded: Record<string, number> | undefined,
  current: Record<string, number>,
): { fell: string[]; rose: string[] } {
  const fell: string[] = [];
  const rose: string[] = [];
  for (const [metric, now] of Object.entries(current)) {
    const was = recorded?.[metric];
    if (was === undefined || now > was) rose.push(`${metric} ${was ?? 'unrecorded'} -> ${now}`);
    else if (now < was) fell.push(`${metric} ${was} -> ${now}`);
  }
  return { fell, rose };
}

// Coverage differs by platform (win32 and POSIX branches), so each platform keeps its own figures.
function ratchet(mode: 'check' | 'update'): number {
  const path = join(root, BASELINE);
  const baseline = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const current = coverageTotals(readFileSync(join(root, LCOV), 'utf8'));
  const { fell, rose } = compareCoverage(baseline[process.platform], current);
  const figures = `${process.platform}: ${JSON.stringify(current)}`;
  if (fell.length) {
    console.error(
      `coverage fell (${fell.join(', ')}). Add unit tests; ${BASELINE} is lowered only by hand, in review.`,
    );
    return 1;
  }
  if (!rose.length) {
    console.log(`coverage held at ${figures}`);
    return 0;
  }
  if (mode === 'update') {
    writeFileSync(path, `${JSON.stringify({ ...baseline, [process.platform]: current }, null, 2)}\n`);
    console.log(`coverage rose (${rose.join(', ')}); ${BASELINE} now records ${figures}`);
    return 0;
  }
  console.error(
    `coverage rose (${rose.join(', ')}). Record it: node scripts/run-suite.ts coverage update, ` +
      `or set ${figures} in ${BASELINE}.`,
  );
  return 1;
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] && resolve(process.argv[1]);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  let suite: SuiteCommand;
  try {
    suite = suiteCommand(process.env, process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof SuiteUsageError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
  const missing = CHECKS.map(([script]) => script).filter((script) => !existsSync(join(root, script)));
  if (missing.length && !suite.coverage) {
    console.error(`${missing.join(' and ')} not found: run npm ci first`);
    process.exit(1);
  }
  // node's lcov reporter does not create its destination's directory.
  if (suite.coverage) mkdirSync(join(root, dirname(LCOV)), { recursive: true });
  // Steps run in order and the first failure stops the stage, so a format, lint or type error is the last thing
  // printed.
  for (const args of suite.steps) {
    const code = await new Promise<number | null>((done) => {
      const child = spawn(suite.command, args, { cwd: suite.cwd, env: suite.env, stdio: 'inherit', shell: false });
      child.on('error', (err) => {
        console.error(err.message);
        done(1);
      });
      child.on('exit', (exitCode, signal) => done(signal ? 1 : exitCode));
    });
    if (code !== 0) process.exit(code);
  }
  if (suite.coverage) process.exit(ratchet(suite.coverage));
}
