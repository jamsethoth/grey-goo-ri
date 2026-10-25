import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './exec.mjs';
import { canonical } from './paths.mjs';

// Another git process (an editor, a concurrent gg) holding .git/index.lock is transient, so wait it out:
// 5 tries, 100 ms doubling; the last failure surfaces unchanged. Every git call goes through here, allowFail ones too.
async function runGit(args, opts) {
  for (let i = 0, wait = 100; ; i++, wait *= 2) {
    try {
      return await run('git', args, { ...opts, allowFail: false });
    } catch (e) {
      if (i < 4 && e.stderr?.includes('index.lock')) { await sleep(wait); continue; }
      // a nonzero exit carries stderr; a spawn failure (git missing) does not and always throws
      if (opts?.allowFail && e.stderr !== undefined) return { code: e.code, stdout: e.stdout, stderr: e.stderr };
      throw e;
    }
  }
}

const git = async (args, cwd, env) => (await runGit(args, { cwd, env })).stdout.trim();
const paths = async (args, cwd, env) => (await runGit(args, { cwd, env })).stdout.split('\0').filter(Boolean);

// The main checkout is the parent of the shared .git dir, even when called from a worktree.
export async function repoInfo(cwd) {
  const gitCommonDir = resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd));
  const mainRoot = dirname(gitCommonDir);
  return { mainRoot, gitCommonDir, name: basename(mainRoot) };
}

// The shared .git dir as an absolute path, the key of the repo lock.
export const commonDir = (cwd) => git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Concurrent `git worktree add` calls race on .git/config's lock, so they run one at a time.
let worktreeLock = Promise.resolve();
export function ensureWorktree(opts) {
  const next = worktreeLock.then(() => addWorktree(opts));
  worktreeLock = next.catch(() => {});
  return next;
}

async function addWorktree({ mainRoot, path, branch, base }) {
  if (existsSync(path)) {
    // The title may have changed since creation, so trust the worktree's branch, not the derived one.
    // Ask the directory itself: a stale registry entry can outlive a folder that was replaced by a plain one.
    const norm = (p) => canonical(p).toLowerCase();
    const q = async (...a) => (await runGit(a, { cwd: path, allowFail: true })).stdout.trim();
    const [top, common, branch] = [await q('rev-parse', '--show-toplevel'), await q('rev-parse', '--git-common-dir'), await q('rev-parse', '--abbrev-ref', 'HEAD')];
    const ours = top && common && norm(top) === norm(path) && norm(resolve(path, common)) === norm((await repoInfo(mainRoot)).gitCommonDir);
    if (!ours || !branch.startsWith('ticket/')) throw new Error(`${path} exists but is not a git worktree of this repo on a ticket/ branch; remove or move it and re-run`);
    return { path, branch };
  }
  await git(['fetch', 'origin', base], mainRoot);
  const hasBranch = (await runGit(['rev-parse', '--verify', '--quiet', branch], { cwd: mainRoot, allowFail: true })).code === 0;
  await git(['worktree', 'add', path, ...(hasBranch ? [branch] : ['--no-track', '-b', branch, `origin/${base}`])], mainRoot);
  return { path, branch };
}

// "worktree <path>\nHEAD ..\nbranch refs/heads/<b>" blocks -> [{path, branch}]
export async function listWorktrees(mainRoot) {
  const out = await git(['worktree', 'list', '--porcelain'], mainRoot);
  return out.split(/\r?\n\r?\n/).map((block) => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).filter((w) => w.path && w.branch);
}

export const worktreePath = (root, repo, n) => join(root, repo, `ticket-${n}`);

// The checked-out branch, or null on a detached HEAD; a HEAD git cannot read throws.
export async function currentBranch(cwd) {
  const current = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd, allowFail: true });
  if (current.code !== 0 && current.code !== 1) throw new Error(current.stderr.trim() || `git symbolic-ref exited ${current.code}`);
  return current.code === 1 ? null : current.stdout.trim().replace(/^refs\/heads\//, '');
}

