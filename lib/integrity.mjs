import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const snap = await snapshot(worktree);
  const second = await readActivity(commonDir, worktree);
  return !first.busy && !second.busy && first.generation === second.generation ? { generation: first.generation, snap } : null;
}

export async function begin({ record: rec, others }) {
  const own = await snapshot(rec.worktree);
  const idle = {};
  for (const worktree of others) {
    const s = await idleSnapshot(rec.commonDir, worktree);
    if (s) idle[worktree] = s;
  }
  return { head: own.head, own, idle };
}

const diffSurfaces = (worktree, before, after, surfaces) =>
  surfaces.filter((s) => before[s] !== after[s]).map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

export async function end({ baseline, record: rec, others, access, protectedPaths }) {
  const worktree = rec.worktree;
  const own = await snapshot(worktree);
  const violations = diffSurfaces(worktree, baseline.own, own, access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index']);

  const changed = await git(['diff', '--name-only', baseline.head, '--', ...protectedPaths], worktree);
  // No --exclude-standard: an ignored Protected File is still agent configuration.
  const added = await git(['ls-files', '--others', '--', ...protectedPaths], worktree);
  const touched = [changed, added].join('\n').split('\n').filter(Boolean);
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
