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
  [/['"](?:\.\.\/)+lib\/(?:exec|git)\.mjs['"]/, 'imports lib/exec.mjs or lib/git.mjs'],
  [/\b(?:git|integrity):\s*['"]real['"]/, 'asks for real git'],
  [/\bset(?:Timeout|Interval)\s*\(|['"]node:timers/, 'uses a timer'],
  [/\b(?:golden|run|support)\.sh\(|\b(?:holdLock|conflict|seedRepos)\(/, 'calls a support helper that spawns'],
];
// This file is left out: its samples below spell every marker, and it only reads files.
const unitFiles = readdirSync(new URL('./', import.meta.url), { recursive: true })
  .map((f) => f.split('\\').join('/'))
  .filter((f) => /\.test\.(?:mjs|ts)$/.test(f) && f !== 'layout.test.mjs');

const marked = [
  ["import { spawn } from 'node:child_process';", 'imports node:child_process'],
  ["import * as git from '../../lib/git.mjs';", 'imports lib/exec.mjs or lib/git.mjs'],
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
const modules = [
  'lib/opts.mjs',
  'lib/config.mjs',
  'lib/flow.mjs',
  'lib/run.mjs',
  'lib/interpreter.mjs',
  'lib/effects.mjs',
  'lib/terminal.mjs',
  'lib/procedures.mjs',
  'lib/briefs.mjs',
  'lib/outcome.mjs',
  'lib/rules.mjs',
  'lib/checks.mjs',
  'lib/integrity.mjs',
  'lib/record.mjs',
  'lib/marker.mjs',
  'lib/reconcile.mjs',
  'lib/events.mjs',
  'lib/labels.mjs',
  'lib/approval.mjs',
  'lib/locks.mjs',
  'lib/harnesses/contract.mjs',
  'lib/harnesses/claude.mjs',
  'lib/harnesses/codex.mjs',
  'lib/exec.mjs',
  'lib/git.mjs',
  'lib/paths.ts',
  'lib/github.mjs',
  'lib/render.mjs',
  'lib/work.mjs',
  'lib/trace.mjs',
  'lib/stats.mjs',
  'lib/doctor.mjs',
  'lib/plan.mjs',
  'lib/publish.mjs',
];

test('every module in the AGENTS.md layout imports', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^## Layout$/m);
  assert.match(agents, /^## Tests$/m);
  assert.doesNotMatch(agents, /The layout section here grows with the code/);
  for (const path of [...modules, 'bin/gg.mjs']) assert.ok(agents.includes(`\`${path}\``), `AGENTS.md lists ${path}`);
  for (const path of modules) {
    const mod = await import(pathToFileURL(root + path));
    assert.equal(typeof mod, 'object', path);
  }
});

test('every file under lib is scanned', () => {
  const libFiles = repoFiles('lib/');
  for (const path of ['lib/validate.mjs', 'lib/refs.mjs', 'lib/harnesses/shipped.mjs']) {
    assert.ok(modules.includes(path), `${path} is scanned`);
  }
  // Templates and the job-object script are not modules: they import nothing and run no git.
  assert.deepEqual(
    libFiles.filter((path) => !modules.includes(path) && !/\.(?:md|ps1)$/.test(path)),
    [],
  );
});

test('every file under lib has a row in AGENTS.md', async () => {
  const sampleRows = ['lib/a.mjs', 'lib/templates/'];
  assert.deepEqual(unlistedFiles(['lib/a.mjs', 'lib/templates/t.md', 'lib/b.mjs'], sampleRows), ['lib/b.mjs']);
  const rows = layoutRows(await readFile(`${root}AGENTS.md`, 'utf8'));
  assert.ok(rows.includes('lib/validate.mjs') && rows.includes('bin/gg.mjs'), 'the layout table is read');
  assert.deepEqual(unlistedFiles(repoFiles('lib/'), rows), [], 'add a row to the AGENTS.md layout table');
  assert.deepEqual(
    rows.filter((path) => !existsSync(root + path)),
    [],
    'a layout row names a file that exists',
  );
});

// A named import from lib at the start of a line; a string that spells one inside a case does not start a line.
const NAMED_LIB_IMPORT = /^import\s+(?!\*\s*as\s)[^;]*?\sfrom\s+['"](?:\.\.\/)+lib\//m;

test('tests import lib modules as namespaces', () => {
  assert.equal(NAMED_LIB_IMPORT.test("import { pathKey } from '../../lib/paths.ts';"), true);
  assert.equal(NAMED_LIB_IMPORT.test("import {\n  a,\n  b,\n} from '../../../lib/git.mjs';"), true);
  assert.equal(NAMED_LIB_IMPORT.test("import * as paths from '../../lib/paths.ts';"), false);
  assert.equal(NAMED_LIB_IMPORT.test('  "import { add } from \'../lib/add.mjs\';\\n",'), false);
  assert.equal(NAMED_LIB_IMPORT.test("import { join } from 'node:path';\nimport * as x from '../lib/x.mjs';"), false);
  const testFiles = repoFiles('test/').filter((path) => /\.(?:mjs|ts)$/.test(path));
  assert.deepEqual(
    testFiles.filter((path) => NAMED_LIB_IMPORT.test(readFileSync(root + path, 'utf8'))),
    [],
    'import a lib module as `import * as name`',
  );
});

// lib/git.mjs is the one git interface (grey-goo-ri issue #144): every other module calls its verbs with gg's values.
test('no module outside lib/git.mjs passes git a command line', async () => {
  const git = await import(pathToFileURL(`${root}lib/git.mjs`));
  assert.equal(git.runGit, undefined, 'runGit is not exported');
  const raw = [
    [/\brunGit\b/, 'runGit'],
    [/\b(?:run|spawn|spawnSync|execFile|execFileSync)\(\s*['"`]git['"`]/, 'a spawned git'],
    [/\^\{|\.\.\.HEAD|refs\/heads\/|['"`]HEAD['"`]/, 'git ref syntax'],
    [/['"`]:\([a-z,]+\)/, 'a git pathspec'],
    // bin/gg.mjs passes lib/git.mjs in; a module that imported it could fall back to it instead of the git it was given.
    [/from ['"`]\.\/git\.mjs['"`]/, 'an import of lib/git.mjs'],
  ];
  for (const path of [...modules.filter((m) => m !== 'lib/git.mjs'), 'bin/gg.mjs', 'scripts/run-suite.mjs']) {
    const text = await readFile(root + path, 'utf8');
    for (const [re, what] of raw) assert.doesNotMatch(text, re, `${path} builds ${what}`);
  }
});

// ADR 0018: modules convert to TypeScript one at a time. This list only grows, and each entry exists as .ts.
const CONVERTED = ['lib/paths.ts'];
// Every .mjs file when ADR 0018 was accepted. It only shrinks: a converted file leaves it, and no new .mjs file joins.
const LEGACY_MJS = [
  'bin/gg.mjs',
  'eslint.config.mjs',
  'lib/approval.mjs',
  'lib/briefs.mjs',
  'lib/checks.mjs',
  'lib/config.mjs',
  'lib/doctor.mjs',
  'lib/effects.mjs',
  'lib/events.mjs',
  'lib/exec.mjs',
  'lib/flow.mjs',
  'lib/git.mjs',
  'lib/github.mjs',
  'lib/harnesses/claude.mjs',
  'lib/harnesses/codex.mjs',
  'lib/harnesses/contract.mjs',
  'lib/harnesses/shipped.mjs',
  'lib/integrity.mjs',
  'lib/interpreter.mjs',
  'lib/labels.mjs',
  'lib/locks.mjs',
  'lib/marker.mjs',
  'lib/opts.mjs',
  'lib/outcome.mjs',
  'lib/plan.mjs',
  'lib/procedures.mjs',
  'lib/publish.mjs',
  'lib/reconcile.mjs',
  'lib/record.mjs',
  'lib/refs.mjs',
  'lib/render.mjs',
  'lib/rules.mjs',
  'lib/run.mjs',
  'lib/stats.mjs',
  'lib/terminal.mjs',
  'lib/trace.mjs',
  'lib/validate.mjs',
  'lib/work.mjs',
  'scripts/run-suite.mjs',
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
  'test/e2e/interpreter.backoff.test.mjs',
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
  'test/support/db-opener.mjs',
  'test/support/event-appender.mjs',
  'test/support/fake-git.mjs',
  'test/support/fake-harness.mjs',
  'test/support/fake-integrity.mjs',
  'test/support/golden.mjs',
  'test/support/interpreter.mjs',
  'test/support/lock-contender.mjs',
  'test/support/lock-stress.mjs',
  'test/support/open-stress.mjs',
  'test/support/reconcile.mjs',
  'test/support/record-saver.mjs',
  'test/support/repo-lock-writer.mjs',
  'test/support/run.mjs',
  'test/support/template-repos.mjs',
  'test/support/write-lock-holder.mjs',
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
  'test/unit/opts.test.mjs',
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
const SKIPPED = new Set(['.git', 'node_modules']);
function repoFiles(dir = '') {
  return readdirSync(root + dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = dir + entry.name;
    return entry.isDirectory() ? repoFiles(`${path}/`) : [path];
  });
}
const unlistedMjs = (files) => files.filter((path) => path.endsWith('.mjs') && !LEGACY_MJS.includes(path));

test('package.json keeps type module', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(pkg.type, 'module');
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