// Stage everything the agent changed; returns whether anything is staged.
export async function stageAll(cwd) {
  await git(['add', '-A'], cwd);
  return (await runGit(['diff', '--cached', '--quiet'], { cwd, allowFail: true })).code !== 0;
}

// The tree the index would commit, so an intent can record it before the commit exists.
export const writeTree = (cwd) => git(['write-tree'], cwd);

// Commit the index as it stands; returns the new sha, or null when nothing is staged.
export async function commitStaged(cwd, message) {
  if ((await runGit(['diff', '--cached', '--quiet'], { cwd, allowFail: true })).code === 0) return null;
  await git(['commit', '-q', '-m', message], cwd);
  return headSha(cwd);
}

// Commit a recorded tree on a recorded parent, leaving the index and worktree alone; the branch moves only if it is still at
// parent. Returns the new sha, or null when the tree is the parent's (nothing to commit).
export async function commitTree(cwd, { message, tree, parent }) {
  if (await treeOf(cwd, parent) === tree) return null;
  const sha = await git(['commit-tree', tree, '-p', parent, '-m', message], cwd);
  await git(['update-ref', 'HEAD', sha, parent], cwd);
  return sha;
}

// Restore a recorded revision, dropping later commits and every uncommitted or untracked change.
export async function resetTo(cwd, sha) {
  await git(['reset', '-q', '--hard', sha], cwd);
  await git(['clean', '-fdq'], cwd);
}

// No -u: setting upstream writes .git/config, which parallel tickets would race on.
export const push = (cwd, branch, sha = branch) => git(['push', 'origin', `${sha}:refs/heads/${branch}`], cwd);
export const headSha = (cwd) => git(['rev-parse', 'HEAD'], cwd);

// The sha origin has for branch, or null when origin has no such branch.
export async function remoteSha(cwd, branch) {
  try {
    await git(['fetch', 'origin', branch], cwd);
  } catch (e) {
    // only a missing branch is null; an unreachable or unauthorised origin must not look like one
    if (e.stderr?.includes("couldn't find remote ref")) return null;
    throw e;
  }
  return git(['rev-parse', `origin/${branch}`], cwd);
}

// The local branch's commit; a missing branch throws.
export const branchHead = (cwd, branch) => git(['rev-parse', `refs/heads/${branch}`], cwd);

// The tree of a commit, HEAD's by default.
export const treeOf = (cwd, commit = 'HEAD') => git(['rev-parse', `${commit}^{tree}`], cwd);

export const hasTree = async (cwd, tree) => (await runGit(['cat-file', '-e', `${tree}^{tree}`], { cwd, allowFail: true })).code === 0;

// Every commit reachable from branch, newest first: [{sha, parents, tree, message}].
export async function commitLog(cwd, branch) {
  const out = (await runGit(['log', '--format=%x1e%H%x1f%P%x1f%T%x1f%B', branch], { cwd })).stdout;
  return out.split('\x1e').slice(1).map((c) => c.split('\x1f')).map(([sha, parents, tree, body]) =>
    ({ sha, parents: parents.split(' ').filter(Boolean), tree, message: body.replace(/\n+$/, '') }));
}

