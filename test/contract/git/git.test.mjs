// lib/git.mjs's contract: every case runs against the real module over temp repositories and against the fake git, so a
// verb whose fake drifts from git fails here. Cases the fake cannot model run on real git alone, at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as gitModule from '../../../lib/git.mjs';
import { pathKey } from '../../../lib/paths.mjs';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

// A clone of a bare origin with one empty commit on main, and the steps a case takes outside gg, in real git.
function realRepo(t) {
  const root = tempRoot(t);
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  sh(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  return {
    git: gitModule, root, mainRoot,
    commit: (dir, message) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '--allow-empty', '-m', message); return sh(dir, 'rev-parse', 'HEAD'); },
    amend: (dir, message) => { sh(dir, 'commit', '-q', '--amend', '--allow-empty', '-m', message); return sh(dir, 'rev-parse', 'HEAD'); },
    branch: (dir, name) => sh(dir, 'checkout', '-q', '-b', name),
    detach: (dir) => sh(dir, 'checkout', '-q', '--detach'),
    unstage: (dir) => sh(dir, 'reset', '-q'),
    breakOrigin: (dir) => { sh(dir, 'remote', 'set-url', 'origin', join(root, 'gone.git')); return 'gone.git'; },
  };
}

// The same, in the fake git's model.
async function fakeRepo(t) {
  const { fakeGit } = await import('../../support/fake-git.mjs');
  const root = tempRoot(t);
  const fake = fakeGit();
  const { mainRoot } = fake.init(root);
  return { git: fake.git, root, mainRoot, commit: fake.commit, amend: fake.amend, branch: fake.branch, detach: fake.detach, unstage: fake.unstage, breakOrigin: fake.breakOrigin };
}

