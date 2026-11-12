// The reset Effect: the worktree reset to a baseline head with its untracked rollback files restored, and the History
// item that says why. It has no finder: an open reset is finished from the worktree as found (ADR-0005).
import type * as integrityModule from '../integrity.ts';
import type * as record from '../record.ts';
import type * as visit from '../visit.ts';
import type * as writeAhead from '../write-ahead.ts';
import type * as effects from './index.ts';

// The reset intent's payload (lib/rescue.ts): the baseline head, the History item it adds, what git clean leaves to
// restore, and the worktree as the agent left it.
export interface Payload {
  baseline: string;
  history: visit.HistoryItem;
  untracked?: integrityModule.RollbackSet;
  // An intent saved before the index was fingerprinted has no `index`.
  left?: Omit<integrityModule.WorktreeSnapshot, 'index'> & {
    index?: string;
    files?: integrityModule.UntrackedFiles;
  };
}

// The git verbs a reset is made with and its open intent's states are read with (lib/git.ts).
export interface ResetGit {
  treeOf(worktree: string, commit?: string): Promise<string>;
  treeDiff(worktree: string, from: string, to: string): Promise<{ path: string; change: string }[]>;
  resetTo(worktree: string, sha: string): Promise<unknown>;
  headSha(worktree: string): Promise<string>;
}

export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree' | 'history'>;
  git: ResetGit;
  integrity: Pick<integrityModule.Integrity, 'restoreUntracked'>;
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};

// The open reset intents of an Execution, which Reconciliation finishes before anything else.
export const openResets = (
  _executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): writeAhead.WriteAheadEntry[] => [];

// Finishes an open reset from the worktree as found, saving its evidence with its History item; 'held' when the
// worktree is in no state the reset can finish from, a human's, with nothing discarded.
export async function finish(
  _executionRecord: record.ExecutionRecord,
  _entry: writeAhead.WriteAheadEntry,
  _context: {
    git: ResetGit;
    integrity: integrityModule.Integrity;
    database: Pick<record.StateDatabase, 'evidence'>;
  },
): Promise<'held' | 'finished'> {
  return 'finished';
}
