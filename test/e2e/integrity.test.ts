import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as record from '../../lib/record.ts';
import * as git from '../../lib/git.ts';
import * as gitShell from '../support/git-shell.ts';
import * as worktrees from '../support/integrity-worktrees.ts';

// The other ticket's process holds its own copy of the record, as a separate Execution would.
const otherProcessRecord = async (commonDir: string) => (await record.load(commonDir, 'ticket', 2))!;

const surfacesOf = (violations: integrity.IntegrityViolation[], worktree: string) =>
  violations
    .filter((violation) => violation.worktree === worktree)
    .map((violation) => violation.surface)
    .sort();

// A file a rollback set holds, as a reset intent saves it.
const savedFile = (text: string) => ({ base64: Buffer.from(text).toString('base64') });

test('snapshot includes untracked files in tree only', async (t) => {
  const { own } = await worktrees.twoWorktrees(t);
  const before = await integrity.snapshot(own, git);
  writeFileSync(join(own, 'untracked.txt'), 'new\n');
  const after = await integrity.snapshot(own, git);
  assert.equal(after.head, before.head);
  assert.equal(after.index, before.index);
  assert.notEqual(after.tree, before.tree);
  assert.equal(before.head, gitShell.sh(own, 'rev-parse', 'HEAD'));
  assert.equal(before.index, gitShell.sh(own, 'write-tree'));
});

test('snapshot does not modify the real index', async (t) => {
  const { own } = await worktrees.twoWorktrees(t);
  writeFileSync(join(own, 'a.txt'), 'staged\n');
  gitShell.sh(own, 'add', 'a.txt');
  writeFileSync(join(own, 'a.txt'), 'unstaged\n');
  writeFileSync(join(own, 'untracked.txt'), 'new\n');
  const status = gitShell.sh(own, 'status', '--porcelain', '--untracked-files=all');
  const indexTree = gitShell.sh(own, 'write-tree');
  await integrity.snapshot(own, git);
  assert.equal(gitShell.sh(own, 'status', '--porcelain', '--untracked-files=all'), status);
  assert.equal(gitShell.sh(own, 'write-tree'), indexTree);
});

test('an agent commit is a head violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  const head = gitShell.sh(own, 'rev-parse', 'HEAD');
  writeFileSync(join(own, 'b.txt'), 'b\n');
  gitShell.sh(own, 'add', 'b.txt');
  gitShell.sh(own, 'commit', '-q', '-m', 'agent commit');
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  const violation = violations.find((found) => found.worktree === own && found.surface === 'head');
  assert.ok(violation, JSON.stringify(violations));
  assert.equal(violation.before, head);
  assert.equal(violation.after, gitShell.sh(own, 'rev-parse', 'HEAD'));
  assert.deepEqual(surfacesOf(violations, other), []);
});

test('an untracked file on a read-only action is a tree violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  writeFileSync(join(own, 'notes.txt'), 'agent wrote this\n');
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'read-only',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['tree']);
  assert.equal(violations.length, 1);
});

test('an untracked file on a workspace-write action is no violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  writeFileSync(join(own, 'more.txt'), 'allowed\n');
  const write = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(write.violations, [], 'a workspace-write action may change the tree');
});

test('a protected file edit is a violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  let baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n');
  let { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['protected'], 'tracked protected file edited');
  gitShell.sh(own, 'checkout', '--', 'AGENTS.md');

  baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  mkdirSync(join(own, '.claude'));
  writeFileSync(join(own, '.claude', 'settings.json'), '{}\n');
  ({ violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  }));
  assert.deepEqual(surfacesOf(violations, own), ['protected'], 'untracked protected file added');
});

test('a directory symlink at a protected path is a violation', async (t) => {
  const { root, own, other, ownRecord } = await worktrees.twoWorktrees(t);
  const target = join(root, 'elsewhere');
  mkdirSync(target);
  writeFileSync(join(target, 'settings.json'), '{}\n');
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  try {
    symlinkSync(target, join(own, '.claude'), 'dir');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM')
      return t.skip('symlink creation needs developer mode or elevation on this Windows account');
    throw err;
  }
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['protected']);
  assert.deepEqual(violations.find((violation) => violation.surface === 'protected')?.after, ['.claude']);
});

