import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as git from '../lib/git.mjs';

test('commitAll commits everything or returns null; discardChanges resets the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  assert.equal(await git.commitAll(dir, 'test: nothing'), null);
  writeFileSync(join(dir, 'a.txt'), 'a');
  const sha = await git.commitAll(dir, 'test: add a\n\nbody');
  assert.equal(g('log', '-1', '--format=%H %s'), `${sha} test: add a`);
  writeFileSync(join(dir, 'a.txt'), 'changed'); writeFileSync(join(dir, 'b.txt'), 'b');
  await git.discardChanges(dir);
  assert.equal(g('status', '--porcelain'), '');
});

test('commitTree commits a recorded tree on its parent, leaves the index alone, and refuses a moved branch', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  const parent = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', 'a.txt');
  const tree = sh(dir, 'write-tree');
  sh(dir, 'reset', '-q');
  assert.equal(await git.commitTree(dir, { message: 'nothing', tree: sh(dir, 'rev-parse', `${parent}^{tree}`), parent }), null);
  const sha = await git.commitTree(dir, { message: 'feat: a', tree, parent });
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(sh(dir, 'rev-parse', `${sha}^{tree}`), tree);
  assert.equal(sh(dir, 'rev-parse', `${sha}^`), parent);
  // The index still has the parent's tree, so against the new HEAD a.txt shows as staged-deleted and untracked.
  assert.equal(sh(dir, 'status', '--porcelain'), 'D  a.txt\n?? a.txt');
  // The branch moved since the intent was recorded: update-ref refuses, so nothing is overwritten.
  await assert.rejects(git.commitTree(dir, { message: 'feat: again', tree, parent }));
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), sha);
});

// A clone of a bare origin with one commit on main, so ensureWorktree can fetch origin/main.
function cloneWithOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'ff-wt-'));
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  sh(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  return { root, mainRoot, sh };
}

test('ensureWorktree reuses the existing branch when the title (and so the derived branch) changed', async () => {
  const { root, mainRoot, sh } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-old-title', base: 'main' });
  const again = await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-new-title', base: 'main' });
  assert.equal(again.branch, 'ticket/4-old-title');
  assert.equal(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ticket/4-old-title');
});

// git reports canonical paths, so a repository reached through a junction, a symlinked TMPDIR or a Windows 8.3 name
// must still be recognised as itself.
test('ensureWorktree reuses its worktree when the repository is reached through a linked directory', async () => {
  const { root } = cloneWithOrigin();
  const link = `${root}-link`;
  symlinkSync(root, link, 'junction');
  try {
    const mainRoot = join(link, 'main');
    const path = join(link, 'wt', 'ticket-4');
    await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-title', base: 'main' });
    const again = await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-title', base: 'main' });
    assert.equal(again.branch, 'ticket/4-title');
  } finally {
    rmSync(link, { recursive: true, force: true }); // removes the link, not its target
  }
});

// From a worktree git answers with the canonical common dir; from the main checkout, relative to the spelling given.
test('repoInfo keeps the spelling it is given from the main checkout', async () => {
  const { root } = cloneWithOrigin();
  const link = `${root}-link`;
  symlinkSync(root, link, 'junction');
  try {
    const info = await git.repoInfo(join(link, 'main'));
    assert.equal(info.gitCommonDir, join(link, 'main', '.git'));
    assert.notEqual(realpathSync.native(info.gitCommonDir), info.gitCommonDir);
  } finally {
    rmSync(link, { recursive: true, force: true }); // removes the link, not its target
  }
});

test('ensureWorktree rejects a plain folder at the worktree path and names it', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  mkdirSync(path, { recursive: true });
  await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
});

test('cleanupMerged keeps a merged ticket worktree that has uncommitted changes', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  writeFileSync(join(path, 'unsaved.txt'), 'work');
  const logs = [];
  await git.cleanupMerged({ mainRoot }, {}, (m) => logs.push(m), { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'unsaved.txt')));
  assert.ok(logs.some((l) => l.includes('ticket/4-x')));
});

test('ensureWorktree rejects a plain folder that replaced a still-registered worktree', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
});

test('cleanupMerged keeps a merged worktree holding an ignored unsaved file', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  writeFileSync(join(path, '.gitignore'), 'secret.txt\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore'], { cwd: path });
  execFileSync('git', ['push', '-q', 'origin', 'ticket/4-x'], { cwd: path });
  writeFileSync(join(path, 'secret.txt'), 'work');
  await git.cleanupMerged({ mainRoot }, {}, () => {}, { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'secret.txt')));
});

test('cleanupMerged keeps an untracked file even when status.showUntrackedFiles=no', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: mainRoot });
  writeFileSync(join(path, 'unsaved.txt'), 'work');
  await git.cleanupMerged({ mainRoot }, {}, () => {}, { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'unsaved.txt')));
});

