import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as checks from '../../lib/checks.mjs';
import * as git from '../../lib/git.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('test immutability lists added, renamed and modified test paths and ignores lib', async (t) => {
  const dir = tempDir(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  mkdirSync(join(dir, 'test')); mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'test', 'a.test.mjs'), 'a');
  writeFileSync(join(dir, 'test', 'old.test.mjs'), 'old');
  writeFileSync(join(dir, 'lib', 'x.mjs'), 'x');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');
  assert.deepEqual(await checks.testImmutability(dir, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git }), { ok: true, changed: [] });

  writeFileSync(join(dir, 'test', 'a.test.mjs'), 'a changed');
  g('commit', '-q', '-am', 'edit a test after the baseline');
  g('mv', 'test/old.test.mjs', 'test/renamed.test.mjs');
  writeFileSync(join(dir, 'test', 'new.test.mjs'), 'new');
  writeFileSync(join(dir, 'lib', 'x.mjs'), 'x changed');

  // A rename lists both its paths.
  assert.deepEqual(await checks.testImmutability(dir, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git }),
    { ok: false, changed: ['test/a.test.mjs', 'test/new.test.mjs', 'test/old.test.mjs', 'test/renamed.test.mjs'] });
});

test('test immutability sees non-ASCII and git-ignored test paths', async (t) => {
  const dir = tempDir(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'café.mjs'), 'a');
  writeFileSync(join(dir, '.gitignore'), 'test/ignored.mjs\n');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');

  writeFileSync(join(dir, 'test', 'café.mjs'), 'a changed');
  writeFileSync(join(dir, 'test', 'naïve.mjs'), 'new');
  writeFileSync(join(dir, 'test', 'ignored.mjs'), 'new');

  const r = await checks.testImmutability(dir, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git });
  assert.deepEqual(r, { ok: false, changed: ['test/café.mjs', 'test/ignored.mjs', 'test/naïve.mjs'] });
});

test('test immutability sees a test added under an ignored directory but not installed dependencies', async (t) => {
  const dir = tempDir(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  writeFileSync(join(dir, '.gitignore'), 'generated/\nnode_modules/\n');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');

  mkdirSync(join(dir, 'generated'));
  writeFileSync(join(dir, 'generated', 'new.test.mjs'), 'new');
  mkdirSync(join(dir, 'node_modules', 'dep', 'test'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'test', 'index.js'), 'dep');

  const r = await checks.testImmutability(dir, baseline, { globs: checks.DEFAULT_TEST_GLOBS, git });
  assert.deepEqual(r, { ok: false, changed: ['generated/new.test.mjs'] });
});
