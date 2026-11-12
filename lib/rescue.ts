// The Rescue Ref and the write-ahead reset: one mechanism, which a failure routed to another Vertex (R5a) and an
// Interrupted Attempt (#68, ADR 0011) share. Whatever is rescued moves out of the worktree and is kept under
// refs/gg/rescue/, which only `gg work reset` removes; each step is write-ahead, so a crash neither repeats nor skips
// one.
import * as checks from './checks.ts';
import * as config from './config.ts';
import * as effectErrors from './effect-errors.ts';
import * as rescueEffect from './effects/rescue.ts';
import * as resetEffect from './effects/reset.ts';
import * as sideEffect from './effects/side-effect.ts';
import * as integrity from './integrity.ts';
import * as marker from './marker.ts';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import * as writeAhead from './write-ahead.ts';

// A marker's colons are not valid in a ref name (ADR 0011).
export const rescueRef = (actionMarker: string): string => `refs/gg/rescue/${config.sha256(actionMarker)}`;

const { held } = rescueEffect;

const isEnding = (err: unknown) => effectErrors.fatal(err) || err instanceof effectErrors.EarlyTerminalError;

// The History item is saved with the reset's evidence, so Reconciliation adds it exactly once. The intent saves what
// git clean leaves, so a crash after the reset can still finish the restore.
export async function reset(
  runContext: RunContext,
  { actionIdentity, ...given }: { actionIdentity: marker.ActionIdentity } & Omit<resetEffect.Payload, 'left'>,
) {
  const { record: executionRecord, git } = runContext;
  // The worktree as the agent left it: at admission, only dirty state that still matches this is proven the agent's.
  // The ignored Protected Files and tests are in it too: the tree cannot see them, but the restore rewrites them.
  const left = await sideEffect.whileBusy(runContext, async () => ({
    ...(await runContext.integrity.snapshot(executionRecord.worktree)),
    files: given.untracked
      ? await runContext.integrity.ignoredFiles(executionRecord.worktree, given.untracked.within)
      : {},
  }));
  const payload: resetEffect.Payload = {
    ...given,
    left: { head: left.head, index: left.index, tree: left.tree, files: left.files },
  };
  await sideEffect.whileBusy(runContext, () =>
    sideEffect.sideEffect(runContext, {
      actionMarker: runContext.markerOf(actionIdentity),
      effect: resetEffect.effect,
      payload,
    }),
  );
}

interface Rescuing {
  actionIdentity: marker.ActionIdentity;
  baseline: integrity.IntegrityBaseline;
  // The sentence the History item starts with: what failed.
  failure: string;
}
type RollbackSet = integrity.RollbackSet;

// The worktree is the baseline's: its HEAD, its index, its tree, and the untracked files a restore would put back.
async function atBaseline(
  runContext: RunContext,
  { head, own }: integrity.IntegrityBaseline,
  untracked: RollbackSet,
): Promise<boolean> {
  const worktree = runContext.record.worktree;
  const now = await runContext.integrity.snapshot(worktree);
  if (now.head !== head || now.index !== own.index || now.tree !== own.tree) return false;
  return integrity.sameFiles(untracked.files, await runContext.integrity.untrackedFiles(worktree, untracked.within));
}

// What the rescue is to make, read before its intent, or null when the worktree equals the baseline, with nothing to
// rescue (N4). A reset touches only what gg's records prove the agent's (R5d): the agent cannot have moved HEAD or the
// index without an Integrity Violation, so that holds. An unmerged index never reaches a reset: a snapshot faults on
// it, or, once a rescue has begun, the ref's verification or the reset's own snapshot holds.
async function planRescue(
  runContext: RunContext,
  { actionIdentity, baseline, failure }: Rescuing,
  untracked: RollbackSet,
): Promise<rescueEffect.Payload | null> {
  const { record: executionRecord, git } = runContext;
  const { worktree } = executionRecord;
  if (await atBaseline(runContext, baseline, untracked)) return null;
  const left = await runContext.integrity.snapshot(worktree);
  if (left.head !== baseline.head || left.index !== baseline.own.index)
    throw held(
      `HEAD or the index moved since the Visit's baseline when ${failure}, so it cannot be proven the agent's; no ` +
        'Rescue Ref was made and nothing was reset.',
    );
  const actionMarker = runContext.markerOf({ ...actionIdentity, action: 'rescue' });
  const tree = await git.rescueTree(worktree, { within: untracked.within });
  const message = `gg rescue: ${failure}\n\n${marker.markerTrailer(actionMarker)}`;
  const commit = await git.rescueCommit(worktree, { tree, parent: left.head, message });
  return { ref: rescueRef(actionMarker), commit, tree, parent: left.head, left };
}