const CHANGES = { A: 'added', M: 'modified', D: 'deleted' };
// Each path that differs between two trees, renames as a deletion and an addition: [{path, change}].
export async function treeDiff(cwd, from, to) {
  const out = await paths(['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '--no-renames', from, to], cwd);
  const changes = [];
  for (let i = 0; i < out.length; i += 2) changes.push({ path: out[i + 1], change: CHANGES[out[i]] ?? 'other' });
  return changes;
}

// Paths that differ between two commits or trees, within `pathspecs` when given.
export const changedPaths = (cwd, from, to, within = []) => paths(['diff', '--name-only', '-z', from, to, ...(within.length ? ['--', ...within] : [])], cwd);

// Tracked paths whose file in the worktree differs from `commit`, renames as both paths.
export const changedSince = (cwd, commit) => paths(['diff', '--name-only', '-z', '--no-renames', commit], cwd);

// Untracked files: 'unignored' (the default) leaves out what .gitignore matches, 'ignored' lists only that, 'all' both.
export function untrackedPaths(cwd, { include = 'unignored', within = [] } = {}) {
  const only = { unignored: ['--exclude-standard'], ignored: ['--ignored', '--exclude-standard'], all: [] }[include];
  return paths(['ls-files', '--others', ...only, '-z', ...(within.length ? ['--', ...within] : [])], cwd);
}

// Pathspecs for `within`: `paths` match a path or anything under it, case-insensitively on Windows, which reads .CLAUDE/
// as .claude/; `globs` and `exclude` are globs. Without the trailing slash a directory symlink, a blob at the bare path,
// still matches.
export function pathspecs({ paths: literal = [], globs = [], exclude = [] }) {
  const bare = literal.map((p) => p.replace(/\/+$/, ''));
  const included = [...(process.platform === 'win32' ? bare.map((p) => `:(icase)${p}`) : bare), ...globs.map((g) => `:(glob)${g}`)];
  return [...(exclude.length && !included.length ? ['.'] : included), ...exclude.map((g) => `:(exclude,glob)${g}`)];
}

// git write-tree refuses unmerged entries, so the paths of a merge in progress come first.
export async function conflictedPaths(cwd) {
  return [...new Set((await paths(['ls-files', '-u', '-z'], cwd)).map((entry) => entry.slice(entry.indexOf('\t') + 1)))];
}

// A human-readable summary of the uncommitted changes to tracked files, empty when there are none.
export const diffSummary = async (cwd) => (await runGit(['diff', '--stat', 'HEAD'], { cwd })).stdout;

// The patch of what HEAD changed since it left base.
export const branchDiff = async (cwd, base) => (await runGit(['diff', `${base}...HEAD`], { cwd })).stdout;

// Lines added and removed per file since HEAD left base; a binary file counts as null: [{path, insertions, deletions}].
export async function diffStats(cwd, base) {
  return (await git(['diff', '--numstat', `${base}...HEAD`], cwd)).split('\n').filter(Boolean).map((line) => {
    const [add, del, path] = line.split('\t');
    return { path, insertions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) };
  });
}

// HEAD, the index's tree, and the tree `add -A` would stage into a copy of the index with index flags cleared, so neither
// an unstaged edit nor one that assume-unchanged or skip-worktree hides goes unseen. Writes objects, so callers hold the
// repo lock.
export async function fingerprint(worktree) {
  const dir = await mkdtemp(join(tmpdir(), 'gg-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    // Seeded from the real index so tracked files that now match an ignore rule still count.
    await copyFile(resolve(worktree, await git(['rev-parse', '--git-path', 'index'], worktree)), env.GIT_INDEX_FILE).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    // ls-files -v tags assume-unchanged entries in lowercase and skip-worktree entries 'S'; both would hide edits from add.
    const entries = (await runGit(['ls-files', '-v', '-z'], { cwd: worktree, env })).stdout.split('\0');
    // update-index applies only the first marking option it is given, so each flag is cleared in its own call.
    for (const [flag, tag] of [['--no-assume-unchanged', /^[a-z] /], ['--no-skip-worktree', /^[Ss] /]]) {
      const flagged = entries.filter((e) => tag.test(e)).map((e) => e.slice(2));
      if (flagged.length) await runGit(['update-index', flag, '-z', '--stdin'], { cwd: worktree, env, input: flagged.join('\0') });
    }
    await git(['add', '-A'], worktree, env);
    return {
      head: await git(['rev-parse', 'HEAD'], worktree),
      index: await git(['write-tree'], worktree),
      tree: await git(['write-tree'], worktree, env),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