for (const [name, repo] of [['real', realRepo], ['fake', fakeRepo]]) {
  const contract = (title, fn, options = {}) => test(`${title} (${name} git)`, options, async (t) => fn(await repo(t)));

  // Records the tree of a worktree that adds a.txt, as an intent would, and leaves the index at the parent's tree.
  const recordTree = async ({ git, mainRoot: dir, unstage }) => {
    const parent = await git.headSha(dir);
    const parentTree = await git.treeOf(dir, parent);
    writeFileSync(join(dir, 'a.txt'), 'a');
    await git.stageAll(dir);
    const tree = await git.writeTree(dir);
    unstage(dir);
    return { parent, parentTree, tree };
  };

  contract('commitTree commits a recorded tree on its parent, and nothing for the parent\'s own tree', async (repo) => {
    const { git, mainRoot: dir } = repo;
    const { parent, parentTree, tree } = await recordTree(repo);
    assert.equal(await git.commitTree(dir, { message: 'nothing', tree: parentTree, parent }), null);
    const sha = await git.commitTree(dir, { message: 'feat: a', tree, parent });
    assert.equal(await git.headSha(dir), sha);
    assert.equal(await git.treeOf(dir, sha), tree);
    assert.deepEqual((await git.commitLog(dir, 'main'))[0].parents, [parent]);
  });

  contract('commitTree leaves the index alone', async (repo) => {
    const { git, mainRoot: dir } = repo;
    const { parent, parentTree, tree } = await recordTree(repo);
    await git.commitTree(dir, { message: 'feat: a', tree, parent });
    // The index still has the parent's tree, so against the new HEAD a.txt is untracked.
    assert.equal(await git.writeTree(dir), parentTree);
    assert.deepEqual(await git.untrackedPaths(dir), ['a.txt']);
  });

  contract('commitTree refuses a branch that moved since the intent was recorded', async (repo) => {
    const { git, mainRoot: dir } = repo;
    const { parent, tree } = await recordTree(repo);
    const sha = await git.commitTree(dir, { message: 'feat: a', tree, parent });
    await assert.rejects(git.commitTree(dir, { message: 'feat: again', tree, parent }));
    assert.equal(await git.headSha(dir), sha, 'nothing is overwritten');
  });

  contract('ensureWorktree starts a new ticket branch from the base on origin', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    assert.deepEqual(await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-title', base: 'main' }), { path, branch: 'ticket/4-title' });
    assert.equal(await git.currentBranch(path), 'ticket/4-title');
    assert.equal(await git.headSha(path), await git.remoteSha(mainRoot, 'main'));
    assert.deepEqual((await git.listWorktrees(mainRoot)).map((w) => [pathKey(w.path), w.branch]),
      [[pathKey(mainRoot), 'main'], [pathKey(path), 'ticket/4-title']]);
  });

  contract('ensureWorktree reuses the existing branch when the title (and so the derived branch) changed', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-old-title', base: 'main' });
    const again = await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-new-title', base: 'main' });
    assert.equal(again.branch, 'ticket/4-old-title');
    assert.equal(await git.currentBranch(path), 'ticket/4-old-title');
  });

  // git reports canonical paths, so a repository reached through a junction, a symlinked TMPDIR or a Windows 8.3 name
  // must still be recognised as itself.
  contract('ensureWorktree reuses its worktree when the repository is reached through a linked directory', async ({ git, root }) => {
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
  contract('repoInfo keeps the spelling it is given from the main checkout', async ({ git, root }) => {
    const link = `${root}-link`;
    symlinkSync(root, link, 'junction');
    try {
      const info = await git.repoInfo(join(link, 'main'));
      assert.equal(info.gitCommonDir, join(link, 'main', '.git'));
      assert.equal(info.mainRoot, join(link, 'main'));
      assert.equal(info.name, 'main');
      assert.notEqual(realpathSync.native(info.gitCommonDir), info.gitCommonDir);
    } finally {
      rmSync(link, { recursive: true, force: true }); // removes the link, not its target
    }
  });

  contract('commonDir names the main checkout\'s git directory from a worktree', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
    assert.equal(pathKey(await git.commonDir(path)), pathKey(join(mainRoot, '.git')));
    assert.equal(pathKey((await git.repoInfo(path)).gitCommonDir), pathKey(join(mainRoot, '.git')));
  });

  contract('ensureWorktree rejects a plain folder at the worktree path and names it', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    mkdirSync(path, { recursive: true });
    await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
  });

  contract('ensureWorktree rejects a plain folder that replaced a still-registered worktree', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
  });

  contract('stageAll, writeTree and commitStaged commit the recorded tree', async ({ git, mainRoot: dir }) => {
    assert.equal(await git.stageAll(dir), false);
    assert.equal(await git.commitStaged(dir, 'test: nothing'), null);
    writeFileSync(join(dir, 'a.txt'), 'a');
    assert.equal(await git.stageAll(dir), true);
    const tree = await git.writeTree(dir);
    assert.match(tree, /^[0-9a-f]{40}$/);
    const sha = await git.commitStaged(dir, 'test: add a');
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(await git.headSha(dir), sha);
    assert.equal(await git.treeOf(dir, sha), tree);
    assert.equal(await git.treeOf(dir), tree);
  });

  contract('resetTo restores a recorded revision and cleans the worktree', async ({ git, mainRoot: dir, commit }) => {
    const recorded = await git.headSha(dir);
    const tree = await git.treeOf(dir, recorded);
    writeFileSync(join(dir, 'a.txt'), 'a');
    commit(dir, 'extra');
    writeFileSync(join(dir, 'untracked.txt'), 'u');
    mkdirSync(join(dir, 'newdir')); writeFileSync(join(dir, 'newdir', 'x.txt'), 'x');
    await git.resetTo(dir, recorded);
    assert.equal(await git.headSha(dir), recorded);
    assert.deepEqual(await git.fingerprint(dir), { head: recorded, index: tree, tree });
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all' }), []);
    assert.ok(!existsSync(join(dir, 'a.txt')));
    assert.ok(!existsSync(join(dir, 'newdir')));
  });

  contract('resetTo leaves ignored untracked files in place', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    const recorded = commit(dir, 'ignore');
    writeFileSync(join(dir, 'secret.txt'), 'work');
    await git.resetTo(dir, recorded);
    assert.ok(existsSync(join(dir, 'secret.txt')));
  });

  contract('remoteSha reports the pushed sha or null', async ({ git, mainRoot: dir, branch, commit }) => {
    branch(dir, 'ticket/9-thing');
    const sha = commit(dir, 'work');
    await git.push(dir, 'ticket/9-thing');
    assert.equal(await git.remoteSha(dir, 'ticket/9-thing'), sha);
    assert.equal(await git.remoteSha(dir, 'ticket/9-unknown'), null);
  });

  contract('push publishes the given sha, not the branch tip', async ({ git, mainRoot: dir, branch, commit, amend }) => {
    branch(dir, 'ticket/9-thing');
    const checked = commit(dir, 'checked');
    amend(dir, 'amended');
    await git.push(dir, 'ticket/9-thing', checked);
    assert.equal(await git.remoteSha(dir, 'ticket/9-thing'), checked);
  });

  contract('push refuses to move origin\'s branch to a commit that does not descend from it', async ({ git, mainRoot: dir, branch, commit, amend }) => {
    branch(dir, 'ticket/9-thing');
    const pushed = commit(dir, 'first');
    await git.push(dir, 'ticket/9-thing');
    const rewritten = amend(dir, 'rewritten');
    await assert.rejects(git.push(dir, 'ticket/9-thing', rewritten));
    assert.equal(await git.remoteSha(dir, 'ticket/9-thing'), pushed);
  });

  contract('remoteSha surfaces a fetch failure that is not a missing branch', async ({ git, mainRoot: dir, breakOrigin }) => {
    const named = breakOrigin(dir);
    await assert.rejects(git.remoteSha(dir, 'main'), (e) => e.message.includes(named));
  });

  contract('currentBranch names the checked-out branch, or null on a detached HEAD', async ({ git, mainRoot: dir, detach }) => {
    assert.equal(await git.currentBranch(dir), 'main');
    detach(dir);
    assert.equal(await git.currentBranch(dir), null);
  });

  contract('branchHead reads a local branch and rejects an unknown one', async ({ git, mainRoot: dir }) => {
    assert.equal(await git.branchHead(dir, 'main'), await git.headSha(dir));
    await assert.rejects(git.branchHead(dir, 'ticket/9-unknown'));
  });

  contract('hasTree tells a stored tree from an unknown one', async ({ git, mainRoot: dir }) => {
    assert.equal(await git.hasTree(dir, await git.treeOf(dir)), true);
    assert.equal(await git.hasTree(dir, 'e'.repeat(40)), false);
  });

  contract('commitLog lists the commits reachable from a branch, newest first, with parents, tree and message', async ({ git, mainRoot: dir, commit }) => {
    const init = await git.headSha(dir);
    writeFileSync(join(dir, 'a.txt'), 'a');
    const sha = commit(dir, 'one\n\nbody');
    assert.deepEqual(await git.commitLog(dir, 'main'), [
      { sha, parents: [init], tree: await git.treeOf(dir, sha), message: 'one\n\nbody' },
      { sha: init, parents: [], tree: await git.treeOf(dir, init), message: 'init' },
    ]);
  });

  contract('treeDiff names each path added, modified or deleted between two trees', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, 'kept.txt'), 'k'); writeFileSync(join(dir, 'gone.txt'), 'g');
    const from = await git.treeOf(dir, commit(dir, 'from'));
    writeFileSync(join(dir, 'kept.txt'), 'changed'); rmSync(join(dir, 'gone.txt')); writeFileSync(join(dir, 'new.txt'), 'n');
    const to = await git.treeOf(dir, commit(dir, 'to'));
    assert.deepEqual(await git.treeDiff(dir, from, to), [
      { path: 'gone.txt', change: 'deleted' }, { path: 'kept.txt', change: 'modified' }, { path: 'new.txt', change: 'added' },
    ]);
    assert.deepEqual(await git.treeDiff(dir, to, to), []);
  });

  contract('changedPaths lists the paths that differ between two revisions, within given paths when asked', async ({ git, mainRoot: dir, commit }) => {
    const from = await git.headSha(dir);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), 'a'); writeFileSync(join(dir, 'b.txt'), 'b');
    const to = commit(dir, 'two files');
    assert.deepEqual(await git.changedPaths(dir, from, to), ['b.txt', 'docs/a.md']);
    assert.deepEqual(await git.changedPaths(dir, from, to, { paths: ['docs'] }), ['docs/a.md']);
    writeFileSync(join(dir, 'c.txt'), 'c');
    await git.stageAll(dir);
    assert.deepEqual(await git.changedPaths(dir, to, await git.writeTree(dir)), ['c.txt']);
  });

  contract('changedSince lists the tracked paths the worktree changed since a revision, not untracked ones', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, 'a.txt'), 'a'); writeFileSync(join(dir, 'b.txt'), 'b');
    const rev = commit(dir, 'two files');
    writeFileSync(join(dir, 'a.txt'), 'changed'); rmSync(join(dir, 'b.txt')); writeFileSync(join(dir, 'c.txt'), 'c');
    assert.deepEqual(await git.changedSince(dir, rev), ['a.txt', 'b.txt']);
  });

  contract('untrackedPaths lists untracked files, the ignored ones only when asked, within given paths when asked', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\nbuild/\n');
    commit(dir, 'ignore');
    mkdirSync(join(dir, 'build')); mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'new.txt'), 'n'); writeFileSync(join(dir, 'secret.txt'), 's');
    writeFileSync(join(dir, 'build', 'out.js'), 'o'); writeFileSync(join(dir, 'docs', 'n.md'), 'd');
    assert.deepEqual(await git.untrackedPaths(dir), ['docs/n.md', 'new.txt']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'ignored' }), ['build/out.js', 'secret.txt']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all' }), ['build/out.js', 'docs/n.md', 'new.txt', 'secret.txt']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { paths: ['docs'] } }), ['docs/n.md']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { globs: ['**/*.js'] } }), ['build/out.js']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'ignored', within: { exclude: ['build/**'] } }), ['secret.txt']);
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { paths: ['docs'], globs: ['**/*.js'], exclude: ['build/**'] } }), ['docs/n.md']);
  });

  // A plain :(glob) pathspec ignores case on Windows and reports the pathspec's spelling; :(glob,icase) ignores it everywhere.
  contract('untrackedPaths within globs ignores case and reports each path as it is on disk', async ({ git, mainRoot: dir }) => {
    mkdirSync(join(dir, 'Spec')); mkdirSync(join(dir, 'deep')); mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'Spec', 'a.mjs'), 'a'); writeFileSync(join(dir, 'deep', 'B.TEST.mjs'), 'b'); writeFileSync(join(dir, 'node_modules', 'c.test.mjs'), 'c');
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { globs: ['spec/**', '**/*.test.*'], exclude: ['**/NODE_MODULES/**'] } }),
      ['Spec/a.mjs', 'deep/B.TEST.mjs']);
  });

  contract('untrackedPaths within a glob without a wildcard lists that path and what is under it', async ({ git, mainRoot: dir }) => {
    mkdirSync(join(dir, 'spec', 'unit'), { recursive: true }); mkdirSync(join(dir, 'specs'));
    writeFileSync(join(dir, 'spec', 'unit', 'a.mjs'), 'a'); writeFileSync(join(dir, 'specs', 'b.mjs'), 'b'); writeFileSync(join(dir, 'run.mjs'), 'r');
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { globs: ['spec', 'run.mjs'] } }), ['run.mjs', 'spec/unit/a.mjs']);
  });

  // Windows reads DOCS/ as docs/, so a protected path matches there whatever its case.
  contract('given paths match case-insensitively on Windows', async ({ git, mainRoot: dir }) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'n.md'), 'd');
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { paths: ['DOCS'] } }), ['docs/n.md']);
  }, { skip: process.platform !== 'win32' && 'Windows only' });

  contract('given paths match case-sensitively off Windows', async ({ git, mainRoot: dir }) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'n.md'), 'd');
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: { paths: ['DOCS'] } }), []);
  }, { skip: process.platform === 'win32' && 'not on Windows' });

  // A reset intent saved before #144 holds git pathspecs, and Reconciliation can still finish it after the upgrade.
  contract('untrackedPaths and changedPaths still take the pathspecs a reset intent saved before #144', async ({ git, mainRoot: dir, commit }) => {
    const from = await git.headSha(dir);
    mkdirSync(join(dir, 'build')); mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'build', 'out.js'), 'o'); writeFileSync(join(dir, 'docs', 'n.md'), 'd');
    assert.deepEqual(await git.untrackedPaths(dir, { include: 'all', within: [':(glob)**/*.js'] }), ['build/out.js']);
    const to = commit(dir, 'two files');
    assert.deepEqual(await git.changedPaths(dir, from, to, ['docs']), ['docs/n.md']);
  });

  contract('conflictedPaths is empty with no merge in progress', async ({ git, mainRoot: dir }) => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    assert.deepEqual(await git.conflictedPaths(dir), []);
  });

  contract('diffSummary is empty for a clean worktree and names each changed tracked file', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    commit(dir, 'a');
    assert.equal(await git.diffSummary(dir), '');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    assert.match(await git.diffSummary(dir), /a\.txt/);
  });

  contract('branchDiff shows what HEAD changed since it left the base', async ({ git, mainRoot: dir, branch, commit }) => {
    branch(dir, 'ticket/9-thing');
    assert.equal(await git.branchDiff(dir, 'main'), '');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    commit(dir, 'a');
    const diff = await git.branchDiff(dir, 'main');
    assert.match(diff, /a\.txt/);
    assert.match(diff, /^\+hello$/m);
  });

  contract('diffStats counts insertions and deletions per file since the base, a binary file as null', async ({ git, mainRoot: dir, branch, commit }) => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    commit(dir, 'a');
    branch(dir, 'ticket/9-thing');
    writeFileSync(join(dir, 'a.txt'), 'one\nthree\nfour\n');
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2, 0]));
    commit(dir, 'change');
    assert.deepEqual(await git.diffStats(dir, 'main'), [
      { path: 'a.txt', insertions: 2, deletions: 1 }, { path: 'b.bin', insertions: null, deletions: null },
    ]);
  });

  contract('fingerprint reads the head, the index and a tree of every file that is not ignored', async ({ git, mainRoot: dir, commit }) => {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    const head = commit(dir, 'ignore');
    const tree = await git.treeOf(dir, head);
    assert.deepEqual(await git.fingerprint(dir), { head, index: tree, tree });
    writeFileSync(join(dir, 'secret.txt'), 's');
    assert.deepEqual(await git.fingerprint(dir), { head, index: tree, tree });
    writeFileSync(join(dir, 'new.txt'), 'n');
    const withNew = await git.fingerprint(dir);
    assert.equal(withNew.index, tree);
    assert.notEqual(withNew.tree, tree);
    await git.stageAll(dir);
    assert.deepEqual(await git.fingerprint(dir), { head, index: withNew.tree, tree: withNew.tree });
  });
}

