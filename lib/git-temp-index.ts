// What lib/git.ts reads through a copy of the index, so the real one stays as it is: a worktree's fingerprint, and a
// rescue's tree. Each writes objects, so callers hold the repo lock.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as git from './git.ts';
import type * as integrity from './integrity.ts';

// `read` over a copy of the index that `add -A` has staged into, with index flags cleared, so neither an unstaged edit
// nor one that assume-unchanged or skip-worktree hides goes unseen.
async function inTempIndex<Result>(
  { git, runGit }: git.Runner,
  worktree: string,
  read: (env: { GIT_INDEX_FILE: string }) => Promise<Result>,
): Promise<Result> {
  const tempDir = await mkdtemp(join(tmpdir(), 'gg-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(tempDir, 'index') };
    const index = await git(['rev-parse', '--git-path', 'index'], worktree);
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
    return await read(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// HEAD, the index's tree, and the tree `add -A` would stage (inTempIndex).
export const fingerprint = (gitRunner: git.Runner, worktree: string): Promise<integrity.WorktreeSnapshot> =>
  inTempIndex(gitRunner, worktree, async (env) => ({
    head: await gitRunner.git(['rev-parse', 'HEAD'], worktree),
    index: await gitRunner.git(['write-tree'], worktree),
    tree: await gitRunner.git(['write-tree'], worktree, env),
  }));

// The tree of everything a rescue keeps (ADR 0011): what `add -A` stages, and the ignored files within `pathspecs`,
// which it skips. update-index takes their paths literally and does not read the ignore rules, so it adds them as
// `add -f` would.
export const rescueTree = (gitRunner: git.Runner, cwd: string, pathspecs: string[] | null): Promise<string> =>
  inTempIndex(gitRunner, cwd, async (env) => {
    const listing = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...(pathspecs ?? [])];
    const ignored = pathspecs ? await gitRunner.listPaths(listing, cwd, env) : [];
    if (ignored.length)
      await gitRunner.runGit(['update-index', '--add', '-z', '--stdin'], { cwd, env, input: ignored.join('\0') });
    return gitRunner.git(['write-tree'], cwd, env);
  });
