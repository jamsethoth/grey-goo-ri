// lib/git.ts without git, for tests whose subject is not git behaviour: commits, trees, refs, each worktree's index and
// the origin live in memory, while a worktree's files stay on disk, where the fake harness and a test runner read and
// write them. test/contract/git/ runs lib/git.ts's cases against this and the real module, so a verb that drifts fails
// there. Owned beside lib/git.ts: a verb added there is added here.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as gitModule from '../../lib/git.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as paths from '../../lib/paths.ts';
import * as fakeGitPaths from './fake-git-paths.ts';
import * as fakeGitStore from './fake-git-store.ts';

type Files = fakeGitPaths.Files;
type Parts = fakeGitStore.Parts;
type Place = fakeGitStore.Place;
type Repo = fakeGitStore.Repo;
const { differing, isIgnored, sorted, withinMatcher } = fakeGitPaths;
const { fail, sha1 } = fakeGitStore;

// The verbs every git call names, with lib/git.ts's parameters and results. push's result, git's output, no caller
// reads, so the fake returns none.
type GitVerbs = {
  [Verb in keyof gitModule.Git]: (
    ...args: Parameters<gitModule.Git[Verb]>
  ) => Verb extends 'push' ? Promise<unknown> : ReturnType<gitModule.Git[Verb]>;
};
// tsc fails here if the check stops holding results: headSha gives a sha, never null.
// @ts-expect-error a verb whose result is not lib's is refused
const refusedWrongResult: GitVerbs['headSha'] = async () => null;

function worktreeVerbs({ store, placeAt, writeFiles }: Parts) {
  // An existing path is reused only as a ticket worktree of this repository.
  const existing = (repo: Repo, path: string) => {
    const found = (() => {
      try {
        return placeAt(path);
      } catch {
        return null; // not a worktree
      }
    })();
    if (!found || found.repo !== repo || !found.worktree.branch?.startsWith('ticket/')) {
      throw new Error(
        `${path} exists but is not a git worktree of this repo on a ticket/ branch; remove or move it and re-run`,
      );
    }
    return { path, branch: found.worktree.branch };
  };
  return {
    repoInfo: async (cwd: string) => {
      const { repo, worktree } = placeAt(cwd);
      const gitCommonDir = worktree.main ? join(cwd, '.git') : paths.canonical(repo.commonDir);
      return {
        mainRoot: dirname(gitCommonDir),
        gitCommonDir,
        name: dirname(gitCommonDir).split(/[\\/]/).at(-1) as string,
      };
    },
    commonDir: async (cwd: string) => paths.canonical(placeAt(cwd).repo.commonDir),
    slugify: gitModule.slugify,
    worktreePath: gitModule.worktreePath,
    async ensureWorktree({ mainRoot, path, branch, base }: gitModule.WorktreeRequest) {
      const { repo } = placeAt(mainRoot);
      if (existsSync(path)) return existing(repo, path);
      if (!repo.reachable) throw fail(`fatal: '${repo.url}' does not appear to be a git repository`);
      const remote = repo.origin.get(base);
      if (!remote) throw fail(`fatal: couldn't find remote ref ${base}`);
      repo.tracking.set(base, remote);
      if (!repo.branches.has(branch)) repo.branches.set(branch, remote);
      const files = store.tree(store.commit(repo.branches.get(branch) as string).tree);
      const marker = `gitdir: fake ${sha1(`${paths.pathKey(path)}${++store.counter.order}`)}\n`;
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, '.git'), marker);
      writeFiles(path, files);
      repo.worktrees.push({ path, branch, index: new Map(files), marker });
      return { path, branch };
    },
    // git lists worktrees by their canonical paths, with forward slashes on Windows too.
    listWorktrees: async (mainRoot: string) =>
      placeAt(mainRoot)
        .repo.worktrees.filter((worktree) => worktree.branch)
        .map((worktree) => ({
          path: paths.canonical(worktree.path).replaceAll('\\', '/'),
          branch: worktree.branch as string,
        })),
    currentBranch: async (cwd: string) => placeAt(cwd).worktree.branch ?? null,
  };
}

