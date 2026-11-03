import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import * as exec from './exec.ts';
import type * as integrity from './integrity.ts';
import * as paths from './paths.ts';

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export const worktreePath = (root: string, repo: string, ticket: number | string) =>
  join(root, repo, `ticket-${ticket}`);

export type Change = 'added' | 'modified' | 'deleted' | 'other';
// git's name-status letters.
const CHANGES = new Map<string, Change>([
  ['A', 'added'],
  ['M', 'modified'],
  ['D', 'deleted'],
]);

// `within` limits a listing to { paths, globs, exclude }: `paths` match a path or anything under it,
// case-insensitively on Windows, which reads .AGENTS/ as .agents/; `globs` and `exclude` are globs that ignore case
// everywhere, as Test Immutability does (a plain :(glob) ignores it on Windows for some pathspec lists only). Without
// the trailing slash a directory symlink, a blob at the bare path, still matches. An array is the pathspecs a reset
// intent saved before #144.
function pathspecs(within: integrity.Within | undefined) {
  if (!within) return [];
  if (Array.isArray(within)) return within.length ? ['--', ...within] : [];
  const { paths: literal = [], globs = [], exclude = [] } = within;
  const bare = literal.map((path) => path.replace(/\/+$/, ''));
  const included = [
    ...(process.platform === 'win32' ? bare.map((path) => `:(icase)${path}`) : bare),
    ...globs.map((glob) => `:(glob,icase)${glob}`),
  ];
  const combined = [
    ...(exclude.length && !included.length ? ['.'] : included),
    ...exclude.map((glob) => `:(exclude,glob,icase)${glob}`),
  ];
  return combined.length ? ['--', ...combined] : [];
}

// Concurrent `git worktree add` calls race on .git/config's lock, so they run one at a time, in every git of the
// process.
// eslint-disable-next-line no-restricted-syntax -- the queue is the process's, as the lock it orders is the repo's.
let worktreeLock: Promise<unknown> = Promise.resolve();

// Another git process (an editor, a concurrent gg) holding .git/index.lock is transient, so wait it out:
// 5 tries, 100 ms doubling; the last failure surfaces unchanged. Every git call goes through here, allowFail ones too.
// A verb calls git for the whole run, its trimmed stdout, or its stdout as NUL-separated paths.
function runner(sleep: (ms: number) => Promise<unknown>) {
  async function runGit(args: string[], options: exec.RunOptions = {}): Promise<exec.CommandResult> {
    for (let i = 0, delayMs = 100; ; i++, delayMs *= 2) {
      try {
        return await exec.run('git', args, { ...options, allowFail: false });
      } catch (err) {
        if (i < 4 && err instanceof exec.CommandError && err.stderr.includes('index.lock')) {
          await sleep(delayMs);
          continue;
        }
        // a nonzero exit carries its output; a spawn failure (git missing) does not and always throws
        if (options.allowFail && err instanceof exec.CommandError)
          return { code: err.code, stdout: err.stdout, stderr: err.stderr };
        throw err;
      }
    }
  }
  type Env = Record<string, string>;
  const git = async (args: string[], cwd: string, env?: Env) => (await runGit(args, { cwd, env })).stdout.trim();
  const listPaths = async (args: string[], cwd: string, env?: Env) =>
    (await runGit(args, { cwd, env })).stdout.split('\0').filter(Boolean);
  return { runGit, git, listPaths };
}

type Runner = ReturnType<typeof runner>;

export interface WorktreeRequest {
  mainRoot: string;
  path: string;
  branch: string;
  base: string;
}

// The main checkout is the parent of the shared .git dir, even when called from a worktree.
async function readRepoInfo({ git }: Runner, cwd: string) {
  const gitCommonDir = resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd));
  const mainRoot = dirname(gitCommonDir);
  return { mainRoot, gitCommonDir, name: basename(mainRoot) };
}