// What the fake does not model: git's own files, locks and merges.

test('a push writes no upstream into .git/config', async (t) => {
  const { mainRoot: dir, branch, commit } = realRepo(t);
  branch(dir, 'ticket/9-thing');
  commit(dir, 'work');
  await gitModule.push(dir, 'ticket/9-thing');
  assert.equal(sh(dir, 'ls-remote', '--heads', 'origin', 'ticket/9-thing').split('\t')[0], sh(dir, 'rev-parse', 'HEAD'));
  assert.equal(spawnSync('git', ['config', '--get', 'branch.ticket/9-thing.remote'], { cwd: dir }).status, 1);
});

// Each index.lock wait is recorded and runs `during` in place of the wait.
function recordWaits(t, during = () => {}) {
  const waits = [];
  const previous = gitModule.setSleep(async (ms) => { waits.push(ms); during(); });
  t.after(() => gitModule.setSleep(previous));
  return waits;
}

test('a git write retries while index.lock is held and succeeds when it clears', async (t) => {
  const { mainRoot: dir } = realRepo(t);
  const lock = join(dir, '.git', 'index.lock');
  writeFileSync(lock, '');
  writeFileSync(join(dir, 'a.txt'), 'a');
  const waits = recordWaits(t, () => rmSync(lock, { force: true }));
  assert.equal(await gitModule.stageAll(dir), true);
  assert.deepEqual(waits, [100], 'one wait, after which the lock had cleared');
  const sha = await gitModule.commitStaged(dir, 'test: add a');
  assert.ok(!existsSync(lock));
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'test: add a');
});

test('a git write surfaces the error when index.lock never clears', async (t) => {
  const { mainRoot: dir } = realRepo(t);
  const before = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, '.git', 'index.lock'), '');
  writeFileSync(join(dir, 'a.txt'), 'a');
  const waits = recordWaits(t);
  await assert.rejects(gitModule.stageAll(dir), (e) => e.message.includes('index.lock'));
  assert.deepEqual(waits, [100, 200, 400, 800], 'retried with backoff before giving up');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), before);
});

test('conflictedPaths names each path of a merge conflict once', async (t) => {
  const { mainRoot: dir, branch, commit } = realRepo(t);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  commit(dir, 'base');
  branch(dir, 'other');
  writeFileSync(join(dir, 'a.txt'), 'other\n');
  commit(dir, 'other');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  commit(dir, 'main');
  assert.equal(spawnSync('git', ['merge', '-q', 'other'], { cwd: dir }).status, 1);
  assert.deepEqual(await gitModule.conflictedPaths(dir), ['a.txt']);
});
