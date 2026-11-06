import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));

// What makes a test medium (docs/testing.md, "Test sizes"), as it shows in a test file's source.
// shortcut: a text check misses a bare `sh(` or an unlisted spawning helper; a runtime guard if the fast stage slows
// (docs/testing.md, "Considered and deferred").
const MEDIUM: [RegExp, string][] = [
  [/['"](?:node:)?child_process['"]/, 'imports node:child_process'],
  [/['"](?:\.\.\/)+lib\/(?:exec|git)\.ts['"]/, 'imports lib/exec.ts or lib/git.ts'],
  [/\b(?:git|integrity):\s*['"]real['"]/, 'asks for real git'],
  [/\bset(?:Timeout|Interval)\s*\(|['"]node:timers/, 'uses a timer'],
  [
    /\b(?:golden|run|support|gitShell)\.sh\(|\b(?:holdLock|conflict|seedRepos|timeOutWhen|timedOutOrphan)\(/,
    'calls a support helper that spawns',
  ],
  [/\b(?:committingRepo|emptyWorktree|twoWorktrees)\(/, 'calls a support helper that spawns'],
];
// This file is left out: its samples below spell every marker, and it only reads files.
const unitFiles = readdirSync(new URL('./', import.meta.url), { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file.endsWith('.test.ts') && file !== 'layout.test.ts');

const marked = [
  ["import { spawn } from 'node:child_process';", 'imports node:child_process'],
  ["import * as git from '../../lib/git.ts';", 'imports lib/exec.ts or lib/git.ts'],
  ["await golden.setup(t, { git: 'real' })", 'asks for real git'],
  ["fixture(t, { integrity: 'real' })", 'asks for real git'],
  ['await new Promise((r) => setTimeout(r, 5))', 'uses a timer'],
  ["import { setTimeout as sleep } from 'node:timers/promises';", 'uses a timer'],
  ['golden.sh(g.worktree, "log")', 'calls a support helper that spawns'],
  ['run.holdLock(t, f.commonDir, "repo")', 'calls a support helper that spawns'],
  ['committingRepo.committingRepo(t)', 'calls a support helper that spawns'],
  ['worktrees.emptyWorktree(t)', 'calls a support helper that spawns'],
  ['worktrees.twoWorktrees(t)', 'calls a support helper that spawns'],
];
for (const [text, what] of marked) {
  test(`the size check flags a unit file that ${what}: ${text}`, () => {
    assert.deepEqual(
      MEDIUM.filter(([re]) => re.test(text)).map(([, flagged]) => flagged),
      [what],
    );
  });
}

for (const file of unitFiles) {
  test(`test/unit/${file} spawns no process, uses no real git and sets no timer`, () => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.deepEqual(
      MEDIUM.filter(([re]) => re.test(text)).map(([, what]) => what),
      [],
    );
  });
}
// Tools write under these, in a checkout's ignored or untracked files: none of it is gg's code.
const SKIPPED = new Set(['.git', 'node_modules', '.claude', 'coverage']);
function repoFiles(directory = ''): string[] {
  return readdirSync(root + directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + entry.name;
    if (SKIPPED.has(entry.name)) return [];
    return entry.isDirectory() ? repoFiles(`${path}/`) : [path];
  });
}
// Every module under lib, so a new one is scanned without joining a list (grey-goo-ri issue #219).
const modules = repoFiles('lib/').filter((path) => path.endsWith('.ts'));
const codeFiles = ['lib/', 'bin/', 'scripts/', 'test/']
  .flatMap((directory) => repoFiles(directory))
  .filter((path) => path.endsWith('.ts'));

// The paths the AGENTS.md layout table names; a row ending in / covers the files under it.
const layoutRows = (agents: string) => {
  const section = /^## Layout$([\s\S]*?)^## /m.exec(agents)?.[1] ?? '';
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
};
const unlistedFiles = (files: string[], rows: string[]) =>
  files.filter((path) => !rows.some((row) => row === path || (row.endsWith('/') && path.startsWith(row))));

test('every module under lib imports', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^## Layout$/m);
  assert.match(agents, /^## Tests$/m);
  assert.doesNotMatch(agents, /The layout section here grows with the code/);
  for (const path of modules) {
    const mod = await import(pathToFileURL(root + path).href);
    assert.equal(typeof mod, 'object', path);
  }
});

test('every file under lib is scanned', () => {
  const libFiles = repoFiles('lib/');
  for (const path of ['lib/validate/index.ts', 'lib/refs.ts', 'lib/harnesses/shipped.ts']) {
    assert.ok(modules.includes(path), `${path} is scanned`);
  }
  // Templates and the job-object script are not modules: they import nothing and run no git.
  assert.deepEqual(
    libFiles.filter((path) => !modules.includes(path) && !/\.(?:md|ps1)$/.test(path)),
    [],
  );
});

// A code file is named in lowercase words joined by hyphens, with a dot only before an area or test suffix
// (`run.branches.test.ts`), and never a grab-bag name that says nothing of its job (Angular's style guide).
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.ts$/;
const GRAB_BAG = /^(?:utils?|helpers?|common|misc|shared)\./;
const misnamed = (files: string[]) =>
  files.filter((path) => {
    const name = path.split('/').at(-1) ?? '';
    return !FILE_NAME.test(name) || GRAB_BAG.test(name);
  });

test('every code file is named in lowercase hyphenated words for its job', () => {
  const samples = ['lib/process-tree.ts', 'test/unit/run.branches.test.ts', 'lib/processTree.ts', 'lib/write_ahead.ts'];
  assert.deepEqual(misnamed([...samples, 'lib/utils.ts']), [
    'lib/processTree.ts',
    'lib/write_ahead.ts',
    'lib/utils.ts',
  ]);
  assert.ok(codeFiles.includes('lib/process-tree.ts') && codeFiles.includes('bin/gg.ts'), 'the code files are read');
  assert.deepEqual(
    misnamed(codeFiles),
    [],
    'rename the file: lowercase words joined by hyphens, named for what it does',
  );
});

test('every file under lib has a row in AGENTS.md', async () => {
  const sampleRows = ['lib/a.ts', 'lib/templates/'];
  assert.deepEqual(unlistedFiles(['lib/a.ts', 'lib/templates/t.md', 'lib/b.ts'], sampleRows), ['lib/b.ts']);
  const rows = layoutRows(await readFile(`${root}AGENTS.md`, 'utf8'));
  assert.ok(rows.includes('lib/validate/') && rows.includes('bin/gg.ts'), 'the layout table is read');
  assert.deepEqual(unlistedFiles(repoFiles('lib/'), rows), [], 'add a row to the AGENTS.md layout table');
  assert.deepEqual(
    rows.filter((path) => !existsSync(root + path)),
    [],
    'a layout row names a file that exists',
  );
});

// A helper is found by what it does, so no test/support file is named for the lib module it serves (#256's N45).
const sharingLibNames = (supportFiles: string[], libModules: string[]) => {
  const stem = (path: string) => path.replace(/^.*\//, '').replace(/\.ts$/, '');
  const libNames = new Set(libModules.map(stem));
  return supportFiles.filter((path) => libNames.has(stem(path)));
};

test('no test/support file shares a lib module name', () => {
  assert.deepEqual(
    sharingLibNames(['test/support/run.ts', 'test/support/run-fixture.ts'], ['lib/run.ts', 'lib/flow.ts']),
    ['test/support/run.ts'],
  );
  const supportFiles = repoFiles('test/support/');
  assert.ok(supportFiles.includes('test/support/execution-context.ts'), 'the support files are read');
  assert.deepEqual(sharingLibNames(supportFiles, modules), [], 'name the helper for its job, not its lib module');
});

// lib/git.ts is the one git interface (grey-goo-ri issue #144): every other module calls its verbs with gg's values.
test('no module outside lib/git.ts passes git a command line', async () => {
  const git = await import(pathToFileURL(`${root}lib/git.ts`).href);
  assert.equal(git.runGit, undefined, 'runGit is not exported');
  const raw: [RegExp, string][] = [
    [/\brunGit\b/, 'runGit'],
    [/\b(?:run|spawn|spawnSync|execFile|execFileSync)\(\s*['"`]git['"`]/, 'a spawned git'],
    [/\^\{|\.\.\.HEAD|refs\/heads\/|['"`]HEAD['"`]/, 'git ref syntax'],
    [/['"`]:\([a-z,]+\)/, 'a git pathspec'],
    // bin/gg.ts passes lib/git.ts in; a module that imported it could fall back to it instead of the git it was given.
    [/from ['"`]\.\/git\.ts['"`]/, 'an import of lib/git.ts'],
  ];
  for (const path of [...modules.filter((path) => path !== 'lib/git.ts'), 'bin/gg.ts', 'scripts/run-suite.ts']) {
    const text = await readFile(root + path, 'utf8');
    for (const [re, what] of raw) assert.doesNotMatch(text, re, `${path} builds ${what}`);
  }
});

// Every file gg runs from, except lib/harnesses/, the one place a Harness is named.
const filesOutsideHarnesses = [...repoFiles('lib/'), ...repoFiles('bin/')].filter(
  (path) => !path.startsWith('lib/harnesses/'),
);
const HARNESS_NAMES = /claude|codex|CLAUDE\.md|\.codex/i;

test('no module outside lib/harnesses names a Harness', () => {
  assert.ok(
    filesOutsideHarnesses.includes('lib/interpreter.ts') && filesOutsideHarnesses.includes('bin/gg.ts'),
    `scanned ${filesOutsideHarnesses.join(', ')}`,
  );
  const named = filesOutsideHarnesses.flatMap((path) =>
    readFileSync(root + path, 'utf8')
      .split('\n')
      .flatMap((line, i) => (HARNESS_NAMES.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(named, []);
});

// Every code file, each of it TypeScript (ADR 0018). A new file joins this list.
const CONVERTED = [
  'bin/gg.ts',
  'lib/admission.ts',
  'lib/agent-action.ts',
  'lib/agent-call.ts',
  'lib/approval.ts',
  'lib/bounds.ts',
  'lib/briefs.ts',
  'lib/check-action.ts',
  'lib/checks.ts',
  'lib/command-cleanup.ts',
  'lib/config.ts',
  'lib/containment.ts',
  'lib/doctor.ts',
  'lib/effect-actions.ts',
  'lib/effect-errors.ts',
  'lib/effect-evidence.ts',
  'lib/effects.ts',
  'lib/events.ts',
  'lib/exec.ts',
  'lib/flow.ts',
  'lib/git.ts',
  'lib/github.ts',
  'lib/harnesses/claude.ts',
  'lib/harnesses/codex.ts',
  'lib/harnesses/contract.ts',
  'lib/harnesses/shipped.ts',
  'lib/integrity.ts',
  'lib/interpreter.ts',
  'lib/labels.ts',
  'lib/locks.ts',
  'lib/marker.ts',
  'lib/options.ts',
  'lib/outcome.ts',
  'lib/paths.ts',
  'lib/plan.ts',
  'lib/procedures.ts',
  'lib/process-tree.ts',
  'lib/public-text.ts',
  'lib/publish.ts',
  'lib/reconcile.ts',
  'lib/record.ts',
  'lib/refs.ts',
  'lib/remote-effects.ts',
  'lib/render.ts',
  'lib/rule-domain.ts',
  'lib/rules.ts',
  'lib/run-context.ts',
  'lib/run.ts',
  'lib/sqlite.ts',
  'lib/stats.ts',
  'lib/terminal-report.ts',
  'lib/terminal.ts',
  'lib/ticket-worktree.ts',
  'lib/trace.ts',
  'lib/validate/actions.ts',
  'lib/validate/conditions.ts',
  'lib/validate/flows.ts',
  'lib/validate/graph.ts',
  'lib/validate/index.ts',
  'lib/validate/inputs.ts',
  'lib/validate/procedures.ts',
  'lib/validate/references.ts',
  'lib/validate/report.ts',
  'lib/validate/templates.ts',
  'lib/visit-runner.ts',
  'lib/visit-scope.ts',
  'lib/visit.ts',
  'lib/work.ts',
  'lib/write-ahead.ts',
  'scripts/run-suite.ts',
  'test/contract/exec/containment.test.ts',
  'test/contract/exec/exec.job.test.ts',
  'test/contract/exec/exec.test.ts',
  'test/contract/exec/exec.timeout.test.ts',
  'test/contract/git/git.test.ts',
  'test/contract/git/template-repos.test.ts',
  'test/contract/harness/harnesses.test.ts',
  'test/contract/integrity/integrity.test.ts',
  'test/contract/sqlite/events.test.ts',
  'test/contract/sqlite/integrity.test.ts',
  'test/contract/sqlite/locks.test.ts',
  'test/contract/sqlite/record.test.ts',
  'test/e2e/checks.test.ts',
  'test/e2e/gg.test.ts',
  'test/e2e/integrity.test.ts',
  'test/e2e/interpreter.faults.test.ts',
  'test/e2e/interpreter.fix.test.ts',
  'test/e2e/interpreter.retry.test.ts',
  'test/e2e/interpreter.test.ts',
  'test/e2e/interpreter.visit.test.ts',
  'test/e2e/interpreter.write-ahead.test.ts',
  'test/e2e/reconcile.crash.test.ts',
  'test/e2e/reconcile.holds.test.ts',
  'test/e2e/reconcile.replay.test.ts',
  'test/e2e/reconcile.test.ts',
  'test/e2e/run-suite.test.ts',
  'test/e2e/run.admission.test.ts',
  'test/e2e/run.branch-names.test.ts',
  'test/e2e/run.branches.test.ts',
  'test/e2e/run.concurrency.test.ts',
  'test/e2e/run.recovery.test.ts',
  'test/e2e/run.redaction.test.ts',
  'test/e2e/run.resume.test.ts',
  'test/support/action-marker-parts.ts',
  'test/support/action-signals.ts',
  'test/support/add-suite.ts',
  'test/support/admission-hold-events.ts',
  'test/support/after-phase.ts',
  'test/support/backoff-run-stop.ts',
  'test/support/case-database.ts',
  'test/support/case-env.ts',
  'test/support/child-exit.ts',
  'test/support/child-scripts.ts',
  'test/support/child-scripts/breakaway-child.ts',
  'test/support/child-scripts/child-starter.ts',
  'test/support/child-scripts/detached-child.ts',
  'test/support/child-scripts/forged-job-notes.ts',
  'test/support/child-scripts/long-lived.ts',
  'test/support/child-scripts/orphan-middle.ts',
  'test/support/child-scripts/prints-line.ts',
  'test/support/child-scripts/shell-caller.ts',
  'test/support/child-scripts/slow-taskkill.ts',
  'test/support/child-scripts/split-character.ts',
  'test/support/child-scripts/stdin-eof.ts',
  'test/support/child-scripts/waits-for-file.ts',
  'test/support/committing-repo.ts',
  'test/support/crash-fs.ts',
  'test/support/crash-resume.ts',
  'test/support/epic-run.ts',
  'test/support/event-appender.ts',
  'test/support/example-layer.ts',
  'test/support/execution-context.ts',
  'test/support/execution-reads.ts',
  'test/support/failing-git.ts',
  'test/support/fake-gh.ts',
  'test/support/fake-git-paths.ts',
  'test/support/fake-git-store.ts',
  'test/support/fake-git.ts',
  'test/support/fake-harness.ts',
  'test/support/fake-integrity.ts',
  'test/support/first-visit.ts',
  'test/support/git-shell.ts',
  'test/support/golden-run.ts',
  'test/support/golden.ts',
  'test/support/harness-runs.ts',
  'test/support/integrity-worktrees.ts',
  'test/support/kernel32-doubles.ts',
  'test/support/keys.ts',
  'test/support/latch.ts',
  'test/support/lock-contender.ts',
  'test/support/lock-holder.ts',
  'test/support/lock-stress.ts',
  'test/support/manual-timers.ts',
  'test/support/procedure-actions.ts',
  'test/support/process-probe.ts',
  'test/support/record-saver.ts',
  'test/support/remote-failures.ts',
  'test/support/repo-lock-contention.ts',
  'test/support/repo-lock-writer.ts',
  'test/support/request-tables.ts',
  'test/support/reset-interruption.ts',
  'test/support/review-flow.ts',
  'test/support/run-fixture.ts',
  'test/support/shell-case-options.ts',
  'test/support/state-database-open-stress.ts',
  'test/support/state-database-opener.ts',
  'test/support/suite-runs.ts',
  'test/support/temp-directory.ts',
  'test/support/template-repos.ts',
  'test/support/timed-out-shell.ts',
  'test/support/unvisited-execution.ts',
  'test/support/write-lock-holder.ts',
  'test/unit/approval.test.ts',
  'test/unit/briefs.test.ts',
  'test/unit/checks.test.ts',
  'test/unit/child-exit.test.ts',
  'test/unit/command-cleanup.test.ts',
  'test/unit/config.test.ts',
  'test/unit/defaults.test.ts',
  'test/unit/doctor.test.ts',
  'test/unit/effect-errors.test.ts',
  'test/unit/effects.test.ts',
  'test/unit/events.test.ts',
  'test/unit/fake-harness.test.ts',
  'test/unit/flow.test.ts',
  'test/unit/github.test.ts',
  'test/unit/integrity.test.ts',
  'test/unit/interpreter.backoff.test.ts',
  'test/unit/interpreter.bounds.test.ts',
  'test/unit/interpreter.checks.test.ts',
  'test/unit/interpreter.faults.test.ts',
  'test/unit/interpreter.fix.test.ts',
  'test/unit/interpreter.inputs.test.ts',
  'test/unit/interpreter.procedures.test.ts',
  'test/unit/interpreter.retry.test.ts',
  'test/unit/interpreter.review.test.ts',
  'test/unit/interpreter.test.ts',
  'test/unit/interpreter.visit.test.ts',
  'test/unit/interpreter.write-ahead.test.ts',
  'test/unit/labels.test.ts',
  'test/unit/layout.test.ts',
  'test/unit/marker.test.ts',
  'test/unit/options.test.ts',
  'test/unit/outcome.test.ts',
  'test/unit/paths.test.ts',
  'test/unit/personas.test.ts',
  'test/unit/procedure-actions.test.ts',
  'test/unit/procedures.test.ts',
  'test/unit/public-text.test.ts',
  'test/unit/reconcile.crash.test.ts',
  'test/unit/reconcile.holds.test.ts',
  'test/unit/reconcile.replay.test.ts',
  'test/unit/reconcile.test.ts',
  'test/unit/record.test.ts',
  'test/unit/refs.test.ts',
  'test/unit/remote-effects.test.ts',
  'test/unit/render.test.ts',
  'test/unit/rules.test.ts',
  'test/unit/run-suite.test.ts',
  'test/unit/run.admission.test.ts',
  'test/unit/run.branches.test.ts',
  'test/unit/run.concurrency.test.ts',
  'test/unit/run.holds.test.ts',
  'test/unit/run.recovery.test.ts',
  'test/unit/run.redaction.test.ts',
  'test/unit/run.resume.test.ts',
  'test/unit/run.test.ts',
  'test/unit/terminal-report.test.ts',
  'test/unit/terminal.test.ts',
  'test/unit/validate.inputs.test.ts',
  'test/unit/validate.routes.test.ts',
  'test/unit/validate.schemas.test.ts',
  'test/unit/validate.templates.test.ts',
  'test/unit/validate.test.ts',
];
// The one JavaScript file: ESLint 10.14 loads a .ts config only through the optional jiti package or an unstable flag.
// Revisit when ESLint loads TypeScript configs natively.
const LEGACY_MJS = ['eslint.config.mjs'];
const unlistedJavaScript = (files: string[]) =>
  files.filter((path) => /\.(?:[cm]?js|[cm]ts)$/.test(path) && !LEGACY_MJS.includes(path));

test('package.json keeps type module', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(pkg.type, 'module');
});

// Node will not strip types under node_modules, so an npm package of gg cannot start until #243 builds one (ADR 0018).
test('package.json is private, so npm refuses to publish gg until it is built for publishing', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(pkg.private, true);
});

// Only the range forms package.json uses: a bound like `<27` or a union has no single major to compare.
const rangeMajor = (range: string) => {
  const match = /^(?:\^|~|>=)(\d+)(?:\.\d+){0,2}$/.exec(range);
  assert.ok(match, `${range} is a ^, ~ or >= range`);
  return match[1];
};

// tsc checks the code against @types/node, so its major must be the Node gg runs on (ADR 0020).
test('the @types/node major in package.json is the engines.node major', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(rangeMajor(pkg.devDependencies['@types/node']), rangeMajor(pkg.engines.node));
});

test('the major check reads ^, ~ and >= ranges and fails on any other', () => {
  assert.deepEqual(['^26.6.6', '~26.6', '>=26.13', '>=26'].map(rangeMajor), ['26', '26', '26', '26']);
  for (const range of ['<27', '*', '26.x || 27.x', '>=26 <28']) {
    assert.throws(() => rangeMajor(range), /a \^, ~ or >= range/, range);
  }
});

test('every module in the converted list is TypeScript', () => {
  for (const path of CONVERTED) {
    assert.ok(existsSync(root + path), `${path} exists`);
  }
});

test('no JavaScript file is left in the code tree', () => {
  const samples = ['lib/new.mjs', 'bin/new.js', 'test/new.cjs', 'test/new.mts', 'test/new.cts'];
  assert.deepEqual(unlistedJavaScript([...LEGACY_MJS, ...samples, 'lib/new.ts']), samples);
  assert.deepEqual(unlistedJavaScript(repoFiles()), [], 'write the file as .ts (ADR 0018)');
  assert.ok(existsSync(root + LEGACY_MJS[0]), 'a converted file leaves LEGACY_MJS');
});

test('the converted list names every code file', () => {
  assert.ok(codeFiles.includes('lib/paths.ts') && codeFiles.includes('bin/gg.ts'), 'the code files are read');
  assert.deepEqual(
    codeFiles.filter((path) => !CONVERTED.includes(path)),
    [],
    'add the file to CONVERTED',
  );
});

// A thrown class's name shows in String(err) and the first line of its stack. Lint checks the class name's suffix
// (below); this checks the name it sets, as a class field or in its constructor. This file is left out: its samples
// spell both.
// shortcut: an uncalled method that sets the name on its own line still passes; parse the class if one ever does.
const errorClassesWithoutName = (text: string) =>
  [...text.matchAll(/\bclass (\w+)(?:<[^>]*>)?\s+extends\s+(?:\w+\.)*\w*Error\b/g)]
    .map((match) => match[1])
    .filter((className) => !new RegExp(`^\\s*(?:this\\.)?name = '${className}';$`, 'm').test(text));

test('every thrown class sets name to its class name', () => {
  assert.deepEqual(errorClassesWithoutName('class CommandError extends Error {}'), ['CommandError']);
  assert.deepEqual(errorClassesWithoutName('class GhError extends exec.CommandError {}'), ['GhError']);
  assert.deepEqual(errorClassesWithoutName("class OtherError extends Error {\n  name = 'CrashError';\n}\n"), [
    'OtherError',
  ]);
  assert.deepEqual(errorClassesWithoutName("class CrashError extends Error {}\n// name = 'CrashError';\n"), [
    'CrashError',
  ]);
  assert.deepEqual(errorClassesWithoutName('class GhError extends Error {}\nconst note = "name = \'GhError\'";\n'), [
    'GhError',
  ]);
  assert.deepEqual(errorClassesWithoutName('class GenericError<T> extends Error {}'), ['GenericError']);
  assert.deepEqual(errorClassesWithoutName('class WrappedError\n  extends Error {}'), ['WrappedError']);
  assert.deepEqual(errorClassesWithoutName("class CrashError extends Error {\n  name = 'CrashError';\n}\n"), []);
  assert.deepEqual(
    errorClassesWithoutName(
      "class UsageError extends Error {\n  constructor() {\n    this.name = 'UsageError';\n  }\n}\n",
    ),
    [],
  );
  assert.deepEqual(errorClassesWithoutName('class Thing extends Base {}'), []);
  assert.deepEqual(
    codeFiles
      .filter((path) => path !== 'test/unit/layout.test.ts')
      .flatMap((path) => errorClassesWithoutName(readFileSync(root + path, 'utf8'))),
    [],
    "set the class's name: name = 'ClassName';",
  );
});

const eslint = new ESLint({ cwd: root });
const lintFindings = async (filePath: string, text: string) => {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.map((message) => message.ruleId);
};

test('the strict rules apply to a JavaScript file too', async () => {
  assert.deepEqual(await lintFindings('scripts/sample.mjs', 'export const cfg = 1;\n'), ['id-denylist']);
});

test('lint denies the name dir', async () => {
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export const dir = 1;\n'), ['id-denylist']);
});

test('lint fails a class extending an error class when its name does not end in Error', async () => {
  const restricted = ['no-restricted-syntax'];
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export class Thing extends Error {}\n'), restricted);
  assert.deepEqual(
    await lintFindings('lib/sample.ts', 'export class Thing extends exec.CommandError {}\n'),
    restricted,
  );
  assert.deepEqual(await lintFindings('test/support/sample.ts', 'export class Thing extends Error {}\n'), restricted);
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export class ThingError extends Error {}\n'), []);
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export class ThingError extends exec.CommandError {}\n'), []);
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export class Thing extends Base {}\n'), []);
});

// The rule keeps each call naming its module (#237). It reads parsed code, so an import a case spells in a string is
// not one.
test('lint fails a named import from lib in a test file, and not one spelled in a string', async () => {
  const sample = 'test/unit/sample.test.ts';
  assert.deepEqual(await lintFindings(sample, "import { pathKey } from '../../lib/paths.ts';\n"), [
    'no-restricted-syntax',
  ]);
  assert.deepEqual(await lintFindings(sample, "import * as paths from '../../lib/paths.ts';\n"), []);
  assert.deepEqual(await lintFindings(sample, "export const text = `\nimport { add } from '../lib/add.ts';\n`;\n"), []);
});

test('lint fails a type imported by name from lib in a test file, and allows it inside lib', async () => {
  const sample = 'test/support/sample.ts';
  const restricted = ['no-restricted-syntax'];
  assert.deepEqual(await lintFindings(sample, "import type { Deps } from '../../lib/run-context.ts';\n"), restricted);
  assert.deepEqual(await lintFindings(sample, "import { type Deps } from '../../lib/run-context.ts';\n"), restricted);
  assert.deepEqual(await lintFindings(sample, "import type * as runContext from '../../lib/run-context.ts';\n"), []);
  assert.deepEqual(await lintFindings('lib/sample.ts', "import type { Deps } from './run-context.ts';\n"), []);
});

// Documents agents read for today's paths. An ADR or a docs/research record is dated: it names paths as they were.
const LIVING_DOCUMENTS = [
  'AGENTS.md',
  'GLOSSARY.md',
  'README.md',
  'docs/adr/0014-procedures-are-data.md',
  'docs/interfaces/harness.md',
  'docs/library-survey.md',
  'docs/requests/node-harness-dag.md',
  'docs/testing.md',
];
// A path from the repository root, so not node_modules/eslint/bin/eslint.js or another project's src/lib/x.ts.
const CODE_PATH = /(?<![\w/.-])(?:lib|bin|scripts)\/[\w/.-]*\.(?:[cm]?js|ts)\b/g;
const codePathsIn = (text: string) => [...text.matchAll(CODE_PATH)].map((match) => match[0]);

test('a living document names only code files that exist', () => {
  assert.deepEqual(
    codePathsIn('See `lib/gone.mjs:12`, bin/gg.ts. Then node_modules/eslint/bin/eslint.js, src/lib/a.ts'),
    ['lib/gone.mjs', 'bin/gg.ts'],
  );
  const named = LIVING_DOCUMENTS.flatMap((document) => codePathsIn(readFileSync(root + document, 'utf8')));
  assert.ok(named.includes('lib/paths.ts'), 'the documents are read');
  assert.deepEqual(
    named.filter((path) => !existsSync(root + path)),
    [],
    'name the file as it is today',
  );
});
