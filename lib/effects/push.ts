// The push Effect: the commit the record proves checked, pushed to its branch on origin.
import type * as record from '../record.ts';
import * as effects from './index.ts';

export type Payload = { branch: string; sha: string };

// The git verbs a push is made with (lib/git.ts).
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree'>;
  git: {
    push(worktree: string, branch: string, sha: string): Promise<unknown>;
    remoteSha(worktree: string, branch: string): Promise<string | null>;
  };
}

// A push is made only when origin then holds the intended commit.
const perform: effects.Effect<Payload, Context>['perform'] = async ({ record: executionRecord, git }, planned) => {
  await git.push(executionRecord.worktree, planned.branch, planned.sha);
  const remoteSha = await git.remoteSha(executionRecord.worktree, planned.branch);
  if (remoteSha !== planned.sha)
    throw new Error(`origin has ${planned.branch} at ${remoteSha}, not the intended ${planned.sha}`);
  return { remoteSha };
};

const find: effects.FindEffect = async ({ actionMarker, payload }, { executionRecord, git }) => {
  const { branch, sha } = payload as Payload;
  if ((await git!.remoteSha(executionRecord.worktree, branch)) === sha) return effects.found({ remoteSha: sha });
  const head = await git!.branchHead(executionRecord.worktree, branch);
  if (head !== sha)
    return effects.conflicting(
      `The push of Action Marker ${actionMarker} was not made and ${branch} has moved from ${sha} to ${head}; ` +
        'nothing was pushed.',
    );
  return effects.ABSENT;
};

export const effect: effects.Effect<Payload, Context> = { name: 'push', remote: 'origin', perform, find };