// A worktree already at `path` is reused only if it is this repository's, on a ticket/ branch.
async function existingWorktree(gitRunner: Runner, { mainRoot, path }: WorktreeRequest) {
  // The title may have changed since creation, so trust the worktree's branch, not the derived one.
  // Ask the directory itself: a stale registry entry can outlive a folder that was replaced by a plain one.
  const comparable = (location: string) => paths.canonical(location).toLowerCase();
  const query = async (...args: string[]) =>
    (await gitRunner.runGit(args, { cwd: path, allowFail: true })).stdout.trim();
  const [top, common, branch] = [
    await query('rev-parse', '--show-toplevel'),
    await query('rev-parse', '--git-common-dir'),
    await query('rev-parse', '--abbrev-ref', 'HEAD'),
  ];
  const ours =
    top &&
    common &&
    comparable(top) === comparable(path) &&
    comparable(resolve(path, common)) === comparable((await readRepoInfo(gitRunner, mainRoot)).gitCommonDir);
  if (!ours || !branch.startsWith('ticket/'))
    throw new Error(
      `${path} exists but is not a git worktree of this repo on a ticket/ branch; remove or move it and re-run`,
    );
  return { path, branch };
}

async function addWorktree(gitRunner: Runner, request: WorktreeRequest) {
  const { mainRoot, path, branch, base } = request;
  if (existsSync(path)) return existingWorktree(gitRunner, request);
  const { git, runGit } = gitRunner;
  await git(['fetch', 'origin', base], mainRoot);
  const hasBranch =
    (await runGit(['rev-parse', '--verify', '--quiet', branch], { cwd: mainRoot, allowFail: true })).code === 0;
  const from = hasBranch ? [branch] : ['--no-track', '-b', branch, `origin/${base}`];
  await git(['worktree', 'add', path, ...from], mainRoot);
  return { path, branch };
}

function worktreeVerbs(gitRunner: Runner) {
  const { git, runGit } = gitRunner;
  const repoInfo = (cwd: string) => readRepoInfo(gitRunner, cwd);

  // The shared .git dir as an absolute path, the key of the repo lock. Read once per directory: every integrity
  // snapshot asks for it, a git process costs about 80 ms on Windows, and a directory's repository does not change
  // under a Run.
  const commonDirs = new Map<string, string>();
  async function commonDir(cwd: string) {
    if (!commonDirs.has(cwd))
      commonDirs.set(cwd, await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd));
    return commonDirs.get(cwd) as string;
  }

  function ensureWorktree(request: WorktreeRequest) {
    const next = worktreeLock.then(() => addWorktree(gitRunner, request));
    worktreeLock = next.catch(() => {});
    return next;
  }

  // "worktree <path>\nHEAD ..\nbranch refs/heads/<b>" blocks -> [{path, branch}]
  async function listWorktrees(mainRoot: string) {
    const listing = await git(['worktree', 'list', '--porcelain'], mainRoot);
    return listing
      .split(/\r?\n\r?\n/)
      .map((block) => ({
        path: block.match(/^worktree (.+)$/m)?.[1],
        branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
      }))
      .filter((worktree): worktree is { path: string; branch: string } => !!(worktree.path && worktree.branch));
  }

  // The checked-out branch, or null on a detached HEAD; a HEAD git cannot read throws.
  async function currentBranch(cwd: string) {
    const current = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd, allowFail: true });
    if (current.code !== 0 && current.code !== 1)
      throw new Error(current.stderr.trim() || `git symbolic-ref exited ${current.code}`);
    return current.code === 1 ? null : current.stdout.trim().replace(/^refs\/heads\//, '');
  }

  return { repoInfo, commonDir, ensureWorktree, listWorktrees, currentBranch };
}

// Every commit reachable from branch, newest first.
async function readCommitLog({ runGit }: Runner, cwd: string, branch: string) {
  const log = (await runGit(['log', '--format=%x1e%H%x1f%P%x1f%T%x1f%B', branch], { cwd })).stdout;
  return log
    .split('\x1e')
    .slice(1)
    .map((entry) => entry.split('\x1f') as [string, string, string, string])
    .map(([sha, parents, tree, body]) => ({
      sha,
      parents: parents.split(' ').filter(Boolean),
      tree,
      message: body.replace(/\n+$/, ''),
    }));
}

