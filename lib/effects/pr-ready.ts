// The pr-ready Effect: a PR marked ready for review, only at the commit its intent targets (R11d, T1a, M1). It has no
// finder: gh pr ready on a ready PR succeeds, so an open one is simply made again (N3).
import * as effectErrors from '../effect-errors.ts';
import type * as github from '../github.ts';
import * as integrity from '../integrity.ts';
import type * as locks from '../locks.ts';
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { number: number; sha: string | null; tree: string | null };

// What a PR is checked against before it is marked ready: the worktree, the commit's tree and the PR's head.
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree' | 'branch'>;
  git: integrity.IntegrityGit & { treeOf(worktree: string, commit?: string): Promise<string> };
  gh: Pick<github.Gh, 'viewPr' | 'markReady'>;
  cwd?: string;
  locks: locks.Locks | undefined;
}

// Why the target cannot be marked ready, or null: the worktree must be clean at the commit, and the PR's head that
// commit on gg's branch in this repository. A head that cannot be read proves nothing, so it holds too.
// shortcut: the head read and GitHub's ready call are not atomic, so a push between them cannot be excluded, as with
// GitHub's own required checks; close it if GitHub gains a ready call conditioned on the head.
async function unpublishable(context: Context, { sha, tree, number }: Payload): Promise<string | null> {
  const { record: executionRecord, git, gh, cwd } = context;
  if (!sha) return 'the record proves no pushed commit';
  const published = await git.treeOf(executionRecord.worktree, sha);
  if (tree !== published) return `its Check passed on tree ${tree}, not on tree ${published} of commit ${sha}`;
  const now = await integrity.snapshot(executionRecord.worktree, git, context.locks);
  if (now.head !== sha || now.index !== published || now.tree !== published)
    return `the worktree is not clean at commit ${sha}`;
  let pr;
  try {
    pr = await gh.viewPr(number, cwd);
  } catch (err) {
    return `its head could not be read (${String((err as Error | null)?.message ?? err).split('\n')[0]})`;
  }
  if (pr.isCrossRepository !== false || pr.headRefName !== executionRecord.branch || pr.headRefOid !== sha) {
    const where = pr.isCrossRepository === false ? '' : ' in another repository';
    return `its head is ${pr.headRefName} at ${pr.headRefOid}${where}, not ${executionRecord.branch} at ${sha}`;
  }
  return null;
}

// Each launch, a retry's or a resume's, checks the target again.
const perform: effects.Effect<Payload, Context>['perform'] = async (context, planned) => {
  const why = await unpublishable(context, planned);
  if (why)
    throw new effectErrors.EarlyTerminalError({
      next: 'hold',
      name: 'unchecked-publish',
      reason: `PR #${planned.number} was not marked ready: ${why}; nothing was published.`,
    });
  await context.gh.markReady(planned.number, context.cwd);
  return {};
};

export const effect: effects.Effect<Payload, Context> = {
  name: 'pr-ready',
  remote: 'GitHub',
  perform,
  repeatable: true,
};
