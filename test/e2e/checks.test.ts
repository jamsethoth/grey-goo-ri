import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as checks from '../../lib/checks.ts';
import * as git from '../../lib/git.ts';
import * as committingRepo from '../support/committing-repo.ts';
import * as gitShell from '../support/git-shell.ts';

test('test immutability lists added, renamed and modified test paths and ignores lib', async (t) => {
  const repo = committingRepo.committingRepo(t);
  mkdirSync(join(repo, 'test'));
  mkdirSync(join(repo, 'lib'));
  writeFileSync(join(repo, 'test', 'a.test.mjs'), 'a');
  writeFileSync(join(repo, 'test', 'old.test.mjs'), 'old');
  writeFileSync(join(repo, 'lib', 'x.mjs'), 'x');
  gitShell.sh(repo, 'add', '-A');
  gitShell.sh(repo, 'commit', '-q', '-m', 'baseline');
  const baseline = gitShell.sh(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await checks.testImmutability(repo, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git }), {
    ok: true,
    changed: [],
  });

  writeFileSync(join(repo, 'test', 'a.test.mjs'), 'a changed');
  gitShell.sh(repo, 'commit', '-q', '-am', 'edit a test after the baseline');
  gitShell.sh(repo, 'mv', 'test/old.test.mjs', 'test/renamed.test.mjs');
  writeFileSync(join(repo, 'test', 'new.test.mjs'), 'new');
  writeFileSync(join(repo, 'lib', 'x.mjs'), 'x changed');

  // A rename lists both its paths.
  assert.deepEqual(await checks.testImmutability(repo, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git }), {
    ok: false,
    changed: ['test/a.test.mjs', 'test/new.test.mjs', 'test/old.test.mjs', 'test/renamed.test.mjs'],
  });
});

test('test immutability sees non-ASCII and git-ignored test paths', async (t) => {
  const repo = committingRepo.committingRepo(t);
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test', 'café.mjs'), 'a');
  writeFileSync(join(repo, '.gitignore'), 'test/ignored.mjs\n');
  gitShell.sh(repo, 'add', '-A');
  gitShell.sh(repo, 'commit', '-q', '-m', 'baseline');
  const baseline = gitShell.sh(repo, 'rev-parse', 'HEAD');

  writeFileSync(join(repo, 'test', 'café.mjs'), 'a changed');
  writeFileSync(join(repo, 'test', 'naïve.mjs'), 'new');
  writeFileSync(join(repo, 'test', 'ignored.mjs'), 'new');

  const result = await checks.testImmutability(repo, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git });
  assert.deepEqual(result, { ok: false, changed: ['test/café.mjs', 'test/ignored.mjs', 'test/naïve.mjs'] });
});

test('test immutability sees a test added under an ignored directory but not installed dependencies', async (t) => {
  const repo = committingRepo.committingRepo(t);
  writeFileSync(join(repo, '.gitignore'), 'generated/\nnode_modules/\n');
  gitShell.sh(repo, 'add', '-A');
  gitShell.sh(repo, 'commit', '-q', '-m', 'baseline');
  const baseline = gitShell.sh(repo, 'rev-parse', 'HEAD');

  mkdirSync(join(repo, 'generated'));
  writeFileSync(join(repo, 'generated', 'new.test.mjs'), 'new');
  mkdirSync(join(repo, 'node_modules', 'dep', 'test'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'test', 'index.js'), 'dep');

  const result = await checks.testImmutability(repo, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git });
  assert.deepEqual(result, { ok: false, changed: ['generated/new.test.mjs'] });
});