function refVerbs(gitRunner: Runner) {
  const { git, runGit } = gitRunner;
  // No -u: setting upstream writes .git/config, which parallel tickets would race on.
  const push = (cwd: string, branch: string, sha = branch) =>
    git(['push', 'origin', `${sha}:refs/heads/${branch}`], cwd);
  const headSha = (cwd: string) => git(['rev-parse', 'HEAD'], cwd);

  // The sha origin has for branch, or null when origin has no such branch.
  async function remoteSha(cwd: string, branch: string) {
    try {
      await git(['fetch', 'origin', branch], cwd);
    } catch (err) {
      // only a missing branch is null; an unreachable or unauthorised origin must not look like one
      if (err instanceof exec.CommandError && err.stderr.includes("couldn't find remote ref")) return null;
      throw err;
    }
    return git(['rev-parse', `origin/${branch}`], cwd);
  }

  // The local branch's commit; a missing branch throws.
  const branchHead = (cwd: string, branch: string) => git(['rev-parse', `refs/heads/${branch}`], cwd);

  // The tree of a commit, HEAD's by default.
  const treeOf = (cwd: string, commit = 'HEAD') => git(['rev-parse', `${commit}^{tree}`], cwd);

  const hasTree = async (cwd: string, tree: string) =>
    (await runGit(['cat-file', '-e', `${tree}^{tree}`], { cwd, allowFail: true })).code === 0;

  const commitLog = (cwd: string, branch: string) => readCommitLog(gitRunner, cwd, branch);
  return { push, headSha, remoteSha, branchHead, treeOf, hasTree, commitLog };
}

function commitVerbs(gitRunner: Runner, { headSha, treeOf }: ReturnType<typeof refVerbs>) {
  const { git, runGit } = gitRunner;
  const nothingStaged = async (cwd: string) =>
    (await runGit(['diff', '--cached', '--quiet'], { cwd, allowFail: true })).code === 0;

  // Stage everything the agent changed; returns whether anything is staged.
  async function stageAll(cwd: string) {
    await git(['add', '-A'], cwd);
    return !(await nothingStaged(cwd));
  }

  // The tree the index would commit, so an intent can record it before the commit exists.
  const writeTree = (cwd: string) => git(['write-tree'], cwd);

  // Commit the index as it stands; returns the new sha, or null when nothing is staged.
  async function commitStaged(cwd: string, message: string) {
    if (await nothingStaged(cwd)) return null;
    await git(['commit', '-q', '-m', message], cwd);
    return headSha(cwd);
  }

  // Commit a recorded tree on a recorded parent, leaving the index and worktree alone; the branch moves only if it is
  // still at parent. Returns the new sha, or null when the tree is the parent's (nothing to commit).
  async function commitTree(cwd: string, { message, tree, parent }: { message: string; tree: string; parent: string }) {
    if ((await treeOf(cwd, parent)) === tree) return null;
    const sha = await git(['commit-tree', tree, '-p', parent, '-m', message], cwd);
    await git(['update-ref', 'HEAD', sha, parent], cwd);
    return sha;
  }

  // Restore a recorded revision, dropping later commits and every uncommitted or untracked change.
  async function resetTo(cwd: string, sha: string) {
    await git(['reset', '-q', '--hard', sha], cwd);
    await git(['clean', '-fdq'], cwd);
  }

  return { stageAll, writeTree, commitStaged, commitTree, resetTo };
}

// Lines added and removed per file since HEAD left base; a binary file counts as null.
// -z gives paths raw, not quoted, and a rename counts as its removed and added paths, as Test Immutability lists it.
async function readDiffStats({ listPaths }: Runner, cwd: string, base: string) {
  return (await listPaths(['diff', '--numstat', '-z', '--no-renames', `${base}...HEAD`], cwd)).map((entry) => {
    const [, added, deleted, path] = entry.match(/^([^\t]*)\t([^\t]*)\t(.*)$/s) as unknown as [string, ...string[]];
    return {
      path,
      insertions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    };
  });
}

