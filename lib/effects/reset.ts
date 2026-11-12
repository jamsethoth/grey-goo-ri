// The reset Effect: the worktree reset to a baseline head with its untracked rollback files restored, and the History
// item that says why. It has no finder: an open reset is finished from the worktree as found (ADR-0005).
import * as integrityModule from '../integrity.ts';
import type * as record from '../record.ts';
import type * as visit from '../visit.ts';
import type * as writeAhead from '../write-ahead.ts';
import * as effects from './index.ts';

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

type Integrity = integrityModule.Integrity;

// The History item is pushed with the reset's evidence, so Reconciliation adds it exactly once.
const perform: effects.Effect<Payload, Context>['perform'] = async (
  { record: executionRecord, git, integrity },
  payload,
) => {
  await git.resetTo(executionRecord.worktree, payload.baseline);
  if (payload.untracked) await integrity.restoreUntracked(executionRecord.worktree, payload.untracked);
  // HEAD is read first: nothing awaited may sit between the History push and saving the evidence that proves it.
  const head = await git.headSha(executionRecord.worktree);
  executionRecord.history.push(payload.history);
  return { head };
};

const ignoredOf = async (worktree: string, untracked: integrityModule.RollbackSet | undefined, integrity: Integrity) =>
  untracked ? integrity.ignoredFiles(worktree, integrityModule.withinOf(untracked)) : {};

// Where an open reset can be found: 'left' while the worktree is exactly as the agent left it, ignored Protected Files
// and tests included; 'cleaning' between git.resetTo's hard reset and its clean, the tracked files back and every
// untracked one as the agent left it; 'restoring' once the git reset landed, however far its restore of untracked files
// got, each rollback file being absent, as the agent left it or restored; null for anything else, which is a human's
// (ADR-0005).
async function resetState(
  worktree: string,
  { baseline, untracked, left }: Payload,
  git: ResetGit,
  integrity: Integrity,
): Promise<'left' | 'cleaning' | 'restoring' | null> {
  const now = await integrity.snapshot(worktree);
  const tree = await git.treeOf(worktree, baseline);
  const hardReset = now.head === baseline && now.index === tree;
  if (hardReset && (await onlyRestored(worktree, { from: tree, to: now.tree, untracked, left }, git, integrity)))
    return 'restoring';
  // An intent saved before the index was fingerprinted proves nothing.
  if (!left?.index) return null;
  if (!integrityModule.sameFiles(left.files ?? {}, await ignoredOf(worktree, untracked, integrity))) return null;
  if (now.head === left.head && now.index === left.index && now.tree === left.tree) return 'left';
  return hardReset && (await onlyLeftBehind(worktree, { from: tree, to: now.tree, left: left.tree }, git))
    ? 'cleaning'
    : null;
}

// The flag-aware tree differs from the baseline only by added files, each as the tree the agent left has it.
async function onlyLeftBehind(
  worktree: string,
  { from, to, left }: { from: string; to: string; left: string },
  git: ResetGit,
): Promise<boolean> {
  const differs = new Set((await git.treeDiff(worktree, to, left)).map(({ path }) => path));
  return (await git.treeDiff(worktree, from, to)).every(({ path, change }) => change === 'added' && !differs.has(path));
}

// Each rollback file is absent, as the agent left it or restored, and the flag-aware tree differs from the baseline
// only by untracked files the restore has put back with their saved bytes.
async function onlyRestored(
  worktree: string,
  { from, to, untracked, left }: { from: string; to: string } & Pick<Payload, 'untracked' | 'left'>,
  git: ResetGit,
  integrity: Integrity,
): Promise<boolean> {
  const saved = untracked?.files ?? {};
  const files = untracked ? await integrity.untrackedFiles(worktree, integrityModule.withinOf(untracked)) : {};
  const eachKnown = Object.entries(files).every(
    ([path, file]) =>
      integrityModule.sameFile(file, left?.files?.[path]) || integrityModule.sameFile(file, saved[path]),
  );
  if (!eachKnown) return false;
  if (from === to) return true;
  return (await git.treeDiff(worktree, from, to)).every(
    ({ path, change }) => change === 'added' && integrityModule.sameFile(files[path], saved[path]),
  );
}

// The worktree in any state the open reset can be finished from.
const proves: NonNullable<effects.Effect<Payload, Context>['proves']> = async (
  { payload },
  worktree,
  { git, integrity },
) => (await resetState(worktree, payload as Payload, git, integrity)) !== null;

export const effect: effects.Effect<Payload, Context> = { name: 'reset', remote: null, perform, proves };

// The open reset intents of an Execution, which Reconciliation finishes before anything else.
export const openResets = (
  executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): writeAhead.WriteAheadEntry[] => effects.openIntents(executionRecord, effect);

// An open reset is made now while the worktree is as the agent left it or partway through it, where the reset changes
// no tracked file again, and its restore is replayed once the reset landed; restoreUntracked skips files already back.
// Anything else is a human's and held, nothing discarded, and the History item waits in the intent.
export async function finish(
  executionRecord: record.ExecutionRecord,
  entry: writeAhead.WriteAheadEntry,
  {
    git,
    integrity,
    database,
  }: { git: ResetGit; integrity: Integrity; database: Pick<record.StateDatabase, 'evidence'> },
): Promise<'held' | 'finished'> {
  const payload = entry.payload as Payload;
  let state = await resetState(executionRecord.worktree, payload, git, integrity);
  if (state === 'left' || state === 'cleaning') {
    await git.resetTo(executionRecord.worktree, payload.baseline);
    state = await resetState(executionRecord.worktree, payload, git, integrity);
  }
  if (state !== 'restoring') return 'held';
  if (payload.untracked) await integrity.restoreUntracked(executionRecord.worktree, payload.untracked);
  const head = await git.headSha(executionRecord.worktree);
  executionRecord.history.push(payload.history);
  database.evidence(executionRecord, entry.actionMarker, { head });
  return 'finished';
}
