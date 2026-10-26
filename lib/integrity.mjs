import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as locks from './locks.mjs';
import { pathKey } from './paths.mjs';
import * as record from './record.mjs';

// A fingerprint writes objects, so a snapshot waits for the repo lock like every other git write (request 3.5).
export async function snapshot(worktree, git) {
  return locks.withLock(await git.commonDir(worktree), 'repo', () => git.fingerprint(worktree), { timeoutMs: locks.REPO_LOCK_TIMEOUT_MS });
}

async function flip(rec, busy) {
  rec.activity = { busy, generation: rec.activity.generation + 1 };
  await record.save(rec);
}

// Clean at HEAD: neither the index nor the flag-aware tree differs from it. Unlike git status this sees edits that
// assume-unchanged hides, which reset --hard would still overwrite.
export async function isCleanAt(worktree, git) {
  const s = await snapshot(worktree, git);
  const tree = await git.treeOf(worktree);
  return s.tree === tree && s.index === tree;
}

export const markBusy = (rec) => flip(rec, true);
export const markIdle = (rec) => flip(rec, false);

export async function readActivity(commonDir, worktreePath) {
  const owner = (await record.loadAll(commonDir, 'ticket')).find((r) => pathKey(r.worktree) === pathKey(worktreePath));
  return owner?.activity ?? { busy: false, generation: 0 };
}

// The snapshot counts only if the worktree was idle and no transition happened while it was taken.
async function idleSnapshot(commonDir, worktree, git) {
  const first = await readActivity(commonDir, worktree);
  if (first.busy) return null;
  const stable = (second) => !second.busy && second.generation === first.generation;
  let snap;
  try {
    snap = await snapshot(worktree, git);
  } catch (e) {
    // A worktree that turned busy mid-snapshot may be in a state git cannot fingerprint; only a stable idle failure is ours.
    if (!stable(await readActivity(commonDir, worktree))) return null;
    throw e;
  }
  return stable(await readActivity(commonDir, worktree)) ? { generation: first.generation, snap } : null;
}

// A rollback set's paths: `within`, or the git pathspecs a reset intent saved before #144, which git.mjs still takes.
export const withinOf = (set) => set.within ?? set.pathspecs;

// No paths named: an empty { paths, globs, exclude } or an empty saved pathspec array.
const none = (within) => !within || Object.values(within).every((v) => !v?.length);

// Untracked files `within` the given paths with their content, ignored ones included: git keeps no copy, so a rollback
// restores from this. Base64, so the copy can be saved in a reset intent and survive a crash.
export async function untrackedFiles(worktree, within, git, include = 'all') {
  if (none(within)) return {};
  // Ignored ones too: an ignored Protected File is still agent configuration, and an ignored test still runs.
  const paths = await git.untrackedPaths(worktree, { include, within });
  const files = {};
  for (const p of paths) {
    const full = join(worktree, p);
    files[p] = (await lstat(full)).isSymbolicLink() ? { link: await readlink(full) } : { base64: (await readFile(full)).toString('base64') };
  }
  return files;
}

// The ignored ones alone: the snapshot tree already covers the rest, and git clean removes them.
export const ignoredFiles = (worktree, within, git) => untrackedFiles(worktree, within, git, 'ignored');

const untrackedProtected = (worktree, protectedPaths, git) => untrackedFiles(worktree, { paths: protectedPaths }, git);

export const sameFile = (a, b) => !!a && !!b && a.link === b.link && a.base64 === b.base64;
export const sameFiles = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((p) => sameFile(a[p], b[p]));

// `testPaths` is { globs, exclude } for the test files.
export async function begin({ record: rec, others, protectedPaths = [], testPaths, git }) {
  const own = await snapshot(rec.worktree, git);
  const idle = {};
  for (const worktree of others) {
    const s = await idleSnapshot(rec.commonDir, worktree, git);
    if (s) idle[worktree] = s;
  }
  return { head: own.head, own, idle, untracked: await untrackedProtected(rec.worktree, protectedPaths, git),
    tests: await untrackedFiles(rec.worktree, testPaths, git) };
}

