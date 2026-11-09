// The branch a repository's Tickets start from by default, which gg init writes as baseBranch.
import type * as git from './git.ts';

export const DEFAULT_BRANCH_UNKNOWN =
  "cannot tell the default branch: origin names none and HEAD is detached; check out the repository's default branch " +
  'and re-run';

// origin's HEAD, as the clone recorded it or, for a clone of an empty origin, as origin says; else the checked-out
// branch. A detached HEAD with no origin to ask cannot say.
export async function defaultBranch({ runGit }: git.Runner, cwd: string): Promise<string> {
  const ask = async (...args: string[]) => {
    const result = await runGit(args, { cwd, allowFail: true });
    return result.code === 0 ? result.stdout.trim() : '';
  };
  const recorded = (await ask('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).replace(
    /^origin\//,
    '',
  );
  const named = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(await ask('ls-remote', '--symref', 'origin', 'HEAD'))?.[1];
  const current = (await ask('symbolic-ref', '--quiet', '--short', 'HEAD')) || undefined;
  const branch = recorded || named || current;
  if (!branch) throw new Error(DEFAULT_BRANCH_UNKNOWN);
  return branch;
}
