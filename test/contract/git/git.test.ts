// lib/git.ts's contract: every case runs against the real module over temp repositories and against the fake git, so a
// verb whose fake drifts from git fails here. Cases the fake cannot model run on real git alone, at the end.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as gitModule from '../../../lib/git.ts';
import * as paths from '../../../lib/paths.ts';
import type * as fakeGitModule from '../../support/fake-git.ts';
import * as templateRepos from '../../support/template-repos.ts';
import * as gitShell from '../../support/git-shell.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

// A repository and the steps a case takes outside gg, in one git or the other.
interface Repo {
  git: gitModule.Git | fakeGitModule.FakeGit['git'];
  root: string;
  mainRoot: string;
  commit: (directory: string, message: string) => string;
  amend: (directory: string, message: string) => string;
  branch: (directory: string, name: string) => unknown;
  detach: (directory: string) => unknown;
  unstage: (directory: string) => unknown;
  breakOrigin: (directory: string) => string;
}

// A copy of the template's bare origin and its clone, with one commit on main, and the steps a case takes outside gg,
// in real git.
function realRepo(t: TestContext): Repo {
  const root = tempDirectory.tempDirectory(t, 'gg-git-');
  templateRepos.seedRepos(root);
  const mainRoot = join(root, 'main');
  return {
    git: gitModule,
    root,
    mainRoot,
    commit: (directory: string, message: string) => {
      gitShell.sh(directory, 'add', '-A');
      gitShell.sh(directory, 'commit', '-q', '--allow-empty', '-m', message);
      return gitShell.sh(directory, 'rev-parse', 'HEAD');
    },
    amend: (directory: string, message: string) => {
      gitShell.sh(directory, 'commit', '-q', '--amend', '--allow-empty', '-m', message);
      return gitShell.sh(directory, 'rev-parse', 'HEAD');
    },
    branch: (directory: string, name: string) => gitShell.sh(directory, 'checkout', '-q', '-b', name),
    detach: (directory: string) => gitShell.sh(directory, 'checkout', '-q', '--detach'),
    unstage: (directory: string) => gitShell.sh(directory, 'reset', '-q'),
    breakOrigin: (directory: string) => {
      gitShell.sh(directory, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
      return 'gone.git';
    },
  };
}

// The same, in the fake git's model.
async function fakeRepo(t: TestContext): Promise<Repo> {
  const { fakeGit } = await import('../../support/fake-git.ts');
  const root = tempDirectory.tempDirectory(t, 'gg-git-');
  const fake = fakeGit();
  const { mainRoot } = fake.init(root);
  return {
    git: fake.git,
    root,
    mainRoot,
    commit: fake.commit,
    amend: fake.amend,
    branch: fake.branch,
    detach: fake.detach,
    unstage: fake.unstage,
    breakOrigin: fake.breakOrigin,
  };
}

const sides: [string, (t: TestContext) => Repo | Promise<Repo>][] = [
  ['real', realRepo],
  ['fake', fakeRepo],
];
for (const [name, repo] of sides) {
  const contract = (title: string, run: (repo: Repo) => Promise<void>, options = {}) =>
    test(`${title} (${name} git)`, options, async (t) => run(await repo(t)));

  // Records the tree of a worktree that adds a.txt, as an intent would, and leaves the index at the parent's tree.
  const recordTree = async ({ git, mainRoot: directory, unstage }: Repo) => {
    const parent = await git.headSha(directory);
    const parentTree = await git.treeOf(directory, parent);
    writeFileSync(join(directory, 'a.txt'), 'a');
    await git.stageAll(directory);
    const tree = await git.writeTree(directory);
    unstage(directory);
    return { parent, parentTree, tree };
  };

  contract("commitTree commits a recorded tree on its parent, and nothing for the parent's own tree", async (repo) => {
    const { git, mainRoot: directory } = repo;
    const { parent, parentTree, tree } = await recordTree(repo);
    assert.equal(await git.commitTree(directory, { message: 'nothing', tree: parentTree, parent }), null);
    const sha = await git.commitTree(directory, { message: 'feat: a', tree, parent });
    assert.equal(await git.headSha(directory), sha);
    assert.equal(await git.treeOf(directory, sha as string), tree);
    assert.deepEqual((await git.commitLog(directory, 'main'))[0].parents, [parent]);
  });

  contract('commitTree leaves the index alone', async (repo) => {
    const { git, mainRoot: directory } = repo;
    const { parent, parentTree, tree } = await recordTree(repo);
    await git.commitTree(directory, { message: 'feat: a', tree, parent });
    // The index still has the parent's tree, so against the new HEAD a.txt is untracked.
    assert.equal(await git.writeTree(directory), parentTree);
    assert.deepEqual(await git.untrackedPaths(directory), ['a.txt']);
  });

  contract('commitTree refuses a branch that moved since the intent was recorded', async (repo) => {
    const { git, mainRoot: directory } = repo;
    const { parent, tree } = await recordTree(repo);
    const sha = await git.commitTree(directory, { message: 'feat: a', tree, parent });
    await assert.rejects(git.commitTree(directory, { message: 'feat: again', tree, parent }), /cannot lock ref 'HEAD'/);
    assert.equal(await git.headSha(directory), sha, 'nothing is overwritten');
  });

  // A tracked file changed, a new file, an ignored file within and one without.
  const leftWork = (repo: Repo) => {
    const { mainRoot: directory } = repo;
    writeFileSync(join(directory, '.gitignore'), 'kept/\nother.log\n');
    writeFileSync(join(directory, 'tracked.txt'), 'before');
    repo.commit(directory, 'tracked');
    writeFileSync(join(directory, 'tracked.txt'), 'after');
    writeFileSync(join(directory, 'new.txt'), 'new');
    mkdirSync(join(directory, 'kept'));
    writeFileSync(join(directory, 'kept', 'test.txt'), 'ignored within');
    writeFileSync(join(directory, 'other.log'), 'ignored without');
  };

  contract(
    'rescueTree holds tracked, untracked and the ignored files within, and rescueCommit commits it on HEAD',
    async (repo) => {
      const { git, mainRoot: directory } = repo;
      leftWork(repo);
      const parent = await git.headSha(directory);
      const tree = await git.rescueTree(directory, { within: { paths: ['kept/'] } });
      const commit = await git.rescueCommit(directory, { tree, parent, message: 'rescue' });
      assert.equal(await git.treeOf(directory, commit), tree);
      assert.deepEqual((await git.changedPaths(directory, parent, commit)).sort(), [
        'kept/test.txt',
        'new.txt',
        'tracked.txt',
      ]);
      assert.equal((await git.commitLog(directory, commit))[0]!.parents[0], parent);
    },
  );

  contract('rescueTree and rescueCommit leave HEAD, the index and the worktree alone', async (repo) => {
    const { git, mainRoot: directory } = repo;
    leftWork(repo);
    const parent = await git.headSha(directory);
    const index = await git.writeTree(directory);
    const tree = await git.rescueTree(directory, { within: { paths: ['kept/'] } });
    await git.rescueCommit(directory, { tree, parent, message: 'rescue' });
    assert.equal(await git.headSha(directory), parent);
    assert.equal(await git.writeTree(directory), index);
    assert.deepEqual(await git.untrackedPaths(directory), ['new.txt']);
  });

  contract('rescueTree of the same worktree is the same tree', async (repo) => {
    const { git, mainRoot: directory } = repo;
    leftWork(repo);
    const within = { paths: ['kept/'] };
    assert.equal(await git.rescueTree(directory, { within }), await git.rescueTree(directory, { within }));
  });

  contract('createRef makes a ref only when absent, and refTarget reads it', async (repo) => {
    const { git, mainRoot: directory } = repo;
    const first = await git.headSha(directory);
    const second = repo.commit(directory, 'second');
    const ref = 'refs/gg/rescue/abc';
    assert.equal(await git.refTarget(directory, ref), null);
    assert.equal(await git.createRef(directory, ref, first), true);
    assert.equal(await git.createRef(directory, ref, second), false);
    assert.equal(await git.refTarget(directory, ref), first, 'nothing is overwritten');
    assert.equal(await git.treeOf(directory, ref), await git.treeOf(directory, first));
  });

  contract('diffStats reads as far as a commit given in place of HEAD', async (repo) => {
    const { git, mainRoot: directory } = repo;
    leftWork(repo);
    const parent = await git.headSha(directory);
    const tree = await git.rescueTree(directory, {});
    const commit = await git.rescueCommit(directory, { tree, parent, message: 'rescue' });
    assert.deepEqual((await git.diffStats(directory, parent, commit)).map((file) => file.path).sort(), [
      'new.txt',
      'tracked.txt',
    ]);
  });

  contract('ensureWorktree starts a new ticket branch from the base on origin', async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    assert.deepEqual(await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-title', base: 'main' }), {
      path,
      branch: 'ticket/4-title',
    });
    assert.equal(await git.currentBranch(path), 'ticket/4-title');
    assert.equal(await git.headSha(path), await git.remoteSha(mainRoot, 'main'));
    assert.deepEqual(
      (await git.listWorktrees(mainRoot)).map((worktree) => [paths.pathKey(worktree.path), worktree.branch]),
      [
        [paths.pathKey(mainRoot), 'main'],
        [paths.pathKey(path), 'ticket/4-title'],
      ],
    );
  });

  contract(
    'ensureWorktree reuses the existing branch when the title (and so the derived branch) changed',
    async ({ git, root, mainRoot }) => {
      const path = join(root, 'wt', 'ticket-4');
      await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-old-title', base: 'main' });
      const again = await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-new-title', base: 'main' });
      assert.equal(again.branch, 'ticket/4-old-title');
      assert.equal(await git.currentBranch(path), 'ticket/4-old-title');
    },
  );

  // git reports canonical paths, so a repository reached through a junction, a symlinked TMPDIR or a Windows 8.3 name
  // must still be recognised as itself.
  contract(
    'ensureWorktree reuses its worktree when the repository is reached through a linked directory',
    async ({ git, root }) => {
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
    },
  );

  // From a worktree git answers with the canonical common directory; from the main checkout, relative to the spelling
  // given.
  contract('repoInfo keeps the spelling it is given from the main checkout', async ({ git, root }) => {
    const link = `${root}-link`;
    symlinkSync(root, link, 'junction');
    try {
      const info = await git.repoInfo(join(link, 'main'));
      assert.equal(info.gitCommonDir, join(link, 'main', '.git'));
      assert.equal(info.mainRoot, join(link, 'main'));
      assert.equal(info.folder, 'main');
      assert.notEqual(realpathSync.native(info.gitCommonDir), info.gitCommonDir);
    } finally {
      rmSync(link, { recursive: true, force: true }); // removes the link, not its target
    }
  });

  contract("commonDir names the main checkout's git directory from a worktree", async ({ git, root, mainRoot }) => {
    const path = join(root, 'wt', 'ticket-4');
    await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
    assert.equal(paths.pathKey(await git.commonDir(path)), paths.pathKey(join(mainRoot, '.git')));
    assert.equal(paths.pathKey((await git.repoInfo(path)).gitCommonDir), paths.pathKey(join(mainRoot, '.git')));
  });

  contract(
    'ensureWorktree rejects a plain folder at the worktree path and names it',
    async ({ git, root, mainRoot }) => {
      const path = join(root, 'wt', 'ticket-4');
      mkdirSync(path, { recursive: true });
      await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (err: Error) =>
        err.message.includes(path),
      );
    },
  );

  contract(
    'ensureWorktree rejects a plain folder that replaced a still-registered worktree',
    async ({ git, root, mainRoot }) => {
      const path = join(root, 'wt', 'ticket-4');
      await git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      await assert.rejects(git.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (err: Error) =>
        err.message.includes(path),
      );
    },
  );

  contract('stageAll, writeTree and commitStaged commit the recorded tree', async ({ git, mainRoot: directory }) => {
    assert.equal(await git.stageAll(directory), false);
    assert.equal(await git.commitStaged(directory, 'test: nothing'), null);
    writeFileSync(join(directory, 'a.txt'), 'a');
    assert.equal(await git.stageAll(directory), true);
    const tree = await git.writeTree(directory);
    assert.match(tree, /^[0-9a-f]{40}$/);
    const sha = (await git.commitStaged(directory, 'test: add a')) as string;
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(await git.headSha(directory), sha);
    assert.equal(await git.treeOf(directory, sha), tree);
    assert.equal(await git.treeOf(directory), tree);
  });

  contract(
    'resetTo restores a recorded revision and cleans the worktree',
    async ({ git, mainRoot: directory, commit }) => {
      const recorded = await git.headSha(directory);
      const tree = await git.treeOf(directory, recorded);
      writeFileSync(join(directory, 'a.txt'), 'a');
      commit(directory, 'extra');
      writeFileSync(join(directory, 'untracked.txt'), 'u');
      mkdirSync(join(directory, 'newdir'));
      writeFileSync(join(directory, 'newdir', 'x.txt'), 'x');
      await git.resetTo(directory, recorded);
      assert.equal(await git.headSha(directory), recorded);
      assert.deepEqual(await git.fingerprint(directory), { head: recorded, index: tree, tree });
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all' }), []);
      assert.ok(!existsSync(join(directory, 'a.txt')));
      assert.ok(!existsSync(join(directory, 'newdir')));
    },
  );

  contract('resetTo leaves ignored untracked files in place', async ({ git, mainRoot: directory, commit }) => {
    writeFileSync(join(directory, '.gitignore'), 'secret.txt\n');
    const recorded = commit(directory, 'ignore');
    writeFileSync(join(directory, 'secret.txt'), 'work');
    await git.resetTo(directory, recorded);
    assert.ok(existsSync(join(directory, 'secret.txt')));
  });

  contract('remoteSha reports the pushed sha or null', async ({ git, mainRoot: directory, branch, commit }) => {
    branch(directory, 'ticket/9-thing');
    const sha = commit(directory, 'work');
    await git.push(directory, 'ticket/9-thing');
    assert.equal(await git.remoteSha(directory, 'ticket/9-thing'), sha);
    assert.equal(await git.remoteSha(directory, 'ticket/9-unknown'), null);
  });

  contract(
    'push publishes the given sha, not the branch tip',
    async ({ git, mainRoot: directory, branch, commit, amend }) => {
      branch(directory, 'ticket/9-thing');
      const checked = commit(directory, 'checked');
      amend(directory, 'amended');
      await git.push(directory, 'ticket/9-thing', checked);
      assert.equal(await git.remoteSha(directory, 'ticket/9-thing'), checked);
    },
  );

  contract(
    "push refuses to move origin's branch to a commit that does not descend from it",
    async ({ git, mainRoot: directory, branch, commit, amend }) => {
      branch(directory, 'ticket/9-thing');
      const pushed = commit(directory, 'first');
      await git.push(directory, 'ticket/9-thing');
      const rewritten = amend(directory, 'rewritten');
      await assert.rejects(git.push(directory, 'ticket/9-thing', rewritten), /non-fast-forward/);
      assert.equal(await git.remoteSha(directory, 'ticket/9-thing'), pushed);
    },
  );

  contract(
    'remoteSha surfaces a fetch failure that is not a missing branch',
    async ({ git, mainRoot: directory, breakOrigin }) => {
      const named = breakOrigin(directory);
      await assert.rejects(git.remoteSha(directory, 'main'), (err: Error) => err.message.includes(named));
    },
  );

  contract(
    'currentBranch names the checked-out branch, or null on a detached HEAD',
    async ({ git, mainRoot: directory, detach }) => {
      assert.equal(await git.currentBranch(directory), 'main');
      detach(directory);
      assert.equal(await git.currentBranch(directory), null);
    },
  );

  contract(
    "defaultBranch names origin's default branch, whichever branch the main checkout is on",
    async ({ git, mainRoot: directory, branch }) => {
      branch(directory, 'feature/setup');
      assert.equal(await git.defaultBranch(directory), 'main');
    },
  );

  contract(
    'defaultBranch falls back to the checked-out branch when origin cannot say, and refuses a detached HEAD',
    async ({ git, mainRoot: directory, branch, breakOrigin, detach }) => {
      breakOrigin(directory);
      branch(directory, 'trunk');
      assert.equal(await git.defaultBranch(directory), 'trunk');
      detach(directory);
      await assert.rejects(git.defaultBranch(directory), /cannot tell the default branch/);
    },
  );

  contract('branchHead reads a local branch and rejects an unknown one', async ({ git, mainRoot: directory }) => {
    assert.equal(await git.branchHead(directory, 'main'), await git.headSha(directory));
    await assert.rejects(git.branchHead(directory, 'ticket/9-unknown'), /unknown revision/);
  });

  contract('hasTree tells a stored tree from an unknown one', async ({ git, mainRoot: directory }) => {
    assert.equal(await git.hasTree(directory, await git.treeOf(directory)), true);
    assert.equal(await git.hasTree(directory, 'e'.repeat(40)), false);
  });

  contract(
    'commitLog lists the commits reachable from a branch, newest first, with parents, tree and message',
    async ({ git, mainRoot: directory, commit }) => {
      const init = await git.headSha(directory);
      writeFileSync(join(directory, 'a.txt'), 'a');
      const sha = commit(directory, 'one\n\nbody');
      assert.deepEqual(await git.commitLog(directory, 'main'), [
        { sha, parents: [init], tree: await git.treeOf(directory, sha), message: 'one\n\nbody' },
        { sha: init, parents: [], tree: await git.treeOf(directory, init), message: 'init' },
      ]);
    },
  );

  contract(
    'treeDiff names each path added, modified or deleted between two trees',
    async ({ git, mainRoot: directory, commit }) => {
      writeFileSync(join(directory, 'kept.txt'), 'k');
      writeFileSync(join(directory, 'gone.txt'), 'g');
      const from = await git.treeOf(directory, commit(directory, 'from'));
      writeFileSync(join(directory, 'kept.txt'), 'changed');
      rmSync(join(directory, 'gone.txt'));
      writeFileSync(join(directory, 'new.txt'), 'n');
      const to = await git.treeOf(directory, commit(directory, 'to'));
      assert.deepEqual(await git.treeDiff(directory, from, to), [
        { path: 'gone.txt', change: 'deleted' },
        { path: 'kept.txt', change: 'modified' },
        { path: 'new.txt', change: 'added' },
      ]);
      assert.deepEqual(await git.treeDiff(directory, to, to), []);
    },
  );

  contract(
    'changedPaths lists the paths that differ between two revisions, within given paths when asked',
    async ({ git, mainRoot: directory, commit }) => {
      const from = await git.headSha(directory);
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'docs', 'a.md'), 'a');
      writeFileSync(join(directory, 'b.txt'), 'b');
      const to = commit(directory, 'two files');
      assert.deepEqual(await git.changedPaths(directory, from, to), ['b.txt', 'docs/a.md']);
      assert.deepEqual(await git.changedPaths(directory, from, to, { paths: ['docs'] }), ['docs/a.md']);
      writeFileSync(join(directory, 'c.txt'), 'c');
      await git.stageAll(directory);
      assert.deepEqual(await git.changedPaths(directory, to, await git.writeTree(directory)), ['c.txt']);
    },
  );

  contract(
    'changedSince lists the tracked paths the worktree changed since a revision, not untracked ones',
    async ({ git, mainRoot: directory, commit }) => {
      writeFileSync(join(directory, 'a.txt'), 'a');
      writeFileSync(join(directory, 'b.txt'), 'b');
      const rev = commit(directory, 'two files');
      writeFileSync(join(directory, 'a.txt'), 'changed');
      rmSync(join(directory, 'b.txt'));
      writeFileSync(join(directory, 'c.txt'), 'c');
      assert.deepEqual(await git.changedSince(directory, rev), ['a.txt', 'b.txt']);
    },
  );

  contract(
    'untrackedPaths lists untracked files, the ignored ones only when asked, within given paths when asked',
    async ({ git, mainRoot: directory, commit }) => {
      writeFileSync(join(directory, '.gitignore'), 'secret.txt\nbuild/\n');
      commit(directory, 'ignore');
      mkdirSync(join(directory, 'build'));
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'new.txt'), 'n');
      writeFileSync(join(directory, 'secret.txt'), 's');
      writeFileSync(join(directory, 'build', 'out.js'), 'o');
      writeFileSync(join(directory, 'docs', 'n.md'), 'd');
      assert.deepEqual(await git.untrackedPaths(directory), ['docs/n.md', 'new.txt']);
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'ignored' }), ['build/out.js', 'secret.txt']);
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all' }), [
        'build/out.js',
        'docs/n.md',
        'new.txt',
        'secret.txt',
      ]);
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all', within: { paths: ['docs'] } }), [
        'docs/n.md',
      ]);
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all', within: { globs: ['**/*.js'] } }), [
        'build/out.js',
      ]);
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'ignored', within: { exclude: ['build/**'] } }), [
        'secret.txt',
      ]);
      assert.deepEqual(
        await git.untrackedPaths(directory, {
          include: 'all',
          within: { paths: ['docs'], globs: ['**/*.js'], exclude: ['build/**'] },
        }),
        ['docs/n.md'],
      );
    },
  );

  // A plain :(glob) pathspec ignores case on Windows and reports the pathspec's spelling; :(glob,icase) ignores it
  // everywhere.
  contract(
    'untrackedPaths within globs ignores case and reports each path as it is on disk',
    async ({ git, mainRoot: directory }) => {
      mkdirSync(join(directory, 'Spec'));
      mkdirSync(join(directory, 'deep'));
      mkdirSync(join(directory, 'node_modules'));
      writeFileSync(join(directory, 'Spec', 'a.mjs'), 'a');
      writeFileSync(join(directory, 'deep', 'B.TEST.mjs'), 'b');
      writeFileSync(join(directory, 'node_modules', 'c.test.mjs'), 'c');
      assert.deepEqual(
        await git.untrackedPaths(directory, {
          include: 'all',
          within: { globs: ['spec/**', '**/*.test.*'], exclude: ['**/NODE_MODULES/**'] },
        }),
        ['Spec/a.mjs', 'deep/B.TEST.mjs'],
      );
    },
  );

  contract(
    'untrackedPaths within a glob without a wildcard lists that path and what is under it',
    async ({ git, mainRoot: directory }) => {
      mkdirSync(join(directory, 'spec', 'unit'), { recursive: true });
      mkdirSync(join(directory, 'specs'));
      writeFileSync(join(directory, 'spec', 'unit', 'a.mjs'), 'a');
      writeFileSync(join(directory, 'specs', 'b.mjs'), 'b');
      writeFileSync(join(directory, 'run.mjs'), 'r');
      assert.deepEqual(
        await git.untrackedPaths(directory, { include: 'all', within: { globs: ['spec', 'run.mjs'] } }),
        ['run.mjs', 'spec/unit/a.mjs'],
      );
    },
  );

  // Windows reads DOCS/ as docs/, so a protected path matches there whatever its case.
  contract(
    'given paths match case-insensitively on Windows',
    async ({ git, mainRoot: directory }) => {
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'docs', 'n.md'), 'd');
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all', within: { paths: ['DOCS'] } }), [
        'docs/n.md',
      ]);
    },
    { skip: process.platform !== 'win32' && 'Windows only' },
  );

  contract(
    'given paths match case-sensitively off Windows',
    async ({ git, mainRoot: directory }) => {
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'docs', 'n.md'), 'd');
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all', within: { paths: ['DOCS'] } }), []);
    },
    { skip: process.platform === 'win32' && 'not on Windows' },
  );

  // A reset intent saved before #144 holds git pathspecs, and Reconciliation can still finish it after the upgrade.
  contract(
    'untrackedPaths and changedPaths still take the pathspecs a reset intent saved before #144',
    async ({ git, mainRoot: directory, commit }) => {
      const from = await git.headSha(directory);
      mkdirSync(join(directory, 'build'));
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'build', 'out.js'), 'o');
      writeFileSync(join(directory, 'docs', 'n.md'), 'd');
      assert.deepEqual(await git.untrackedPaths(directory, { include: 'all', within: [':(glob)**/*.js'] }), [
        'build/out.js',
      ]);
      const to = commit(directory, 'two files');
      assert.deepEqual(await git.changedPaths(directory, from, to, ['docs']), ['docs/n.md']);
    },
  );

  contract('conflictedPaths is empty with no merge in progress', async ({ git, mainRoot: directory }) => {
    writeFileSync(join(directory, 'a.txt'), 'a');
    assert.deepEqual(await git.conflictedPaths(directory), []);
  });

  contract(
    'diffSummary is empty for a clean worktree and names each changed tracked file',
    async ({ git, mainRoot: directory, commit }) => {
      writeFileSync(join(directory, 'a.txt'), 'a');
      commit(directory, 'a');
      assert.equal(await git.diffSummary(directory), '');
      writeFileSync(join(directory, 'a.txt'), 'changed');
      assert.match(await git.diffSummary(directory), /a\.txt/);
    },
  );

  contract(
    'branchDiff shows what HEAD changed since it left the base',
    async ({ git, mainRoot: directory, branch, commit }) => {
      branch(directory, 'ticket/9-thing');
      assert.equal(await git.branchDiff(directory, 'main'), '');
      writeFileSync(join(directory, 'a.txt'), 'hello\n');
      commit(directory, 'a');
      const diff = await git.branchDiff(directory, 'main');
      assert.match(diff, /a\.txt/);
      assert.match(diff, /^\+hello$/m);
    },
  );

  contract(
    'diffStats counts insertions and deletions per file since the base, a binary file as null',
    async ({ git, mainRoot: directory, branch, commit }) => {
      writeFileSync(join(directory, 'a.txt'), 'one\ntwo\n');
      commit(directory, 'a');
      branch(directory, 'ticket/9-thing');
      writeFileSync(join(directory, 'a.txt'), 'one\nthree\nfour\n');
      writeFileSync(join(directory, 'b.bin'), Buffer.from([0, 1, 2, 0]));
      commit(directory, 'change');
      assert.deepEqual(await git.diffStats(directory, 'main'), [
        { path: 'a.txt', insertions: 2, deletions: 1 },
        { path: 'b.bin', insertions: null, deletions: null },
      ]);
    },
  );

  contract(
    'diffStats gives a non-ASCII path unquoted and a rename as its removed and added paths',
    async ({ git, mainRoot: directory, branch, commit }) => {
      mkdirSync(join(directory, 'test'));
      writeFileSync(join(directory, 'test', 'café.mjs'), 'a\n');
      writeFileSync(join(directory, 'test', 'old.mjs'), 'one\ntwo\nthree\n');
      commit(directory, 'tests');
      branch(directory, 'ticket/9-thing');
      writeFileSync(join(directory, 'test', 'café.mjs'), 'a\nb\n');
      rmSync(join(directory, 'test', 'old.mjs'));
      writeFileSync(join(directory, 'test', 'new.mjs'), 'one\ntwo\nthree\n');
      commit(directory, 'rename');
      assert.deepEqual(await git.diffStats(directory, 'main'), [
        { path: 'test/café.mjs', insertions: 1, deletions: 0 },
        { path: 'test/new.mjs', insertions: 3, deletions: 0 },
        { path: 'test/old.mjs', insertions: 0, deletions: 3 },
      ]);
    },
  );

  contract(
    'fingerprint reads the head, the index and a tree of every file that is not ignored',
    async ({ git, mainRoot: directory, commit }) => {
      writeFileSync(join(directory, '.gitignore'), 'secret.txt\n');
      const head = commit(directory, 'ignore');
      const tree = await git.treeOf(directory, head);
      assert.deepEqual(await git.fingerprint(directory), { head, index: tree, tree });
      writeFileSync(join(directory, 'secret.txt'), 's');
      assert.deepEqual(await git.fingerprint(directory), { head, index: tree, tree });
      writeFileSync(join(directory, 'new.txt'), 'n');
      const withNew = await git.fingerprint(directory);
      assert.equal(withNew.index, tree);
      assert.notEqual(withNew.tree, tree);
      await git.stageAll(directory);
      assert.deepEqual(await git.fingerprint(directory), { head, index: withNew.tree, tree: withNew.tree });
    },
  );
}