function commitVerbs({ store, placeAt, headOf, move, resolve, treeFiles, ancestors, ...files }: Parts) {
  return {
    async stageAll(cwd: string) {
      const place = placeAt(cwd);
      place.worktree.index = files.addAll(place.worktree);
      return store.putTree(place.worktree.index) !== store.commit(headOf(place)).tree;
    },
    writeTree: async (cwd: string) => store.putTree(placeAt(cwd).worktree.index),
    async commitStaged(cwd: string, message: string) {
      const place = placeAt(cwd);
      const tree = store.putTree(place.worktree.index);
      const head = headOf(place);
      if (tree === store.commit(head).tree) return null;
      const sha = store.putCommit(tree, [head], message);
      move(place, sha);
      return sha;
    },
    async commitTree(cwd: string, { message, tree, parent }: { message: string; tree: string; parent: string }) {
      const place = placeAt(cwd);
      if (store.commits.get(parent)?.tree === tree) return null;
      if (!store.trees.has(tree)) throw fail(`fatal: ${tree} is not a valid 'tree' object`);
      const sha = store.putCommit(tree, [parent], message);
      const head = headOf(place);
      if (head !== parent)
        throw fail(`fatal: update-ref: cannot lock ref 'HEAD': is at ${head} but expected ${parent}`);
      move(place, sha);
      return sha;
    },
    // reset --hard then clean -fd: tracked files take the revision's content, untracked ones go unless ignored.
    async resetTo(cwd: string, sha: string) {
      const place = placeAt(cwd);
      const target = treeFiles(place, sha);
      const rules = files.rulesOf(place.worktree);
      for (const path of files.disk(place.worktree).keys()) {
        if (!target.has(path) && (place.worktree.index.has(path) || !isIgnored(rules, path)))
          rmSync(join(cwd, path), { force: true });
      }
      files.writeFiles(cwd, target);
      files.pruneEmpty(cwd);
      place.worktree.index = new Map(target);
      move(place, resolve(place, sha));
    },
    // stubs for the rescue verbs (#118)
    rescueTree: async (_cwd: string, _options: { within?: integrity.Within }): Promise<string> => '',
    rescueCommit: async (_cwd: string, _commit: { tree: string; parent: string; message: string }): Promise<string> =>
      '',
    createRef: async (_cwd: string, _ref: string, _sha: string): Promise<boolean> => false,
    refTarget: async (_cwd: string, _ref: string): Promise<string | null> => null,
    async push(cwd: string, branch: string, sha = branch) {
      const place = placeAt(cwd);
      const commit = resolve(place, sha);
      if (!place.repo.reachable) throw fail(`fatal: '${place.repo.url}' does not appear to be a git repository`);
      const theirs = place.repo.origin.get(branch);
      if (theirs && !ancestors(commit).has(theirs))
        throw fail(` ! [rejected]        ${sha} -> ${branch} (non-fast-forward)`);
      place.repo.origin.set(branch, commit);
      place.repo.tracking.set(branch, commit);
    },
  };
}

function refVerbs({ store, placeAt, headOf, commitOf, resolve, ancestors }: Parts) {
  return {
    headSha: async (cwd: string) => headOf(placeAt(cwd)),
    async remoteSha(cwd: string, branch: string) {
      const { repo } = placeAt(cwd);
      if (!repo.reachable) throw fail(`fatal: '${repo.url}' does not appear to be a git repository`);
      const remote = repo.origin.get(branch);
      if (!remote) return null;
      repo.tracking.set(branch, remote);
      return remote;
    },
    async branchHead(cwd: string, branch: string) {
      const sha = placeAt(cwd).repo.branches.get(branch);
      if (!sha) throw fail(`fatal: ambiguous argument 'refs/heads/${branch}': unknown revision`);
      return sha;
    },
    treeOf: async (cwd: string, commit = 'HEAD') => store.commit(resolve(placeAt(cwd), commit)).tree,
    hasTree: async (cwd: string, tree: string) => (placeAt(cwd), store.trees.has(tree)),
    async commitLog(cwd: string, branch: string) {
      const place = placeAt(cwd);
      return [...ancestors(commitOf(place.repo, branch))]
        .sort((left, right) => store.commit(right).order - store.commit(left).order)
        .map((sha) => ({
          sha,
          parents: store.commit(sha).parents,
          tree: store.commit(sha).tree,
          message: store.commit(sha).message.replace(/\n+$/, ''),
        }));
    },
  };
}

function treeDiffVerbs({ placeAt, treeFiles }: Parts) {
  return {
    async treeDiff(cwd: string, from: string, to: string) {
      const place = placeAt(cwd);
      const [before, after] = [treeFiles(place, from), treeFiles(place, to)];
      const changeOf = (path: string): gitModule.Change => {
        if (!before.has(path)) return 'added';
        return after.has(path) ? 'modified' : 'deleted';
      };
      return differing(before, after).map((path) => ({ path, change: changeOf(path) }));
    },
    // Renames as git detects them by default, but only exact ones: the deleted path of a moved file is not listed.
    async changedPaths(cwd: string, from: string, to: string, within?: integrity.Within) {
      const place = placeAt(cwd);
      const [before, after] = [treeFiles(place, from), treeFiles(place, to)];
      const changed = differing(before, after).filter(withinMatcher(within));
      const added = changed.filter((path) => !before.has(path)).map((path) => after.get(path) as Buffer);
      return changed.filter((path) => {
        if (after.has(path)) return true;
        const moved = added.findIndex((content) => content.equals(before.get(path) as Buffer));
        if (moved < 0) return true;
        added.splice(moved, 1);
        return false;
      });
    },
  };
}

