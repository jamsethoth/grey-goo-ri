// The rescue Effect: a Rescue Ref created at the commit that keeps the worktree's work, never over another (ADR 0011).
import * as effectErrors from '../effect-errors.ts';
import type * as integrity from '../integrity.ts';
import type * as record from '../record.ts';
import type * as effects from './index.ts';

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
export const held = (reason: string) => new effectErrors.EarlyTerminalError({ next: 'pending', reason });

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};

// The ref and commit an unfinished rescue intends. Its intent comes before its ref, so a caller that could run before
// the ref was made asks git whether it holds that commit.
export const openRescue = (
  _executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): { ref: string; commit: string } | null => null;
