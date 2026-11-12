// The commit Effect: a commit of the tree the Action staged, on the parent it recorded, carrying its Action Marker.
import type * as record from '../record.ts';
import type * as writeAhead from '../write-ahead.ts';
import * as effects from './index.ts';

export type Payload = { message: string; tree: string; parent: string };

// The git verbs a commit is made with (lib/git.ts).
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree'>;
  git: {
    commitTree(worktree: string, payload: Payload): Promise<string | null>;
    commitStaged(worktree: string, message: string): Promise<string | null>;
  };
}

// A commit intended before a restart is redone from its recorded tree and parent, never from what is staged now, so a
// human edit made since stays in the worktree uncommitted.
const perform: effects.Effect<Payload, Context>['perform'] = async (
  { record: executionRecord, git },
  planned,
  launch,
) => ({
  sha: launch.redo
    ? await git.commitTree(executionRecord.worktree, planned)
    : await git.commitStaged(executionRecord.worktree, planned.message),
});

const find: effects.FindEffect = async ({ actionMarker, payload }, { executionRecord, git }) => {
  const { parent, tree: intendedTree } = payload as Payload;
  for (const { sha, parents, tree, message } of await git!.commitLog(
    executionRecord.worktree,
    executionRecord.branch,
  )) {
    if (!effects.carries(message, actionMarker)) continue;
    if (parents.length === 1 && parents[0] === parent && tree === intendedTree) return effects.found({ sha });
    return effects.conflicting(
      `Commit ${sha} carries the Action Marker ${actionMarker} but not the intended parent and tree, ` +
        'so it was changed by hand; nothing was committed or discarded.',
    );
  }
  // The commit is redone from the recorded tree on the recorded parent, so both must still be there.
  const head = await git!.headSha(executionRecord.worktree);
  if (head !== parent || !(await git!.hasTree(executionRecord.worktree, intendedTree))) {
    return effects.conflicting(
      `The commit of Action Marker ${actionMarker} was not made and the branch is no longer at its intended parent ` +
        'and tree; nothing was committed or discarded.',
    );
  }
  return effects.ABSENT;
};

// The recorded parent, with the tree the commit staged in the index and the worktree.
const proves: NonNullable<effects.Effect<Payload, Context>['proves']> = async (
  { payload },
  worktree,
  { integrity },
) => {
  const { parent, tree } = payload as Payload;
  const now = await integrity.snapshot(worktree);
  return now.head === parent && now.index === tree && now.tree === tree;
};

export const effect: effects.Effect<Payload, Context> = { name: 'commit', remote: null, perform, find, proves };

// The last commit gg made, by its marker and sha, or undefined before its first: the branch must still be at its sha.
// A commit with nothing to commit saves a null sha.
export function lastCommit(
  executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): { actionMarker: string; sha: string } | undefined {
  const last = executionRecord.writeAheadLog.findLast(
    (entry: writeAhead.WriteAheadEntry) =>
      entry.step === 'evidence' && entry.effect === effect.name && typeof entry.evidence?.sha === 'string',
  );
  return last && { actionMarker: last.actionMarker, sha: last.evidence!.sha as string };
}
