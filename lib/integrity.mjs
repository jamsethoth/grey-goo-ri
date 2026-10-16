import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit } from './git.mjs';
import * as record from './record.mjs';

const git = async (args, cwd, env) => (await runGit(args, { cwd, env })).stdout.trim();

export async function snapshot(worktree) {
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
      const paths = entries.filter((e) => tag.test(e)).map((e) => e.slice(2));
      if (paths.length) await runGit(['update-index', flag, '-z', '--stdin'], { cwd: worktree, env, input: paths.join('\0') });
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

async function flip(rec, busy) {
  rec.activity = { busy, generation: rec.activity.generation + 1 };
  await record.save(rec);
}

// Clean at `rev`: neither the index nor the flag-aware tree differs from it. Unlike git status this sees edits that
// assume-unchanged hides, which reset --hard would still overwrite.
export async function isCleanAt(worktree, rev) {
  const s = await snapshot(worktree);
  const tree = await git(['rev-parse', `${rev}^{tree}`], worktree);
  return s.tree === tree && s.index === tree;
}

export const markBusy = (rec) => flip(rec, true);
export const markIdle = (rec) => flip(rec, false);

// Windows paths are case-insensitive, so ownership must not hinge on how a caller cased the path.
const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export async function readActivity(commonDir, worktreePath) {
  const owner = (await record.loadAll(commonDir, 'ticket')).find((r) => pathKey(r.worktree) === pathKey(worktreePath));
  return owner?.activity ?? { busy: false, generation: 0 };
}

// The snapshot counts only if the worktree was idle and no transition happened while it was taken.
async function idleSnapshot(commonDir, worktree) {
  const first = await readActivity(commonDir, worktree);
  if (first.busy) return null;
  const stable = (second) => !second.busy && second.generation === first.generation;
  let snap;
  try {
    snap = await snapshot(worktree);
  } catch (e) {
    // A worktree that turned busy mid-snapshot may be in a state git cannot fingerprint; only a stable idle failure is ours.
    if (!stable(await readActivity(commonDir, worktree))) return null;
    throw e;
  }
  return stable(await readActivity(commonDir, worktree)) ? { generation: first.generation, snap } : null;
}

// Windows reads .CLAUDE/ or agents.md as the protected path, so the match ignores case there.
// Without the trailing slash: a directory symlink is a blob at the bare path, which `.claude/` never matches,
// while the bare pathspec still covers everything under a real directory.
function pathspecsOf(protectedPaths) {
  const bare = protectedPaths.map((p) => p.replace(/\/+$/, ''));
  return process.platform === 'win32' ? bare.map((p) => `:(icase)${p}`) : bare;
}

// Untracked files under `pathspecs` with their content, ignored ones included: git keeps no copy, so a rollback restores
// from this. Base64, so the copy can be saved in a reset intent and survive a crash.
async function untrackedFiles(worktree, pathspecs) {
  if (!pathspecs.length) return {};
  // No --exclude-standard: an ignored Protected File is still agent configuration, and an ignored test still runs.
  const paths = (await runGit(['ls-files', '--others', '-z', '--', ...pathspecs], { cwd: worktree })).stdout.split('\0').filter(Boolean);
  const files = {};
  for (const p of paths) {
    const full = join(worktree, p);
    files[p] = (await lstat(full)).isSymbolicLink() ? { link: await readlink(full) } : { base64: (await readFile(full)).toString('base64') };
  }
  return files;
}

const untrackedProtected = (worktree, protectedPaths) => untrackedFiles(worktree, pathspecsOf(protectedPaths));

const same = (a, b) => !!a && !!b && a.link === b.link && a.base64 === b.base64;

export async function begin({ record: rec, others, protectedPaths = [], testPathspecs = [] }) {
  const own = await snapshot(rec.worktree);
  const idle = {};
  for (const worktree of others) {
    const s = await idleSnapshot(rec.commonDir, worktree);
    if (s) idle[worktree] = s;
  }
  return { head: own.head, own, idle, untracked: await untrackedProtected(rec.worktree, protectedPaths),
    tests: await untrackedFiles(rec.worktree, testPathspecs) };
}

// What git clean leaves that a rollback must put back: the untracked Protected Files and tests of the baseline, and where to
// look for new ones. Ignored files outside these paths are neither detected nor rolled back (request 3.5).
export const rollbackSet = (baseline, protectedPaths, testPathspecs) =>
  ({ files: { ...baseline.untracked, ...baseline.tests }, pathspecs: [...pathspecsOf(protectedPaths), ...testPathspecs] });

// The agent may have swapped a parent directory for a link (or junction) out of the worktree; writing through it would
// change files outside. rm removes the link itself, never its target, and the restore recreates a real directory.
async function unlinkParents(worktree, p) {
  let dir = worktree;
  for (const part of p.split('/').slice(0, -1)) {
    dir = join(dir, part);
    const st = await lstat(dir).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!st) return;
    if (st.isSymbolicLink()) return rm(dir, { recursive: true, force: true });
  }
}

// git clean keeps ignored files, so after a reset a rollbackSet is put back by hand: new files removed, changed or deleted
// ones rewritten.
export async function restoreUntracked(worktree, { files: untracked, pathspecs }) {
  const now = await untrackedFiles(worktree, pathspecs);
  for (const p of Object.keys(now)) if (!untracked[p]) await rm(join(worktree, p), { recursive: true, force: true });
  for (const [p, file] of Object.entries(untracked)) {
    if (same(file, now[p])) continue;
    await unlinkParents(worktree, p);
    const full = join(worktree, p);
    await rm(full, { recursive: true, force: true });
    await mkdir(dirname(full), { recursive: true });
    await (file.link !== undefined ? symlink(file.link, full) : writeFile(full, Buffer.from(file.base64, 'base64')));
  }
}

const diffSurfaces = (worktree, before, after, surfaces) =>
  surfaces.filter((s) => before[s] !== after[s]).map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

export async function end({ baseline, record: rec, others, access, protectedPaths }) {
  const worktree = rec.worktree;
  const own = await snapshot(worktree);
  const violations = diffSurfaces(worktree, baseline.own, own, access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index']);

  // Against the fingerprint tree, not the real index, so index flags cannot hide an edit.
  const changed = (await git(['diff', '--name-only', baseline.head, own.tree, '--', ...pathspecsOf(protectedPaths)], worktree)).split('\n');
  // Untracked Protected Files that were already there and are unchanged are the owner's, not the agent's.
  const before = baseline.untracked ?? {};
  const now = await untrackedProtected(worktree, protectedPaths);
  const untracked = [...Object.keys(now), ...Object.keys(before)].filter((p) => !same(before[p], now[p]));
  const touched = [...new Set([...changed, ...untracked].filter(Boolean))];
  if (touched.length) violations.push({ worktree, surface: 'protected', before: null, after: touched });

  for (const other of others) {
    const start = baseline.idle[other];
    if (!start) continue;
    const now = await idleSnapshot(rec.commonDir, other);
    if (!now || now.generation !== start.generation) continue;
    violations.push(...diffSurfaces(other, start.snap, now.snap, ['head', 'index', 'tree']));
  }
  return { violations };
}