// What git clean leaves that a rollback must put back: the untracked Protected Files and tests of the baseline, and where to
// look for new ones. Ignored files outside these paths are neither detected nor rolled back (request 3.5).
export const rollbackSet = (baseline, protectedPaths, { globs, exclude }) =>
  ({ files: { ...baseline.untracked, ...baseline.tests }, within: { paths: protectedPaths, globs, exclude } });

// The agent may have swapped a directory for a link (or junction) out of the worktree, and git lists the files behind a
// junction as the worktree's, so deleting or writing through one would change files outside. rm removes the link itself,
// never its target. A plain file in a directory's place is cleared too, so the restore can recreate the directory.
// True when something was removed: nothing under it is in the worktree any more.
async function unlinkParents(worktree, p) {
  let dir = worktree;
  for (const part of p.split('/').slice(0, -1)) {
    dir = join(dir, part);
    const st = await lstat(dir).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!st) return false;
    if (!st.isDirectory()) {
      await rm(dir, { recursive: true, force: true });
      return true;
    }
  }
  return false;
}

// git clean keeps ignored files, so after a reset a rollbackSet is put back by hand: links over the baseline's directories
// replaced first, then new files removed, then changed or deleted ones rewritten against a fresh listing.
export async function restoreUntracked(worktree, set, git) {
  const { files: untracked } = set;
  const within = withinOf(set);
  for (const p of Object.keys(untracked)) await unlinkParents(worktree, p);
  for (const p of Object.keys(await untrackedFiles(worktree, within, git))) {
    if (!untracked[p] && !await unlinkParents(worktree, p)) await rm(join(worktree, p), { recursive: true, force: true });
  }
  const now = await untrackedFiles(worktree, within, git);
  for (const [p, file] of Object.entries(untracked)) {
    if (sameFile(file, now[p])) continue;
    const full = join(worktree, p);
    await rm(full, { recursive: true, force: true });
    await mkdir(dirname(full), { recursive: true });
    await (file.link !== undefined ? symlink(file.link, full) : writeFile(full, Buffer.from(file.base64, 'base64')));
  }
}

// The Integrity Assertions over an injected git, in the shape the interpreter and Reconciliation call.
export const withGit = (git) => ({
  snapshot: (worktree) => snapshot(worktree, git),
  isCleanAt: (worktree) => isCleanAt(worktree, git),
  untrackedFiles: (worktree, within) => untrackedFiles(worktree, within, git),
  ignoredFiles: (worktree, within) => ignoredFiles(worktree, within, git),
  restoreUntracked: (worktree, set) => restoreUntracked(worktree, set, git),
  begin: (opts) => begin({ ...opts, git }),
  end: (opts) => end({ ...opts, git }),
});

const diffSurfaces = (worktree, before, after, surfaces) =>
  surfaces.filter((s) => before[s] !== after[s]).map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

export async function end({ baseline, record: rec, others, access, protectedPaths, git }) {
  const worktree = rec.worktree;
  const own = await snapshot(worktree, git);
  const violations = diffSurfaces(worktree, baseline.own, own, access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index']);

  // Against the fingerprint tree, not the real index, so index flags cannot hide an edit.
  const changed = await git.changedPaths(worktree, baseline.head, own.tree, { paths: protectedPaths });
  // Untracked Protected Files that were already there and are unchanged are the owner's, not the agent's.
  const before = baseline.untracked ?? {};
  const now = await untrackedProtected(worktree, protectedPaths, git);
  const untracked = [...Object.keys(now), ...Object.keys(before)].filter((p) => !sameFile(before[p], now[p]));
  const touched = [...new Set([...changed, ...untracked].filter(Boolean))];
  if (touched.length) violations.push({ worktree, surface: 'protected', before: null, after: touched });

  for (const other of others) {
    const start = baseline.idle[other];
    if (!start) continue;
    const now = await idleSnapshot(rec.commonDir, other, git);
    if (!now || now.generation !== start.generation) continue;
    violations.push(...diffSurfaces(other, start.snap, now.snap, ['head', 'index', 'tree']));
  }
  return { violations };
}
