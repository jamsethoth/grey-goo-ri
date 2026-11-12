// The rescue Effect: a Rescue Ref created at the commit that keeps the worktree's work, never over another (ADR 0011).
import * as effectErrors from '../effect-errors.ts';
import type * as integrity from '../integrity.ts';
import type * as record from '../record.ts';
import * as effects from './index.ts';

// The rescue intent's payload, saved before any effect: the ref, the commit it is to hold and that commit's tree and
// parent, and the worktree as the rescue found it, which at resume proves its uncommitted changes the agent's.
export interface Payload {
  ref: string;
  commit: string;
  tree: string;
  parent: string;
  left: integrity.WorktreeSnapshot;
}

// The git verbs a Rescue Ref is made with (lib/git.ts).
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree'>;
  git: {
    createRef(worktree: string, ref: string, sha: string): Promise<boolean>;
    refTarget(worktree: string, ref: string): Promise<string | null>;
  };
}

// A rescue that cannot be proven or made holds the Ticket, naming what it kept.
export const held = (reason: string) => new effectErrors.EarlyTerminalError({ next: 'hold', name: 'rescue', reason });

// The ref is created only when absent, so an earlier rescue is never overwritten; one already holding this commit is a
// repeat of this rescue.
const perform: effects.Effect<Payload, Context>['perform'] = async (
  { record: executionRecord, git },
  { ref, commit },
) => {
  if (await git.createRef(executionRecord.worktree, ref, commit)) return { ref, commit };
  const found = await git.refTarget(executionRecord.worktree, ref);
  if (found === commit) return { ref, commit };
  throw held(`Rescue Ref ${ref} already holds ${found}, so nothing was overwritten or reset.`);
};

// The ref holds the intended commit, or is absent and so is made, or holds another, which is never overwritten.
const find: effects.FindEffect = async ({ actionMarker, payload }, { executionRecord, git }) => {
  const { ref, commit } = payload as Payload;
  const target = await git!.refTarget(executionRecord.worktree, ref);
  if (target === null) return effects.ABSENT;
  if (target === commit) return effects.found({ ref, commit });
  return effects.conflicting(
    `Rescue Ref ${ref} of Action Marker ${actionMarker} holds ${target}, not the intended ${commit}; nothing was ` +
      'overwritten or reset.',
  );
};

// The worktree as the rescue found it.
const proves: NonNullable<effects.Effect<Payload, Context>['proves']> = async (
  { payload },
  worktree,
  { integrity },
) => {
  const { left } = payload as Payload;
  const now = await integrity.snapshot(worktree);
  return now.head === left.head && now.index === left.index && now.tree === left.tree;
};

export const effect: effects.Effect<Payload, Context> = { name: 'rescue', remote: null, perform, find, proves };

// The ref and commit an unfinished rescue intends. Its intent comes before its ref, so a caller that could run before
// the ref was made asks git whether it holds that commit.
export function openRescue(
  executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): { ref: string; commit: string } | null {
  const open = effects.openIntents(executionRecord, effect);
  if (!open[0]) return null;
  const { ref, commit } = open[0].payload as Payload;
  return { ref, commit };
}
