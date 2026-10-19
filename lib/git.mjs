import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './exec.mjs';
import * as gh from './github.mjs';
import { canonical } from './paths.mjs';

// Another git process (an editor, a concurrent gg) holding .git/index.lock is transient, so wait it out:
// 5 tries, 100 ms doubling; the last failure surfaces unchanged. Every git call goes through here, allowFail ones too.
export async function runGit(args, opts) {
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

const git = async (args, cwd) => (await runGit(args, { cwd })).stdout.trim();

// The main checkout is the parent of the shared .git dir, even when called from a worktree.
export async function repoInfo(cwd) {
  const gitCommonDir = resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd));
  const mainRoot = dirname(gitCommonDir);
  return { mainRoot, gitCommonDir, name: basename(mainRoot) };
}

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

// Commits reachable from HEAD that no remote-tracking ref has.
export const hasUnpushed = async (cwd) => (await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) !== '0';

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
  if (await git(['rev-parse', `${parent}^{tree}`], cwd) === tree) return null;
  const sha = await git(['commit-tree', tree, '-p', parent, '-m', message], cwd);
  await git(['update-ref', 'HEAD', sha, parent], cwd);
  return sha;
}

export const commitAll = async (cwd, message) => ((await stageAll(cwd)) ? commitStaged(cwd, message) : null);

export const numstat = (cwd, base) => git(['diff', '--numstat', `${base}...HEAD`], cwd);

// withIgnored: also count git-ignored files, which forced worktree removal would delete.
export const isDirty = async (cwd, withIgnored = false) => (await git(['status', '--porcelain', '--untracked-files=all', ...(withIgnored ? ['--ignored'] : [])], cwd)) !== '';

// Restore a recorded revision, dropping later commits and every uncommitted or untracked change.
export async function resetTo(cwd, sha) {
  await git(['reset', '-q', '--hard', sha], cwd);
  await git(['clean', '-fdq'], cwd);
}

// Throw away uncommitted work (a failed red phase must not leak into the next attempt).
export const discardChanges = (cwd) => resetTo(cwd, 'HEAD');

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

export const deleteRemoteBranch = (mainRoot, branch) => runGit(['push', 'origin', '--delete', branch], { cwd: mainRoot, allowFail: true });

export async function removeWorktree(mainRoot, path, branch) {
  await runGit(['worktree', 'remove', '--force', path], { cwd: mainRoot, allowFail: true });
  await runGit(['branch', '-D', branch], { cwd: mainRoot, allowFail: true });
}

// "worktree <path>\nHEAD ..\nbranch refs/heads/<b>" blocks -> [{path, branch}]
export async function listWorktrees(mainRoot) {
  const out = await git(['worktree', 'list', '--porcelain'], mainRoot);
  return out.split(/\r?\n\r?\n/).map((block) => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).filter((w) => w.path && w.branch);
}

// Every ticket/<n>-* branch, found independently of worktrees: [{branch, path|null, local, remote}]
export async function ticketBranches(mainRoot, n) {
  const prefix = `ticket/${n}-`;
  const found = new Map();
  const add = (branch, patch) => found.set(branch, { branch, path: null, local: false, remote: false, ...found.get(branch), ...patch });
  for (const w of await listWorktrees(mainRoot)) if (w.branch.startsWith(prefix)) add(w.branch, { path: w.path, local: true });
  for (const b of (await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`], mainRoot)).split(/\r?\n/).filter(Boolean)) add(b, { local: true });
  for (const line of (await git(['ls-remote', '--heads', 'origin', `refs/heads/${prefix}*`], mainRoot)).split(/\r?\n/).filter(Boolean)) add(line.split('refs/heads/')[1], { remote: true });
  return [...found.values()];
}

// Unlike removeWorktree/deleteRemoteBranch, failures throw: a partial cleanup must not look done.
export async function discardBranch(mainRoot, { branch, path, local, remote }) {
  if (path) await git(['worktree', 'remove', '--force', path], mainRoot);
  if (local) await git(['branch', '-D', branch], mainRoot);
  if (remote) await git(['push', 'origin', '--delete', branch], mainRoot);
}

export const worktreePath = (root, repo, n) => join(root, repo, `ticket-${n}`);

export async function cleanupMerged(repo, cfg, log, { findPr = gh.findPr } = {}) {
  for (const wt of await listWorktrees(repo.mainRoot)) {
    if (!wt.branch.startsWith('ticket/')) continue;
    const pr = await findPr(wt.branch, repo.mainRoot);
    if (pr?.state === 'MERGED') {
      if (await isDirty(wt.path, true) || await hasUnpushed(wt.path)) {
        log(`kept merged ${wt.branch}: worktree has uncommitted changes or unpushed commits`);
        continue;
      }
      await removeWorktree(repo.mainRoot, wt.path, wt.branch);
      log(`cleaned up merged ${wt.branch}`);
    }
  }
}