function worktreeDiffVerbs({ placeAt, treeFiles, sinceBase, ...files }: Parts) {
  const changedSince = async (cwd: string, commit: string) => {
    const place = placeAt(cwd);
    const onDisk = files.disk(place.worktree);
    const tracked: Files = new Map(
      [...place.worktree.index.keys()]
        .filter((path) => onDisk.has(path))
        .map((path) => [path, onDisk.get(path) as Buffer]),
    );
    return differing(treeFiles(place, commit), tracked);
  };
  return {
    changedSince,
    async untrackedPaths(
      cwd: string,
      { include = 'unignored', within }: { include?: 'unignored' | 'ignored' | 'all'; within?: integrity.Within } = {},
    ) {
      const { worktree } = placeAt(cwd);
      const rules = files.rulesOf(worktree);
      const match = withinMatcher(within);
      const keep = {
        unignored: (path: string) => !isIgnored(rules, path),
        ignored: (path: string) => isIgnored(rules, path),
        all: () => true,
      }[include];
      return sorted(
        [...files.disk(worktree).keys()].filter((path) => !worktree.index.has(path) && keep(path) && match(path)),
      );
    },
    // shortcut: the fake makes no merges, so nothing is ever conflicted; conflict tests stay on real git.
    conflictedPaths: async (cwd: string): Promise<string[]> => (placeAt(cwd), []),
    async diffSummary(cwd: string) {
      const changed = await changedSince(cwd, 'HEAD');
      if (!changed.length) return '';
      return `${changed.map((path) => ` ${path} | changed\n`).join('')} ${changed.length} files changed\n`;
    },
    async branchDiff(cwd: string, base: string) {
      const { from, to } = sinceBase(placeAt(cwd), base);
      return differing(from, to)
        .map((path) => fakeGitPaths.patchOf(path, from.get(path), to.get(path)))
        .join('');
    },
    async diffStats(cwd: string, base: string) {
      const { from, to } = sinceBase(placeAt(cwd), base);
      return differing(from, to).map((path) => fakeGitPaths.statsOf(path, from.get(path), to.get(path)));
    },
    // No verb sets index flags here, so the tree `add -A` would stage is read from the files themselves.
    async fingerprint(worktree: string) {
      const place = placeAt(worktree);
      const { putTree } = files.store;
      return {
        head: files.headOf(place),
        index: putTree(place.worktree.index),
        tree: putTree(files.addAll(place.worktree)),
      };
    },
  };
}

// The steps a test takes outside gg, as a human or another tool would with git.
function humanSteps({ store, placeAt, headOf, move, addAll, writeFiles }: Parts) {
  // A bare origin and its clone at root/main with one commit on main holding `files`, pushed: what tests start from.
  function init(
    root: string,
    { files = {}, message = 'init' }: { files?: Record<string, string>; message?: string } = {},
  ) {
    const mainRoot = join(root, 'main');
    const commonDir = join(mainRoot, '.git');
    mkdirSync(commonDir, { recursive: true });
    const tree = store.putTree(new Map(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)])));
    const base = store.putCommit(tree, [], message);
    const repo: Repo = {
      commonDir,
      url: join(root, 'origin.git'),
      reachable: true,
      branches: new Map([['main', base]]),
      origin: new Map([['main', base]]),
      tracking: new Map([['main', base]]),
      worktrees: [{ path: mainRoot, branch: 'main', index: new Map(store.tree(tree)), main: true }],
    };
    store.repos.push(repo);
    writeFiles(mainRoot, store.tree(tree));
    return { mainRoot, commonDir, base };
  }
  const commitAs = (directory: string, message: string, parentsOf: (place: Place) => string[], stage: boolean) => {
    const place = placeAt(directory);
    if (stage) place.worktree.index = addAll(place.worktree);
    const sha = store.putCommit(store.putTree(place.worktree.index), parentsOf(place), message);
    move(place, sha);
    return sha;
  };
  return {
    init,
    commit: (directory: string, message: string) => commitAs(directory, message, (place) => [headOf(place)], true),
    amend: (directory: string, message: string) =>
      commitAs(directory, message, (place) => store.commit(headOf(place)).parents, false),
    branch: (directory: string, name: string) => {
      const place = placeAt(directory);
      place.repo.branches.set(name, headOf(place));
      place.worktree.branch = name;
    },
    detach: (directory: string) => {
      const place = placeAt(directory);
      place.worktree.head = headOf(place);
      place.worktree.branch = null;
    },
    unstage: (directory: string) => {
      const place = placeAt(directory);
      place.worktree.index = new Map(store.tree(store.commit(headOf(place)).tree));
    },
    breakOrigin: (directory: string) => {
      const { repo } = placeAt(directory);
      repo.reachable = false;
      repo.url = join(dirname(repo.url), 'gone.git');
      return 'gone.git';
    },
    // `git worktree list`'s count, main checkout included, read without awaiting.
    worktreeCount: (mainRoot: string) => placeAt(mainRoot).repo.worktrees.length,
  };
}

export function fakeGit() {
  const parts = fakeGitStore.partsOf(fakeGitStore.objectStore());
  const git = {
    ...worktreeVerbs(parts),
    ...commitVerbs(parts),
    ...refVerbs(parts),
    ...treeDiffVerbs(parts),
    ...worktreeDiffVerbs(parts),
  } satisfies GitVerbs;
  return { git, ...humanSteps(parts) };
}

export type FakeGit = ReturnType<typeof fakeGit>;