// A rescue that does not hold what is in the worktree would lose work in the reset.
async function verifyRef(runContext: RunContext, { ref }: rescueEffect.Payload, untracked: RollbackSet) {
  const { git, record: executionRecord } = runContext;
  const { worktree } = executionRecord;
  const now = await git.rescueTree(worktree, { within: untracked.within });
  if (now !== (await git.treeOf(worktree, ref)))
    throw held(`Rescue Ref ${ref} does not match the worktree, which something has changed since; nothing was reset.`);
}

// The reset once its ref holds the work, checked against the baseline. A reset that fails holds with the state rescued.
async function resetRescued(
  runContext: RunContext,
  { actionIdentity, baseline, failure }: Rescuing,
  { ref }: rescueEffect.Payload,
  untracked: RollbackSet,
) {
  const named = `Rescue Ref ${ref} keeps the work`;
  try {
    await reset(runContext, {
      actionIdentity: { ...actionIdentity, action: 'reset' },
      baseline: baseline.head,
      history: {
        kind: 'rescued',
        text: `${failure}. ${named}, and the worktree was reset to the Visit's baseline head.`,
      },
      untracked,
    });
  } catch (err) {
    if (isEnding(err)) throw err;
    throw held(`The reset after ${failure} failed: ${(err as Error).message}. ${named}; nothing more was discarded.`);
  }
  if (!(await sideEffect.whileBusy(runContext, () => atBaseline(runContext, baseline, untracked))))
    throw held(`The reset after ${failure} did not leave the worktree at its baseline. ${named}.`);
}

// Rescues the worktree to a Rescue Ref and resets it to `baseline`, or does nothing and returns null when it already
// equals it (N4). The caller must first have confirmed the work's writers gone (N1, L6): a surviving writer could write
// after the ref's verification. Anything that cannot be proven or done holds the Ticket, naming the ref.
export async function rescueAndReset(
  runContext: RunContext,
  rescuing: Rescuing,
): Promise<{ ref: string; commit: string } | null> {
  const { actionIdentity, baseline } = rescuing;
  const { record: executionRecord, protectedPaths } = runContext;
  const actionMarker = runContext.markerOf({ ...actionIdentity, action: 'rescue' });
  const resetMarker = runContext.markerOf({ ...actionIdentity, action: 'reset' });
  const { testPaths } = executionRecord.configurationSnapshot!;
  const untracked = integrity.rollbackSet(baseline, protectedPaths, checks.testPathSet(testPaths));

  const intended = writeAhead.findEntry(executionRecord, actionMarker, 'intent')?.payload as
    rescueEffect.Payload | undefined;
  const payload =
    intended ?? (await sideEffect.whileBusy(runContext, () => planRescue(runContext, rescuing, untracked)));
  if (!payload) return null;
  const answer = { ref: payload.ref, commit: payload.commit };
  if (writeAhead.findEntry(executionRecord, actionMarker, 'complete')) return answer;

  const startedAt = runContext.clock.now();
  await sideEffect.whileBusy(runContext, () =>
    sideEffect.sideEffect(runContext, { actionMarker, effect: rescueEffect.effect, payload, deferred: true }),
  );
  if (!writeAhead.findEntry(executionRecord, resetMarker, 'intent')) {
    await sideEffect.whileBusy(runContext, () => verifyRef(runContext, payload, untracked));
    effectErrors.crashPoint(runContext, resetMarker, 'before-intent');
  }
  await resetRescued(runContext, rescuing, payload, untracked);
  runContext.database.complete(executionRecord, actionMarker, {
    event: () =>
      runContext.emit({ ...actionIdentity, action: 'rescue' }, startedAt, {
        outcome: 'ok',
        direction: 'advance',
        rule: { table: 'fixed', row: 'effect-completed' },
        signals: {},
      }),
  });
  effectErrors.crashPoint(runContext, actionMarker, 'after-completion');
  return answer;
}