function diffVerbs(gitRunner: Runner) {
  const { runGit, listPaths } = gitRunner;
  // Each path that differs between two trees, renames as a deletion and an addition.
  async function treeDiff(cwd: string, from: string, to: string) {
    const args = ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '--no-renames', from, to];
    const listed = await listPaths(args, cwd);
    const changes: { path: string; change: Change }[] = [];
    for (let i = 0; i < listed.length; i += 2)
      changes.push({ path: listed[i + 1] as string, change: CHANGES.get(listed[i] as string) ?? 'other' });
    return changes;
  }

  // Paths that differ between two commits or trees, within the given paths when asked.
  const changedPaths = (cwd: string, from: string, to: string, within?: integrity.Within) =>
    listPaths(['diff', '--name-only', '-z', from, to, ...pathspecs(within)], cwd);

  // Tracked paths whose file in the worktree differs from `commit`, renames as both paths.
  const changedSince = (cwd: string, commit: string) =>
    listPaths(['diff', '--name-only', '-z', '--no-renames', commit], cwd);

  // Untracked files: 'unignored' (the default) leaves out what .gitignore matches, 'ignored' lists only that, 'all'
  // both.
  function untrackedPaths(
    cwd: string,
    { include = 'unignored', within }: { include?: 'unignored' | 'ignored' | 'all'; within?: integrity.Within } = {},
  ) {
    const only = { unignored: ['--exclude-standard'], ignored: ['--ignored', '--exclude-standard'], all: [] }[include];
    return listPaths(['ls-files', '--others', ...only, '-z', ...pathspecs(within)], cwd);
  }

  // git write-tree refuses unmerged entries, so the paths of a merge in progress come first.
  const conflictedPaths = async (cwd: string) => [
    ...new Set((await listPaths(['ls-files', '-u', '-z'], cwd)).map((entry) => entry.slice(entry.indexOf('\t') + 1))),
  ];

  // A human-readable summary of the uncommitted changes to tracked files, empty when there are none.
  const diffSummary = async (cwd: string) => (await runGit(['diff', '--stat', 'HEAD'], { cwd })).stdout;

  // The patch of what HEAD changed since it left base.
  const branchDiff = async (cwd: string, base: string) => (await runGit(['diff', `${base}...HEAD`], { cwd })).stdout;

  const diffStats = (cwd: string, base: string) => readDiffStats(gitRunner, cwd, base);
  return { treeDiff, changedPaths, changedSince, untrackedPaths, conflictedPaths, diffSummary, branchDiff, diffStats };
}

// HEAD, the index's tree, and the tree `add -A` would stage into a copy of the index with index flags cleared, so
// neither an unstaged edit nor one that assume-unchanged or skip-worktree hides goes unseen. Writes objects, so callers
// hold the repo lock.
async function snapshotWorktree({ git, runGit }: Runner, worktree: string): Promise<integrity.WorktreeSnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), 'gg-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(tempDir, 'index') };
    // One process for both: a snapshot runs several per Action, each git process about 80 ms on Windows.
    const revParse = await git(['rev-parse', '--git-path', 'index', 'HEAD'], worktree);
    const [index, head] = revParse.split(/\r?\n/) as [string, string];
    // Seeded from the real index so tracked files that now match an ignore rule still count.
    await copyFile(resolve(worktree, index), env.GIT_INDEX_FILE).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    // ls-files -v tags assume-unchanged entries in lowercase and skip-worktree entries 'S'; both would hide edits
    // from add.
    const entries = (await runGit(['ls-files', '-v', '-z'], { cwd: worktree, env })).stdout.split('\0');
    // update-index applies only the first marking option it is given, so each flag is cleared in its own call.
    for (const [flag, tag] of [
      ['--no-assume-unchanged', /^[a-z] /],
      ['--no-skip-worktree', /^[Ss] /],
    ] as const) {
      const flagged = entries.filter((entry) => tag.test(entry)).map((entry) => entry.slice(2));
      if (flagged.length)
        await runGit(['update-index', flag, '-z', '--stdin'], { cwd: worktree, env, input: flagged.join('\0') });
    }
    await git(['add', '-A'], worktree, env);
    return { head, index: await git(['write-tree'], worktree), tree: await git(['write-tree'], worktree, env) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// The git verbs. `sleep` waits out another process's index.lock; the entry point passes none, so it is the real wait,
// and a test passes one that records the waits.
export function createGit({ sleep = wait }: { sleep?: (ms: number) => Promise<unknown> } = {}) {
  const gitRunner = runner(sleep);
  const refs = refVerbs(gitRunner);
  return {
    ...worktreeVerbs(gitRunner),
    ...commitVerbs(gitRunner, refs),
    ...refs,
    ...diffVerbs(gitRunner),
    fingerprint: (worktree: string) => snapshotWorktree(gitRunner, worktree),
    slugify,
    worktreePath,
  };
}

// The git verbs the entry point builds and passes down as `git` (ADR 0019); the fake git matches them.
export type Git = ReturnType<typeof createGit>;

// The real git, for callers that take no seam.
export const {
  repoInfo,
  commonDir,
  ensureWorktree,
  listWorktrees,
  currentBranch,
  stageAll,
  writeTree,
  commitStaged,
  commitTree,
  resetTo,
  push,
  headSha,
  remoteSha,
  branchHead,
  treeOf,
  hasTree,
  commitLog,
  treeDiff,
  changedPaths,
  changedSince,
  untrackedPaths,
  conflictedPaths,
  diffSummary,
  branchDiff,
  diffStats,
  fingerprint,
} = createGit();
