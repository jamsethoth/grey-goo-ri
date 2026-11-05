import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// What makes a test medium (docs/testing.md, "Test sizes"), as it shows in a test file's source.
// shortcut: a text check misses a bare `sh(` or an unlisted spawning helper; a runtime guard if the fast stage slows (docs/testing.md, "Considered and deferred").
const MEDIUM = [
  [/['"](?:node:)?child_process['"]/, 'imports node:child_process'],
  [/['"](?:\.\.\/)+lib\/(?:exec|git)\.ts['"]/, 'imports lib/exec.ts or lib/git.ts'],
  [/\b(?:git|integrity):\s*['"]real['"]/, 'asks for real git'],
  [/\bset(?:Timeout|Interval)\s*\(|['"]node:timers/, 'uses a timer'],
  [/\b(?:golden|run|support|gitShell)\.sh\(|\b(?:holdLock|conflict|seedRepos)\(/, 'calls a support helper that spawns'],
];
// This file is left out: its samples below spell every marker, and it only reads files.
const unitFiles = readdirSync(new URL('./', import.meta.url), { recursive: true })
  .map((f) => f.split('\\').join('/'))
  .filter((f) => /\.test\.(?:mjs|ts)$/.test(f) && f !== 'layout.test.mjs');

const marked = [
  ["import { spawn } from 'node:child_process';", 'imports node:child_process'],
  ["import * as git from '../../lib/git.ts';", 'imports lib/exec.ts or lib/git.ts'],
  ["await golden.setup(t, { git: 'real' })", 'asks for real git'],
  ["fixture(t, { integrity: 'real' })", 'asks for real git'],
  ['await new Promise((r) => setTimeout(r, 5))', 'uses a timer'],
  ["import { setTimeout as sleep } from 'node:timers/promises';", 'uses a timer'],
  ['golden.sh(g.worktree, "log")', 'calls a support helper that spawns'],
  ['run.holdLock(t, f.commonDir, "repo")', 'calls a support helper that spawns'],
];
for (const [text, what] of marked) {
  test(`the size check flags a unit file that ${what}: ${text}`, () => {
    assert.deepEqual(
      MEDIUM.filter(([re]) => re.test(text)).map(([, w]) => w),
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
const SKIPPED = new Set(['.git', 'node_modules']);
function repoFiles(dir = '') {
  return readdirSync(root + dir, { withFileTypes: true }).flatMap((entry) => {
    const path = dir + entry.name;
    if (SKIPPED.has(entry.name)) return [];
    return entry.isDirectory() ? repoFiles(`${path}/`) : [path];
  });
}
// Every module under lib, so a new one is scanned without joining a list (grey-goo-ri issue #219).
const modules = repoFiles('lib/').filter((path) => /\.(?:mjs|ts)$/.test(path));

// The paths the AGENTS.md layout table names; a row ending in / covers the files under it.
const layoutRows = (agents) => {
  const section = /^## Layout$([\s\S]*?)^## /m.exec(agents)?.[1] ?? '';
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
};
const unlistedFiles = (files, rows) =>
  files.filter((path) => !rows.some((row) => row === path || (row.endsWith('/') && path.startsWith(row))));

test('every module under lib imports', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^## Layout$/m);
  assert.match(agents, /^## Tests$/m);
  assert.doesNotMatch(agents, /The layout section here grows with the code/);
  for (const path of modules) {
    const mod = await import(pathToFileURL(root + path));
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
// (`run.branches.test.mjs`), and never a grab-bag name that says nothing of its job (Angular's style guide).
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.(?:mjs|ts)$/;
const GRAB_BAG = /^(?:utils?|helpers?|common|misc|shared)\./;
const misnamed = (files) =>
  files.filter((path) => {
    const name = path.split('/').at(-1);
    return !FILE_NAME.test(name) || GRAB_BAG.test(name);
  });

test('every code file is named in lowercase hyphenated words for its job', () => {
  const samples = [
    'lib/process-tree.ts',
    'test/unit/run.branches.test.mjs',
    'lib/processTree.ts',
    'lib/write_ahead.ts',
  ];
  assert.deepEqual(misnamed([...samples, 'lib/utils.ts']), [
    'lib/processTree.ts',
    'lib/write_ahead.ts',
    'lib/utils.ts',
  ]);
  const code = ['lib/', 'bin/', 'scripts/', 'test/']
    .flatMap((dir) => repoFiles(dir))
    .filter((path) => /\.(?:mjs|ts)$/.test(path));
  assert.ok(code.includes('lib/process-tree.ts') && code.includes('bin/gg.ts'), 'the code files are read');
  assert.deepEqual(misnamed(code), [], 'rename the file: lowercase words joined by hyphens, named for what it does');
});

test('every file under lib has a row in AGENTS.md', async () => {
  const sampleRows = ['lib/a.mjs', 'lib/templates/'];
  assert.deepEqual(unlistedFiles(['lib/a.mjs', 'lib/templates/t.md', 'lib/b.mjs'], sampleRows), ['lib/b.mjs']);
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
const sharingLibNames = (supportFiles, libModules) => {
  const stem = (path) => path.replace(/^.*\//, '').replace(/\.(?:mjs|ts)$/, '');
  const libNames = new Set(libModules.map(stem));
  return supportFiles.filter((path) => libNames.has(stem(path)));
};

test('no test/support file shares a lib module name', () => {
  assert.deepEqual(
    sharingLibNames(['test/support/run.mjs', 'test/support/run-fixture.ts'], ['lib/run.ts', 'lib/flow.ts']),
    ['test/support/run.mjs'],
  );
  const supportFiles = repoFiles('test/support/');
  assert.ok(supportFiles.includes('test/support/execution-context.ts'), 'the support files are read');
  assert.deepEqual(sharingLibNames(supportFiles, modules), [], 'name the helper for its job, not its lib module');
});

// A named import from lib at the start of a line; a string that spells one inside a case does not start a line.
const NAMED_LIB_IMPORT = /^import\s+(?!(?:type\s+)?\*\s*as\s)[^;]*?\sfrom\s+['"](?:\.\.\/)+lib\//m;

test('tests import lib modules as namespaces', () => {
  assert.equal(NAMED_LIB_IMPORT.test("import { pathKey } from '../../lib/paths.ts';"), true);
  assert.equal(NAMED_LIB_IMPORT.test("import {\n  a,\n  b,\n} from '../../../lib/git.ts';"), true);
  assert.equal(NAMED_LIB_IMPORT.test("import * as paths from '../../lib/paths.ts';"), false);
  assert.equal(NAMED_LIB_IMPORT.test("import type * as paths from '../../lib/paths.ts';"), false);
  assert.equal(NAMED_LIB_IMPORT.test('  "import { add } from \'../lib/add.mjs\';\\n",'), false);
  assert.equal(NAMED_LIB_IMPORT.test("import { join } from 'node:path';\nimport * as x from '../lib/x.mjs';"), false);
  const testFiles = repoFiles('test/').filter((path) => /\.(?:mjs|ts)$/.test(path));
  assert.deepEqual(
    testFiles.filter((path) => NAMED_LIB_IMPORT.test(readFileSync(root + path, 'utf8'))),
    [],
    'import a lib module as `import * as name`',
  );
});

// lib/git.ts is the one git interface (grey-goo-ri issue #144): every other module calls its verbs with gg's values.
test('no module outside lib/git.ts passes git a command line', async () => {
  const git = await import(pathToFileURL(`${root}lib/git.ts`));
  assert.equal(git.runGit, undefined, 'runGit is not exported');
  const raw = [
    [/\brunGit\b/, 'runGit'],
    [/\b(?:run|spawn|spawnSync|execFile|execFileSync)\(\s*['"`]git['"`]/, 'a spawned git'],
    [/\^\{|\.\.\.HEAD|refs\/heads\/|['"`]HEAD['"`]/, 'git ref syntax'],
    [/['"`]:\([a-z,]+\)/, 'a git pathspec'],
    // bin/gg.ts passes lib/git.ts in; a module that imported it could fall back to it instead of the git it was given.
    [/from ['"`]\.\/git\.ts['"`]/, 'an import of lib/git.ts'],
  ];
  for (const path of [...modules.filter((m) => m !== 'lib/git.ts'), 'bin/gg.ts', 'scripts/run-suite.ts']) {
    const text = await readFile(root + path, 'utf8');
    for (const [re, what] of raw) assert.doesNotMatch(text, re, `${path} builds ${what}`);
  }
});

// ADR 0018: modules convert to TypeScript one at a time. This list only grows, and each entry exists as .ts.
const CONVERTED = [
  'bin/gg.ts',
  'lib/agent-action.ts',
  'lib/agent-call.ts',
  'lib/approval.ts',
  'lib/bounds.ts',
  'lib/briefs.ts',
  'lib/check-action.ts',
  'lib/checks.ts',
  'lib/command-cleanup.ts',
  'lib/config.ts',
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
  'lib/publish.ts',
  'lib/reconcile.ts',
  'lib/record.ts',
  'lib/refs.ts',
  'lib/remote-effects.ts',
  'lib/render.ts',
  'lib/rules.ts',
  'lib/run-context.ts',
  'lib/run.ts',
  'lib/stats.ts',
  'lib/terminal-report.ts',
  'lib/terminal.ts',
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
  'lib/work.ts',
  'scripts/run-suite.ts',
  'test/e2e/reconcile.crash.test.ts',
  'test/e2e/reconcile.holds.test.ts',
  'test/e2e/reconcile.replay.test.ts',
  'test/e2e/reconcile.test.ts',
  'test/e2e/run.admission.test.ts',
  'test/e2e/run.branch-names.test.ts',
  'test/e2e/run.branches.test.ts',
  'test/e2e/run.concurrency.test.ts',
  'test/e2e/run.recovery.test.ts',
  'test/e2e/run.redaction.test.ts',
  'test/e2e/run.resume.test.ts',
  'test/support/add-suite.ts',
  'test/support/case-database.ts',
  'test/support/child-exit.ts',
  'test/support/crash-fs.ts',
  'test/support/crash-resume.ts',
  'test/support/epic-run.ts',
  'test/support/event-appender.ts',
  'test/support/execution-context.ts',
  'test/support/execution-reads.ts',
  'test/support/fake-gh.ts',
  'test/support/fake-git.ts',
  'test/support/fake-git-paths.ts',
  'test/support/fake-git-store.ts',
  'test/support/fake-harness.ts',
  'test/support/fake-integrity.ts',
  'test/support/git-shell.ts',
  'test/support/golden.ts',
  'test/support/golden-run.ts',
  'test/support/integrity-worktrees.ts',
  'test/support/keys.ts',
  'test/support/latch.ts',
  'test/support/lock-contender.ts',
  'test/support/lock-holder.ts',
  'test/support/lock-stress.ts',
  'test/support/procedure-actions.ts',
  'test/support/record-saver.ts',
  'test/support/repo-lock-contention.ts',
  'test/support/repo-lock-writer.ts',
  'test/support/request-tables.ts',
  'test/support/review-flow.ts',
  'test/support/run-fixture.ts',
  'test/support/state-database-open-stress.ts',
  'test/support/state-database-opener.ts',
  'test/support/temp-directory.ts',
  'test/support/template-repos.ts',
  'test/support/write-lock-holder.ts',
  'test/unit/reconcile.crash.test.ts',
  'test/unit/reconcile.holds.test.ts',
  'test/unit/reconcile.replay.test.ts',
  'test/unit/reconcile.test.ts',
  'test/unit/run.admission.test.ts',
  'test/unit/run.branches.test.ts',
  'test/unit/run.concurrency.test.ts',
  'test/unit/run.holds.test.ts',
  'test/unit/run.recovery.test.ts',
  'test/unit/run.redaction.test.ts',
  'test/unit/run.resume.test.ts',
  'test/unit/run.test.ts',
];
// Every .mjs file when ADR 0018 was accepted. It only shrinks: a converted file leaves it, and no new .mjs file joins.
const LEGACY_MJS = [
  'eslint.config.mjs',
  'test/contract/exec/exec.test.mjs',
  'test/contract/git/git.test.mjs',
  'test/contract/git/template-repos.test.mjs',
  'test/contract/harness/harnesses-contract.test.mjs',
  'test/contract/sqlite/events.test.mjs',
  'test/contract/sqlite/integrity.test.mjs',
  'test/contract/sqlite/locks.test.mjs',
  'test/contract/sqlite/record.test.mjs',
  'test/e2e/checks.test.mjs',
  'test/e2e/gg.test.mjs',
  'test/e2e/integrity.test.mjs',
  'test/e2e/interpreter.faults.test.mjs',
  'test/e2e/interpreter.fix.test.mjs',
  'test/e2e/interpreter.retry.test.mjs',
  'test/e2e/interpreter.test.mjs',
  'test/e2e/interpreter.visit.test.mjs',
  'test/e2e/interpreter.write-ahead.test.mjs',
  'test/e2e/reconcile.crash.test.mjs',
  'test/e2e/reconcile.holds.test.mjs',
  'test/e2e/reconcile.replay.test.mjs',
  'test/e2e/reconcile.test.mjs',
  'test/e2e/run-suite.test.mjs',
  'test/e2e/run.admission.test.mjs',
  'test/e2e/run.branches.test.mjs',
  'test/e2e/run.concurrency.test.mjs',
  'test/e2e/run.recovery.test.mjs',
  'test/e2e/run.resume.test.mjs',
  'test/unit/approval.test.mjs',
  'test/unit/briefs.test.mjs',
  'test/unit/checks.test.mjs',
  'test/unit/config.test.mjs',
  'test/unit/defaults.test.mjs',
  'test/unit/doctor.test.mjs',
  'test/unit/events.test.mjs',
  'test/unit/fake-harness.test.mjs',
  'test/unit/flow.test.mjs',
  'test/unit/github.test.mjs',
  'test/unit/harness-boundary.test.mjs',
  'test/unit/integrity.test.mjs',
  'test/unit/interpreter.backoff.test.mjs',
  'test/unit/interpreter.faults.test.mjs',
  'test/unit/interpreter.fix.test.mjs',
  'test/unit/interpreter.retry.test.mjs',
  'test/unit/interpreter.review.test.mjs',
  'test/unit/interpreter.test.mjs',
  'test/unit/interpreter.visit.test.mjs',
  'test/unit/interpreter.write-ahead.test.mjs',
  'test/unit/labels.test.mjs',
  'test/unit/layout.test.mjs',
  'test/unit/marker.test.mjs',
  'test/unit/outcome.test.mjs',
  'test/unit/personas.test.mjs',
  'test/unit/procedures.test.mjs',
  'test/unit/reconcile.crash.test.mjs',
  'test/unit/reconcile.holds.test.mjs',
  'test/unit/reconcile.replay.test.mjs',
  'test/unit/reconcile.test.mjs',
  'test/unit/record.test.mjs',
  'test/unit/refs.test.mjs',
  'test/unit/render.test.mjs',
  'test/unit/rules.test.mjs',
  'test/unit/run-suite.test.mjs',
  'test/unit/run.admission.test.mjs',
  'test/unit/run.branches.test.mjs',
  'test/unit/run.concurrency.test.mjs',
  'test/unit/run.holds.test.mjs',
  'test/unit/run.recovery.test.mjs',
  'test/unit/run.resume.test.mjs',
  'test/unit/run.test.mjs',
  'test/unit/validate.test.mjs',
];
const unlistedMjs = (files) => files.filter((path) => path.endsWith('.mjs') && !LEGACY_MJS.includes(path));

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
const rangeMajor = (range) => {
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
    assert.ok(!existsSync(root + path.replace(/\.ts$/, '.mjs')), `${path} has no .mjs twin`);
  }
});

test('a new .mjs file fails the layout test', () => {
  assert.deepEqual(unlistedMjs([...LEGACY_MJS, 'lib/new.mjs']), ['lib/new.mjs']);
  assert.deepEqual(unlistedMjs(repoFiles()), [], 'write a new module as .ts (ADR 0018)');
  assert.deepEqual(
    LEGACY_MJS.filter((path) => !existsSync(root + path)),
    [],
    'a converted file leaves LEGACY_MJS',
  );
});
