// The fake git's object store, shared by every repository it holds, and the reads its verbs share: the worktree at a
// directory, refs and revisions, and a worktree's files on disk (test/support/fake-git.ts).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as paths from '../../lib/paths.ts';
import * as fakeGitPaths from './fake-git-paths.ts';

type Files = fakeGitPaths.Files;
const { isIgnored, sorted } = fakeGitPaths;

export interface Worktree {
  path: string;
  branch: string | null;
  head?: string;
  index: Files;
  marker?: string;
  main?: boolean;
}
export interface Repo {
  commonDir: string;
  url: string;
  reachable: boolean;
  branches: Map<string, string>;
  origin: Map<string, string>;
  tracking: Map<string, string>;
  refs: Map<string, string>;
  worktrees: Worktree[];
}
export interface Commit {
  tree: string;
  parents: string[];
  message: string;
  order: number;
}
// A worktree found by its directory, with the repository it belongs to.
export interface Place {
  repo: Repo;
  worktree: Worktree;
}

export const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');
export const fail = (message: string) => Object.assign(new Error(message), { stderr: `${message}\n` });

// Every repository the fake holds, its object store shared, as one git installation's would be.
export function objectStore() {
  const trees = new Map<string, Files>();
  const commits = new Map<string, Commit>();
  const repos: Repo[] = [];
  const counter = { order: 0 };
  const putTree = (files: Files) => {
    const id = sha1(
      `tree\0${sorted(files.keys())
        .map((path) => `${path}\0${sha1(files.get(path) as Buffer)}`)
        .join('\0')}`,
    );
    if (!trees.has(id)) trees.set(id, new Map(files));
    return id;
  };
  const putCommit = (tree: string, parents: string[], message: string) => {
    const order = ++counter.order;
    const sha = sha1(`commit ${order}\0${tree}\0${parents.join(' ')}\0${message}`);
    commits.set(sha, { tree, parents, message, order });
    return sha;
  };
  const commit = (sha: string) => commits.get(sha) as Commit;
  const tree = (id: string) => trees.get(id) as Files;
  return { trees, commits, repos, counter, putTree, putCommit, commit, tree };
}
export type Store = ReturnType<typeof objectStore>;

// The worktree at `cwd`, found as git finds it: by the .git entry in that directory, so a plain folder that replaced a
// worktree is not one.
export function placeOf(store: Store, cwd: string): Place {
  for (const repo of store.repos) {
    for (const worktree of repo.worktrees) {
      if (paths.pathKey(worktree.path) !== paths.pathKey(cwd)) continue;
      const marker = join(cwd, '.git');
      const found = worktree.main
        ? existsSync(marker)
        : existsSync(marker) && readFileSync(marker, 'utf8') === worktree.marker;
      if (found) return { repo, worktree };
    }
  }
  throw fail(`fatal: not a git repository: ${cwd}`);
}

export function refs(store: Store) {
  const headOf = ({ repo, worktree }: Place) => {
    const sha = worktree.branch ? repo.branches.get(worktree.branch) : worktree.head;
    if (!sha) throw fail("fatal: ambiguous argument 'HEAD': unknown revision");
    return sha;
  };
  const move = ({ repo, worktree }: Place, sha: string) => {
    if (worktree.branch) repo.branches.set(worktree.branch, sha);
    else worktree.head = sha;
  };
  const commitOf = (repo: Repo, rev: string) => {
    const tracked = rev.startsWith('origin/') ? repo.tracking.get(rev.slice(7)) : undefined;
    const sha = repo.branches.get(rev) ?? repo.refs.get(rev) ?? tracked ?? rev;
    if (!store.commits.has(sha)) throw fail(`fatal: bad revision '${rev}'`);
    return sha;
  };
  const resolve = (place: Place, rev: string) => (rev === 'HEAD' ? headOf(place) : commitOf(place.repo, rev));
  const treeFiles = (place: Place, rev: string) =>
    store.tree(store.trees.has(rev) ? rev : store.commit(resolve(place, rev)).tree);
  const ancestors = (sha: string) => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...store.commit(next).parents);
    }
    return seen;
  };
  const mergeBase = (first: string, second: string) => {
    const of = ancestors(first);
    return [...ancestors(second)]
      .filter((sha) => of.has(sha))
      .sort((left, right) => store.commit(right).order - store.commit(left).order)[0] as string;
  };
  // The trees a branch diff compares: where `until` left base, and `until`.
  const sinceBase = (place: Place, base: string, until = 'HEAD') => {
    const head = resolve(place, until);
    return {
      from: store.tree(store.commit(mergeBase(commitOf(place.repo, base), head)).tree),
      to: store.tree(store.commit(head).tree),
    };
  };
  return { headOf, move, commitOf, resolve, treeFiles, ancestors, sinceBase };
}

// A worktree's files on disk and what `add -A` would make of them.
export function workingFiles() {
  // shortcut: symlinks are skipped, not stored as links; a test whose subject is a link stays on real git.
  const disk = (worktree: Worktree) => {
    const files: Files = new Map();
    const walk = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') continue;
        const full = join(directory, entry.name);
        const path = prefix + entry.name;
        if (lstatSync(full).isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full, `${path}/`);
        else files.set(path, readFileSync(full));
      }
    };
    walk(worktree.path, '');
    return files;
  };
  const rulesOf = (worktree: Worktree) => {
    const file = join(worktree.path, '.gitignore');
    return existsSync(file) ? fakeGitPaths.ignoreRules(readFileSync(file, 'utf8')) : [];
  };
  // What `add -A` stages: every file on disk but untracked ignored ones, and no tracked file that is gone.
  const addAll = (worktree: Worktree): Files => {
    const rules = rulesOf(worktree);
    return new Map([...disk(worktree)].filter(([path]) => worktree.index.has(path) || !isIgnored(rules, path)));
  };
  const writeFiles = (root: string, files: Files) => {
    for (const [path, content] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  const pruneEmpty = (directory: string, top = true) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (top && entry.name === '.git') continue;
      if (entry.isDirectory() && !lstatSync(join(directory, entry.name)).isSymbolicLink())
        pruneEmpty(join(directory, entry.name), false);
    }
    if (!top && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
  };
  return { disk, rulesOf, addAll, writeFiles, pruneEmpty };
}

export type Parts = { store: Store; placeAt: (cwd: string) => Place } & ReturnType<typeof refs> &
  ReturnType<typeof workingFiles>;

// What every verb reads: the store, the worktree at a directory, refs, and working files.
export const partsOf = (store: Store): Parts => ({
  store,
  placeAt: (cwd) => placeOf(store, cwd),
  ...refs(store),
  ...workingFiles(),
});