// What the fake does not model: git's own files, locks and merges.

test('a push writes no upstream into .git/config', async (t) => {
  const { mainRoot: directory, branch, commit } = realRepo(t);
  branch(directory, 'ticket/9-thing');
  commit(directory, 'work');
  await gitModule.push(directory, 'ticket/9-thing');
  assert.equal(
    gitShell.sh(directory, 'ls-remote', '--heads', 'origin', 'ticket/9-thing').split('\t')[0],
    gitShell.sh(directory, 'rev-parse', 'HEAD'),
  );
  assert.equal(spawnSync('git', ['config', '--get', 'branch.ticket/9-thing.remote'], { cwd: directory }).status, 1);
});

// git trusts an entry's cached stat data only when the file is older than the index file itself; one modified in the
// index's own second it reads again (racy git). The rewrite here is a second visit's same-size test, in the second the
// index was written, with the fingerprint taken in a later second (#317). The index is written at the end of that
// second, so a copy whose mtime is rounded up lands in the next one. The times are set so the case does not wait for
// the clock, and ctime, which cannot be set, is left out.
test('fingerprint sees a same-size rewrite made in the second the index was written', async (t) => {
  const { mainRoot: directory, commit } = realRepo(t);
  gitShell.sh(directory, 'config', 'core.trustctime', 'false');
  const file = join(directory, 'adds.test.mjs');
  const second = Math.floor(Date.now() / 1000) - 10;
  writeFileSync(file, 'a - b\n');
  utimesSync(file, second, second);
  const head = commit(directory, 'subtract');
  writeFileSync(file, 'a + b\n');
  utimesSync(file, second, second);
  utimesSync(join(directory, '.git', 'index'), second + 0.9996, second + 0.9996);
  assert.notEqual((await gitModule.fingerprint(directory)).tree, await gitModule.treeOf(directory, head));
});