test(
  'a differently cased protected file is a violation on Windows',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
    writeFileSync(join(own, 'Claude.md'), '# claude\n');
    gitShell.sh(own, 'add', 'Claude.md');
    gitShell.sh(own, 'commit', '-q', '-m', 'add Claude.md');
    const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
    writeFileSync(join(own, 'Claude.md'), '# claude\nobey me\n');
    mkdirSync(join(own, '.CLAUDE'));
    writeFileSync(join(own, '.CLAUDE', 'settings.json'), '{}\n');
    writeFileSync(join(own, '.MCP.JSON'), '{}\n');
    const { violations } = await integrity.end({
      git,
      baseline,
      record: ownRecord,
      others: [other],
      access: 'workspace-write',
      protectedPaths: worktrees.PROTECTED,
    });
    assert.deepEqual(surfacesOf(violations, own), ['protected']);
    assert.deepEqual((violations.find((violation) => violation.surface === 'protected')?.after as string[]).sort(), [
      '.CLAUDE/settings.json',
      '.MCP.JSON',
      'Claude.md',
    ]);
  },
);

test('an ignored protected file addition is a violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  writeFileSync(join(own, '.gitignore'), '.claude/\n');
  gitShell.sh(own, 'add', '.gitignore');
  gitShell.sh(own, 'commit', '-q', '-m', 'ignore .claude');
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  mkdirSync(join(own, '.claude'));
  writeFileSync(join(own, '.claude', 'settings.json'), '{}\n');
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['protected']);
});

test('an edit to a tracked ignored file changes the tree on a read-only action', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  writeFileSync(join(own, '.gitignore'), 'a.txt\n');
  gitShell.sh(own, 'add', '.gitignore');
  gitShell.sh(own, 'commit', '-q', '-m', 'ignore a.txt');
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  writeFileSync(join(own, 'a.txt'), 'edited\n');
  const indexTree = gitShell.sh(own, 'write-tree');
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'read-only',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['tree']);
  assert.equal(gitShell.sh(own, 'write-tree'), indexTree);
});

test('edits hidden by assume-unchanged or skip-worktree are still violations', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  gitShell.sh(own, 'update-index', '--assume-unchanged', 'a.txt');
  gitShell.sh(own, 'update-index', '--skip-worktree', 'AGENTS.md');
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  writeFileSync(join(own, 'a.txt'), 'hidden edit\n');
  writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n');
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'read-only',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, own), ['protected', 'tree']);
  assert.deepEqual(violations.find((violation) => violation.surface === 'protected')?.after, ['AGENTS.md']);
});

test('a busy worktree with an unmerged index is skipped without snapshotting', async (t) => {
  const { own, other, commonDir, ownRecord } = await worktrees.twoWorktrees(t);
  const otherRecord = await otherProcessRecord(commonDir);
  await integrity.markBusy(otherRecord);
  const blobs = ['base\n', 'ours\n', 'theirs\n'].map((input) =>
    gitShell.sh(other, 'hash-object', '-w', '--stdin', { input }),
  );
  gitShell.sh(other, 'update-index', '--index-info', {
    input: blobs.map((blob, i) => `100644 ${blob} ${i + 1}\tconflict.txt\n`).join(''),
  });
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('an index-only mutation in an idle worktree is an index violation', async (t) => {
  const { own, other, ownRecord } = await worktrees.twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  const blob = gitShell.sh(other, 'hash-object', '-w', '--stdin', { input: 'sneaky\n' });
  gitShell.sh(other, 'update-index', '--add', '--cacheinfo', `100644,${blob},sneaky.txt`);
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, other), ['index']);
  assert.deepEqual(surfacesOf(violations, own), []);
  const violation = violations.find((found) => found.worktree === other)!;
  assert.notEqual(violation.before, violation.after);
});