test('ticketBranches finds and discardBranch removes a ticket\'s branches, worktree or not, leaving other tickets alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-stuck-'));
  try {
    const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
    sh(root, 'clone', 'origin.git', 'main');
    const main = join(root, 'main');
    sh(main, 'commit', '--allow-empty', '-m', 'init');
    sh(main, 'push', 'origin', 'HEAD:main');
    sh(main, 'branch', 'ticket/7-with-wt');
    sh(main, 'branch', 'ticket/7-no-wt');
    sh(main, 'branch', 'ticket/70-other');
    sh(main, 'push', 'origin', 'ticket/7-no-wt');
    const wt = join(root, 'wt7');
    sh(main, 'worktree', 'add', wt, 'ticket/7-with-wt');

    const found = await git.ticketBranches(main, 7);
    assert.deepEqual(found.map((b) => b.branch).sort(), ['ticket/7-no-wt', 'ticket/7-with-wt']);
    for (const b of found) await git.discardBranch(main, b);

    assert.ok(!existsSync(wt));
    assert.deepEqual(await git.ticketBranches(main, 7), []);
    assert.equal(sh(main, 'ls-remote', '--heads', 'origin', 'ticket/7-no-wt').trim(), '');
    assert.equal((await git.ticketBranches(main, 70)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('after discardBranch, ensureWorktree starts the ticket again from the base branch, not the old attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-fresh-'));
  try {
    const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
    sh(root, 'clone', 'origin.git', 'main');
    const main = join(root, 'main');
    sh(main, 'commit', '--allow-empty', '-m', 'init');
    sh(main, 'push', 'origin', 'HEAD:main');
    const base = sh(main, 'rev-parse', 'HEAD');
    const opts = { mainRoot: main, path: join(root, 'wt7'), branch: 'ticket/7-thing', base: 'main' };
    const first = await git.ensureWorktree(opts);
    sh(first.path, 'commit', '--allow-empty', '-m', 'test: old attempt');
    assert.notEqual(sh(first.path, 'rev-parse', 'HEAD'), base);
    for (const b of await git.ticketBranches(main, 7)) await git.discardBranch(main, b);
    const second = await git.ensureWorktree(opts);
    assert.equal(sh(second.path, 'rev-parse', 'HEAD'), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stageAll, writeTree and commitStaged commit the recorded tree', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  assert.equal(await git.stageAll(dir), false);
  assert.equal(await git.commitStaged(dir, 'test: nothing'), null);
  writeFileSync(join(dir, 'a.txt'), 'a');
  assert.equal(await git.stageAll(dir), true);
  const tree = await git.writeTree(dir);
  assert.match(tree, /^[0-9a-f]{40}$/);
  const sha = await git.commitStaged(dir, 'test: add a');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(sh(dir, 'rev-parse', `${sha}^{tree}`), tree);
});

test('resetTo restores a recorded revision and cleans the worktree', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  const recorded = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'extra');
  writeFileSync(join(dir, 'untracked.txt'), 'u');
  mkdirSync(join(dir, 'newdir')); writeFileSync(join(dir, 'newdir', 'x.txt'), 'x');
  await git.resetTo(dir, recorded);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), recorded);
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(!existsSync(join(dir, 'a.txt')));
});

test('remoteSha reports the pushed sha or null', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  sh(dir, 'checkout', '-q', '-b', 'ticket/9-thing');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'work');
  await git.push(dir, 'ticket/9-thing');
  assert.equal(await git.remoteSha(dir, 'ticket/9-thing'), sh(dir, 'rev-parse', 'HEAD'));
  assert.equal(await git.remoteSha(dir, 'ticket/9-unknown'), null);
});

test('push publishes the given sha, not the branch tip', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  sh(dir, 'checkout', '-q', '-b', 'ticket/9-thing');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'checked');
  const checked = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'commit', '-q', '--amend', '--allow-empty', '-m', 'amended');
  await git.push(dir, 'ticket/9-thing', checked);
  assert.equal(await git.remoteSha(dir, 'ticket/9-thing'), checked);
});

test('remoteSha surfaces a fetch failure that is not a missing branch', async () => {
  const { root, mainRoot: dir, sh } = cloneWithOrigin();
  sh(dir, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
  await assert.rejects(git.remoteSha(dir, 'main'), (e) => e.message.includes('gone.git'));
});

test('push is called without -u, so no upstream is written to .git/config', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  sh(dir, 'checkout', '-q', '-b', 'ticket/9-thing');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'work');
  await git.push(dir, 'ticket/9-thing');
  assert.equal(sh(dir, 'ls-remote', '--heads', 'origin', 'ticket/9-thing').split('\t')[0], sh(dir, 'rev-parse', 'HEAD'));
  assert.equal(spawnSync('git', ['config', '--get', 'branch.ticket/9-thing.remote'], { cwd: dir }).status, 1);
});

test('a git write retries while index.lock is held and succeeds when it clears', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  const lock = join(dir, '.git', 'index.lock');
  writeFileSync(lock, '');
  writeFileSync(join(dir, 'a.txt'), 'a');
  setTimeout(() => rmSync(lock, { force: true }), 250);
  const sha = await git.commitAll(dir, 'test: add a');
  assert.ok(!existsSync(lock));
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'test: add a');
});

test('a git command allowed to fail still retries while index.lock is held', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  const lock = join(dir, '.git', 'index.lock');
  writeFileSync(lock, '');
  writeFileSync(join(dir, 'a.txt'), 'a');
  setTimeout(() => rmSync(lock, { force: true }), 250);
  const res = await git.runGit(['add', '-A'], { cwd: dir, allowFail: true });
  assert.equal(res.code, 0);
  assert.equal(sh(dir, 'diff', '--cached', '--name-only'), 'a.txt');
});

test('a git write surfaces the error when index.lock never clears', async () => {
  const { mainRoot: dir, sh } = cloneWithOrigin();
  const before = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, '.git', 'index.lock'), '');
  writeFileSync(join(dir, 'a.txt'), 'a');
  const started = Date.now();
  await assert.rejects(git.commitAll(dir, 'test: add a'), (e) => e.message.includes('index.lock'));
  assert.ok(Date.now() - started >= 1000, 'retried with backoff before giving up');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), before);
});