// A git whose index.lock waits are recorded and run `during` in place of the wait.
function recordWaits(during = () => {}) {
  const waits: number[] = [];
  const git = gitModule.createGit({
    sleep: async (ms: number) => {
      waits.push(ms);
      during();
    },
  });
  return { waits, git };
}

test('a git write retries while index.lock is held and succeeds when it clears', async (t) => {
  const { mainRoot: directory } = realRepo(t);
  const lock = join(directory, '.git', 'index.lock');
  writeFileSync(lock, '');
  writeFileSync(join(directory, 'a.txt'), 'a');
  const { waits, git } = recordWaits(() => rmSync(lock, { force: true }));
  assert.equal(await git.stageAll(directory), true);
  assert.deepEqual(waits, [100], 'one wait, after which the lock had cleared');
  const sha = await git.commitStaged(directory, 'test: add a');
  assert.ok(!existsSync(lock));
  assert.equal(gitShell.sh(directory, 'rev-parse', 'HEAD'), sha);
  assert.equal(gitShell.sh(directory, 'log', '-1', '--format=%s'), 'test: add a');
});

test('a git write surfaces the error when index.lock never clears', async (t) => {
  const { mainRoot: directory } = realRepo(t);
  const before = gitShell.sh(directory, 'rev-parse', 'HEAD');
  writeFileSync(join(directory, '.git', 'index.lock'), '');
  writeFileSync(join(directory, 'a.txt'), 'a');
  const { waits, git } = recordWaits();
  await assert.rejects(git.stageAll(directory), (err: Error) => err.message.includes('index.lock'));
  assert.deepEqual(waits, [100, 200, 400, 800], 'retried with backoff before giving up');
  assert.equal(gitShell.sh(directory, 'rev-parse', 'HEAD'), before);
});