test('a worktree busy at start is skipped', async (t) => {
  const { own, other, commonDir, ownRecord } = await worktrees.twoWorktrees(t);
  const otherRecord = await otherProcessRecord(commonDir);
  await integrity.markBusy(otherRecord);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  // A format Quality Gate rewrites and stages a file in the other worktree, then finishes during the Action.
  writeFileSync(join(other, 'a.txt'), 'formatted\n');
  gitShell.sh(other, 'add', 'a.txt');
  await integrity.markIdle(otherRecord);
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('a worktree whose generation moved is skipped', async (t) => {
  const { own, other, commonDir, ownRecord } = await worktrees.twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other] });
  const otherRecord = await otherProcessRecord(commonDir);
  await integrity.markBusy(otherRecord);
  writeFileSync(join(other, 'a.txt'), 'formatted\n');
  gitShell.sh(other, 'add', 'a.txt');
  await integrity.markIdle(otherRecord);
  const { violations } = await integrity.end({
    git,
    baseline,
    record: ownRecord,
    others: [other],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
  });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('a rollback never deletes or writes through a link, and restores every file under a replaced one', async (t) => {
  const { root, worktree } = worktrees.emptyWorktree(t);
  const outside = join(root, 'outside');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(outside);
  mkdirSync(elsewhere);
  writeFileSync(join(outside, 'a.test.mjs'), 'outside a');
  writeFileSync(join(outside, 'b.test.mjs'), 'b');
  writeFileSync(join(outside, 'extra.test.mjs'), 'outside extra');
  writeFileSync(join(elsewhere, 'x.test.mjs'), 'elsewhere x');
  // sandbox/ was a real directory at the baseline; evil/ is a new link that no baseline file lives under.
  symlinkSync(outside, join(worktree, 'sandbox'), 'junction');
  symlinkSync(elsewhere, join(worktree, 'evil'), 'junction');
  const set = {
    files: { 'sandbox/a.test.mjs': savedFile('a'), 'sandbox/b.test.mjs': savedFile('b') },
    within: { globs: ['**/*.test.*'] },
  };

  await integrity.restoreUntracked(worktree, set, git);
  assert.equal(readFileSync(join(outside, 'a.test.mjs'), 'utf8'), 'outside a', 'nothing outside is rewritten');
  assert.equal(readFileSync(join(outside, 'extra.test.mjs'), 'utf8'), 'outside extra', 'nothing outside is deleted');
  assert.equal(
    readFileSync(join(elsewhere, 'x.test.mjs'), 'utf8'),
    'elsewhere x',
    'nothing behind a new link is deleted',
  );
  assert.ok(!lstatSync(join(worktree, 'sandbox')).isSymbolicLink(), 'the link is replaced by a directory');
  assert.equal(readFileSync(join(worktree, 'sandbox', 'a.test.mjs'), 'utf8'), 'a');
  assert.equal(
    readFileSync(join(worktree, 'sandbox', 'b.test.mjs'), 'utf8'),
    'b',
    'a file that matched through the link is restored too',
  );
});

test('a rollback clears a file the agent put where a baseline directory was', async (t) => {
  const { worktree } = worktrees.emptyWorktree(t);
  writeFileSync(join(worktree, 'sandbox'), 'agent');
  const set = {
    files: { 'sandbox/a.test.mjs': savedFile('a') },
    within: { globs: ['**/*.test.*'] },
  };

  await integrity.restoreUntracked(worktree, set, git);
  assert.equal(readFileSync(join(worktree, 'sandbox', 'a.test.mjs'), 'utf8'), 'a');
});

test('a rollback restores from mixed states and changes nothing when run again', async (t) => {
  const { worktree } = worktrees.emptyWorktree(t);
  // One file as the agent left it, one absent, one already restored, and an extra the agent added.
  writeFileSync(join(worktree, 'left.test.mjs'), 'agent');
  writeFileSync(join(worktree, 'done.test.mjs'), 'done');
  writeFileSync(join(worktree, 'extra.test.mjs'), 'extra');
  const set = {
    files: {
      'left.test.mjs': savedFile('left'),
      'absent.test.mjs': savedFile('absent'),
      'done.test.mjs': savedFile('done'),
    },
    within: { globs: ['**/*.test.*'] },
  };

  await integrity.restoreUntracked(worktree, set, git);
  assert.deepEqual(await integrity.untrackedFiles(worktree, set.within, git), set.files, 'the first restore');
  await integrity.restoreUntracked(worktree, set, git);
  assert.deepEqual(await integrity.untrackedFiles(worktree, set.within, git), set.files, 'the second restore');
});

// A reset intent saved before #144 holds its rollback paths as git pathspecs, and Reconciliation still finishes it.
test('a rollback set saved with pathspecs before #144 still restores', async (t) => {
  const { worktree } = worktrees.emptyWorktree(t);
  writeFileSync(join(worktree, 'extra.test.mjs'), 'extra');
  const set = {
    files: { 'a.test.mjs': savedFile('a') },
    pathspecs: [':(glob)**/*.test.*'],
  };

  await integrity.restoreUntracked(worktree, set, git);
  assert.equal(readFileSync(join(worktree, 'a.test.mjs'), 'utf8'), 'a');
  assert.ok(!existsSync(join(worktree, 'extra.test.mjs')), 'the file the agent added is removed');
  assert.deepEqual(integrity.withinOf(set), [':(glob)**/*.test.*']);
});