// Rollback lists untracked tests through git's :(glob) pathspecs and Test Immutability classifies with its own matcher,
// so every glob preflight accepts must select the same paths in both.
// Each glob is asserted alone, so one that breaks cannot hide behind another that selects the same path.
test('git and the test path matcher select the same paths for every kind of glob preflight accepts', async (t) => {
  const repo = committingRepo.committingRepo(t);
  mkdirSync(join(repo, 'spec', 'unit'), { recursive: true });
  mkdirSync(join(repo, 'specs'));
  mkdirSync(join(repo, 'deep', 'x'), { recursive: true });
  mkdirSync(join(repo, 'a.test.d'));
  mkdirSync(join(repo, 'scripts'));
  writeFileSync(join(repo, 'spec', 'unit', 'a.mjs'), 'x');
  writeFileSync(join(repo, 'specs', 'b.mjs'), 'x');
  writeFileSync(join(repo, 'deep', 'x', 'z.mjs'), 'x');
  writeFileSync(join(repo, 'deep', 'x.mjs'), 'x');
  writeFileSync(join(repo, 'deep', 'z.mjs'), 'x');
  writeFileSync(join(repo, 'top.test.mjs'), 'x');
  writeFileSync(join(repo, 'a.test.d', 'x.mjs'), 'x');
  writeFileSync(join(repo, 'scripts', 'run-suite.mjs'), 'x');
  writeFileSync(join(repo, 'scripts', 'run-suite.mjs.bak'), 'x');
  const paths = [
    'a.test.d/x.mjs',
    'deep/x.mjs',
    'deep/x/z.mjs',
    'deep/z.mjs',
    'scripts/run-suite.mjs',
    'scripts/run-suite.mjs.bak',
    'spec/unit/a.mjs',
    'specs/b.mjs',
    'top.test.mjs',
  ];
  const selects = async (glob: string) => ({
    git: await git.untrackedPaths(repo, { include: 'all', within: { globs: [glob] } }),
    matcher: paths.filter(checks.testPathMatcher([glob])),
  });

  assert.deepEqual(await selects('spec'), { git: ['spec/unit/a.mjs'], matcher: ['spec/unit/a.mjs'] });
  assert.deepEqual(await selects('**/x/**'), { git: ['deep/x/z.mjs'], matcher: ['deep/x/z.mjs'] });
  assert.deepEqual(await selects('*.test.*'), { git: ['top.test.mjs'], matcher: ['top.test.mjs'] });
  assert.deepEqual(await selects('de*/**/z.mjs'), {
    git: ['deep/x/z.mjs', 'deep/z.mjs'],
    matcher: ['deep/x/z.mjs', 'deep/z.mjs'],
  });
  assert.deepEqual(await selects('scripts/run-suite.mjs'), {
    git: ['scripts/run-suite.mjs'],
    matcher: ['scripts/run-suite.mjs'],
  });
});

test('git and the test path matcher both ignore case', async (t) => {
  const repo = committingRepo.committingRepo(t);
  mkdirSync(join(repo, 'Spec'));
  mkdirSync(join(repo, 'deep'));
  writeFileSync(join(repo, 'Spec', 'a.mjs'), 'x');
  writeFileSync(join(repo, 'deep', 'B.TEST.mjs'), 'x');
  writeFileSync(join(repo, 'deep', 'c.mjs'), 'x');
  const globs = ['spec/**', '**/*.test.*'];
  assert.deepEqual(await git.untrackedPaths(repo, { include: 'all', within: { globs } }), [
    'Spec/a.mjs',
    'deep/B.TEST.mjs',
  ]);
  assert.deepEqual(['Spec/a.mjs', 'deep/B.TEST.mjs', 'deep/c.mjs'].filter(checks.testPathMatcher(globs)), [
    'Spec/a.mjs',
    'deep/B.TEST.mjs',
  ]);
});

test('git and the test path matcher fold ASCII case only', async (t) => {
  const repo = committingRepo.committingRepo(t);
  mkdirSync(join(repo, 'spec'));
  mkdirSync(join(repo, 'lib'));
  writeFileSync(join(repo, 'spec', 'é.mjs'), 'x');
  writeFileSync(join(repo, 'lib', 'x.mjs'), 'x');
  const globs = ['spec/É*', 'LIB/*'];
  assert.deepEqual(await git.untrackedPaths(repo, { include: 'all', within: { globs } }), ['lib/x.mjs']);
  assert.deepEqual(['spec/é.mjs', 'lib/x.mjs'].filter(checks.testPathMatcher(globs)), ['lib/x.mjs']);
});