// Off Windows a path differing only in case is another directory, so another repository's worktree there is not ours.
test(
  'ensureWorktree treats paths differing only in case as different off Windows',
  { skip: process.platform === 'win32' && 'not on Windows' },
  async (t) => {
    const { root, mainRoot } = realRepo(t);
    const other = join(root, 'MAIN');
    gitShell.sh(root, 'clone', '-q', mainRoot, other);
    const path = join(root, 'wt', 'ticket-4');
    gitShell.sh(other, 'worktree', 'add', '-q', '-b', 'ticket/4-x', path);
    await assert.rejects(
      gitModule.ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }),
      (err: Error) => err.message.includes(`${path} exists but is not a git worktree of this repo`),
    );
  },
);

test('conflictedPaths names each path of a merge conflict once', async (t) => {
  const { mainRoot: directory, branch, commit } = realRepo(t);
  writeFileSync(join(directory, 'a.txt'), 'base\n');
  commit(directory, 'base');
  branch(directory, 'other');
  writeFileSync(join(directory, 'a.txt'), 'other\n');
  commit(directory, 'other');
  gitShell.sh(directory, 'checkout', '-q', 'main');
  writeFileSync(join(directory, 'a.txt'), 'main\n');
  commit(directory, 'main');
  assert.equal(spawnSync('git', ['merge', '-q', 'other'], { cwd: directory }).status, 1);
  assert.deepEqual(await gitModule.conflictedPaths(directory), ['a.txt']);
});
