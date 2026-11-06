// The remote Actions' effects, on GitHub or origin: each launch retried on a recognised transient failure after a
// backoff whose budget is saved first, its effect looked for by marker before a retry, and the repo-lock guard that
// checks a queued git write again once it holds the lock.
import * as effectErrors from './effect-errors.ts';
import * as effectEvidence from './effect-evidence.ts';
import type * as effects from './effects.ts';
import * as flow from './flow.ts';
import * as integrity from './integrity.ts';
import * as labels from './labels.ts';
import * as marker from './marker.ts';
import * as outcome from './outcome.ts';
import * as reconcile from './reconcile.ts';
import type * as record from './record.ts';
import * as writeAhead from './write-ahead.ts';

type Evidence = Record<string, unknown>;

// The Actions whose effect is on GitHub or origin. A recognised transient failure is retried inside the Action, on a
// budget saved in the record before each wait, so a crash cannot refill it (#66).
export const REMOTE_ACTIONS = ['comment', 'pr-upsert', 'push', 'pr-ready'];
const REMOTE_RETRIES = 2;
const actionKey = (actionMarker: string) => marker.actionKeyOf(marker.partsOf(actionMarker));
const remoteRetry = (executionRecord: record.ExecutionRecord, actionMarker: string) =>
  executionRecord.retries[actionKey(actionMarker)]?.remote;

// A run stop latched while a remote Action backs off, in a Visit, Reconciliation's lookup or ready-for-qa's Terminal:
// decide() ends the Execution at needs-human as one found before an Action does (#85).
class RunStoppedError extends effectErrors.EarlyTerminalError {
  name = 'RunStoppedError';
  constructor(ending: effectErrors.RunStoppedEnding) {
    super(ending);
  }
}

const errorText = (err: unknown) => (err as Error | null | undefined)?.message || String(err);
// A run stop ends an Execution at a Vertex or at ready-for-qa; at needs-human or needs-replan, the Terminal a stop
// leads to, the report goes on.
const stopApplies = (vertex: string) => !flow.isEnd(vertex) || vertex === 'ready-for-qa';

// A needs-human, needs-replan, hold, fault or abandonment report is what a stop leads to, so only it goes on.
// `retrying` is false for a repo-lock wait, which keeps no retry.
function checkStop(context: effects.EffectContext, { retrying = true }: { retrying?: boolean } = {}) {
  const stop = context.runState.stop;
  if (!stop || !stopApplies(context.record.cursor.vertex)) return;
  const during = retrying ? 'a backoff' : 'a repo-lock wait';
  throw new RunStoppedError({
    next: 'run-stopped',
    retrying,
    reason: `Ticket #${stop.ticket} stopped the run with class ${stop.failureClass} during ${during}.`,
  });
}

// A retry deadline is never further away than this; a later or non-numeric one is corrupt, and held rather than waited
// for.
const MAX_RETRY_WAIT = 31 * 24 * 3_600_000;
// Node fires a timer longer than 2^31 - 1 ms at once, so a backoff sleeps in chunks of at most this.
const MAX_SLEEP = 3_600_000;

function eligibleAt(context: effects.EffectContext, actionMarker: string, eligible: number): number {
  if (Number.isFinite(eligible) && eligible >= 0 && eligible <= context.clock.now() + MAX_RETRY_WAIT) return eligible;
  // A time Date can show is logged as one; anything else as the value saved.
  const shown =
    Number.isFinite(eligible) && Math.abs(eligible) <= 8.64e15
      ? new Date(eligible).toISOString()
      : JSON.stringify(eligible);
  const key = actionKey(actionMarker);
  context.log(`#${context.record.ticket} ${key}: retry deadline ${shown} is not a time within 31 days, so it is held`);
  throw new effectErrors.EarlyTerminalError({
    next: 'hold',
    reason: `The retry of ${key} has a deadline gg will not wait for, so the Ticket is held with its retry as saved.`,
  });
}

// A remote Action's launch that failed: its marker, when the Action began, and the error.
interface FailedLaunch {
  actionMarker: string;
  startedAt: number;
  err: unknown;
}

// A remote Action whose Attempt fails for good records its Action Event where it fails, in a Visit or a Terminal alike:
// its class, its error, and the outcome and rule of what it leads to, a run stop or a fault (#251). Its save failing is
// fatal, as any Event's is.
function failedEvent(
  context: effects.EffectContext,
  { actionMarker, startedAt, err }: FailedLaunch,
  { failureClass, consequence }: { failureClass: outcome.FailureClass; consequence: 'run-stop' | 'fault' },
) {
  const { vertex, visit: visitNumber, action, recovery, attempt } = marker.partsOf(actionMarker);
  const snapshot = context.record.configurationSnapshot;
  // A Terminal's report runs outside any Procedure.
  const inVisit = snapshot?.vertex === vertex && snapshot.visit === Number(visitNumber);
  const event = () =>
    context.emit(
      {
        vertex,
        visit: Number(visitNumber),
        procedure: inVisit ? snapshot.procedure.name : null,
        action,
        recovery: Number(recovery),
        attempt: Number(attempt),
      },
      startedAt,
      {
        outcome: consequence,
        direction: 'stop',
        rule: { table: 'fixed', row: consequence },
        signals: {},
        failureClass,
        error: errorText(err),
      },
    );
  return context.database.save(context.record, event);
}

// A final remote failure names its Action and class in the Terminal Reason. One whose class reaches the whole Run
// latches the run stop, as a Harness run stop does, and ends this Execution at needs-human; in a Terminal's own report,
// which is what a stop leads to, it is only latched (#240). The latch comes first, so the Run stops even when the
// Event's save fails.
async function finalFailure(context: effects.EffectContext, failed: FailedLaunch, failure: outcome.RemoteFailure) {
  const { failureClass, status } = failure;
  const { err } = failed;
  const source = writeAhead.effectOf(context.record, failed.actionMarker) ?? 'remote Action';
  const { reach } = outcome.FAILURE_CLASSES[failureClass];
  const stops = reach === 'run' && stopApplies(context.record.cursor.vertex);
  if (reach === 'run') context.runState.stop ??= { failureClass, ticket: context.record.ticket, source };
  // A relaunch refused with its budget spent is unknown to the classifier; its Event names the class its retries were
  // spent on.
  const eventClass = err instanceof effectErrors.RetriesExhaustedError ? err.spent.failureClass : failureClass;
  await failedEvent(context, failed, { failureClass: eventClass, consequence: stops ? 'run-stop' : 'fault' });
  if (stops)
    return new effectErrors.EarlyTerminalError({
      next: 'run-stop',
      failureClass,
      source,
      detail: errorText(err),
      reason: `The ${source} failed with class ${failureClass}.`,
    });
  // An unknown failure stays an unexpected fault.
  if (failureClass !== 'unknown' && err && typeof err === 'object')
    (err as { remoteFailure?: effectErrors.FinalRemoteFailure }).remoteFailure = {
      failureClass,
      status,
      reach,
      effect: source,
    };
  return err;
}

// Spends one retry on a recognised transient failure, and saves it with its deadline, which the Run's shared cooldown
// also waits for, before any wait. Any other failure, or one past the budget, is rethrown.
async function reserveRetry(context: effects.EffectContext, failed: FailedLaunch) {
  const { record: executionRecord } = context;
  const { actionMarker, err } = failed;
  const failure = outcome.classifyRemoteFailure(err as outcome.RemoteError);
  const spent = remoteRetry(executionRecord, actionMarker)?.count ?? 0;
  if (!failure.retryable) throw await finalFailure(context, failed, failure);
  if (spent >= REMOTE_RETRIES) {
    await failedEvent(context, failed, { failureClass: failure.failureClass, consequence: 'fault' });
    context.log(
      `#${executionRecord.ticket} ${actionKey(actionMarker)}: ${failure.failureClass} failure, retries exhausted ` +
        `after ${spent} of ${REMOTE_RETRIES}`,
    );
    // The fault's Terminal Reason says the budget ran out, not that the fault was unexpected.
    if (err && typeof err === 'object')
      throw new effectErrors.RetriesExhaustedError(
        errorText(err),
        {
          failureClass: failure.failureClass,
          status: failure.status,
          count: spent,
          effect: writeAhead.effectOf(executionRecord, actionMarker),
        },
        { cause: err },
      );
    throw err;
  }
  const now = context.clock.now();
  const retry: effects.RemoteRetry = {
    count: spent + 1,
    failureClass: failure.failureClass,
    nextEligibleAt: eligibleAt(context, actionMarker, now + outcome.remoteRetryDelay(failure, spent + 1, now)),
    started: false,
  };
  (executionRecord.retries[actionKey(actionMarker)] ??= {}).remote = retry;
  context.runState.remoteNotBefore = Math.max(context.runState.remoteNotBefore, retry.nextEligibleAt);
  context.log(
    `#${executionRecord.ticket} ${actionKey(actionMarker)}: ${failure.failureClass} failure, retry ${retry.count} of ` +
      `${REMOTE_RETRIES} at ${new Date(retry.nextEligibleAt).toISOString()}`,
  );
  await context.database.save(executionRecord);
  effectErrors.crashPoint(context, actionMarker, 'after-retry-saved');
}

// Waits out the Action's saved retry deadline and the Run's shared cooldown, whichever is later; true if it waited.
// A wait leaves the labels last read stale (`labelsStale`), wherever it happened, Reconciliation's lookup included.
// A busy worktree is idle while it waits, so other Tickets' integrity checks see a stray write into it, and busy again
// before the lookup and the launch. A run stop is checked before each sleep and after the last.
async function cooldown(context: effects.EffectContext, actionMarker: string): Promise<boolean> {
  const { record: executionRecord } = context;
  const busy = executionRecord.activity.busy;
  const deadline = () => {
    const retry = remoteRetry(executionRecord, actionMarker);
    return Math.max(
      retry ? eligibleAt(context, actionMarker, retry.nextEligibleAt) : 0,
      context.runState.remoteNotBefore,
    );
  };
  let waited = false;
  for (;;) {
    const wait = deadline() - context.clock.now();
    if (!(wait > 0)) break;
    checkStop(context);
    if (busy && !waited) await integrity.markIdle(executionRecord, context.database);
    context.labelsStale = true;
    waited = true;
    await context.clock.sleep(Math.min(wait, MAX_SLEEP));
  }
  if (!waited) return false;
  if (busy) await integrity.markBusy(executionRecord, context.database);
  checkStop(context);
  return true;
}

// A launch that had started when the process stopped may have landed or not; Reconciliation's lookup found it absent,
// so launching it again spends a new retry, saved first, and none is left once the budget is spent.
async function relaunch(context: effects.EffectContext, actionMarker: string, retry: effects.RemoteRetry) {
  if (retry.count >= REMOTE_RETRIES) {
    const message =
      `Action Marker ${actionMarker} was launched again for its last retry, which did not finish; with its retries ` +
      'spent it is not launched again.';
    // A budget spent on transient failures says so in the Terminal Reason, as reserveRetry's does; no status is saved.
    if (!retry.failureClass) throw new Error(message);
    context.log(
      `#${context.record.ticket} ${actionKey(actionMarker)}: ${retry.failureClass} failure, retries exhausted after ` +
        `${retry.count} of ${REMOTE_RETRIES}`,
    );
    throw new effectErrors.RetriesExhaustedError(message, {
      failureClass: retry.failureClass,
      status: null,
      count: retry.count,
      effect: writeAhead.effectOf(context.record, actionMarker),
    });
  }
  Object.assign(retry, { count: retry.count + 1, nextEligibleAt: context.clock.now(), started: false });
  await context.database.save(context.record);
}

// Looks for a remote Action's effect by its marker. A failed lookup proves nothing, so it is retried on the Action's
// budget; only a lookup that worked can find the effect absent.
export async function findEffectRetrying(
  context: effects.EffectContext,
  entry: writeAhead.WriteAheadEntry,
  finderContext: effectEvidence.EvidenceContext,
): Promise<effectEvidence.FindResult> {
  const startedAt = context.clock.now();
  for (;;) {
    await cooldown(context, entry.actionMarker);
    const found = await effectEvidence.findEffect(entry, finderContext);
    if (found.status !== 'unknown') return found;
    await reserveRetry(context, { actionMarker: entry.actionMarker, startedAt, err: found.error });
  }
}

type RemoteEntry = Pick<writeAhead.WriteAheadEntry, 'actionMarker' | 'effect' | 'payload'>;

// Every retry, and every launch after a wait since the labels were read, first checks the human override and looks for
// the effect again, whether or not it had started (a pending report's has): `found` with its evidence, `again` when
// another Ticket raised the cooldown meanwhile, or `launch`.
async function recheck(
  context: effects.EffectContext,
  entry: RemoteEntry,
): Promise<{ found: Evidence } | 'again' | 'launch'> {
  const { record: executionRecord, gh, cwd } = context;
  const issueLabels = gh.labelNames(await gh.viewIssue(executionRecord.ticket, cwd));
  context.labelsStale = false;
  const labelPrefix = context.labelPrefix ?? labels.DEFAULT_PREFIX;
  const overridden = await reconcile.humanOverride(executionRecord, issueLabels, labelPrefix);
  if (overridden) throw new effectErrors.EarlyTerminalError(overridden);
  // A finder reads only the entry's marker, effect and payload.
  const found = await effectEvidence.findEffect(entry as writeAhead.WriteAheadEntry, {
    executionRecord,
    git: context.git,
    gh,
    cwd,
    issueLabels,
  });
  if (found.status === 'unknown') throw found.error;
  if (found.status === 'conflicting') throw new effectErrors.EarlyTerminalError({ next: 'hold', reason: found.reason });
  if (found.status === 'found') return { found: found.evidence };
  // Another Ticket may have raised the cooldown during the lookup: wait it out, then check the labels again.
  return (await cooldown(context, entry.actionMarker)) ? 'again' : 'launch';
}

// A launch is saved as started before it runs. The first launch is saved too, so launching it again after a crash
// spends a retry like any other.
async function markStarted(
  context: effects.EffectContext,
  actionMarker: string,
  retry: effects.RemoteRetry | undefined,
) {
  if (retry && !retry.started) {
    retry.started = true;
    await context.database.save(context.record);
  } else if (!retry) {
    (context.record.retries[actionKey(actionMarker)] ??= {}).remote = {
      count: 0,
      failureClass: null,
      nextEligibleAt: 0,
      started: true,
    };
    await context.database.save(context.record);
  }
}

// A remote effect, retried on a recognised transient failure. A retry first re-reads the human-override labels and
// looks for the effect by its marker, so a write that landed before its call failed is found, never made twice.
// pr-ready has no finder: gh pr ready on a ready PR succeeds, so it is simply made again.
export async function remoteEffect<Payload>(
  context: effects.EffectContext,
  entry: RemoteEntry & { payload: Payload },
  perform: (payload: Payload) => Promise<Evidence>,
): Promise<Evidence> {
  const startedAt = context.clock.now();
  for (;;) {
    try {
      const retry = remoteRetry(context.record, entry.actionMarker);
      // A pending report is the exception: each later Run may deliver it once more (#60).
      if (retry?.started && !context.laterRunReport) {
        checkStop(context);
        await relaunch(context, entry.actionMarker, retry);
        continue;
      }
      await cooldown(context, entry.actionMarker);
      if ((retry && !retry.started) || context.labelsStale) {
        const rechecked = await recheck(context, entry);
        if (rechecked === 'again') continue;
        if (rechecked !== 'launch') return rechecked.found;
      }
      await markStarted(context, entry.actionMarker, retry);
      return await perform(entry.payload);
    } catch (err) {
      if (err instanceof effectErrors.EarlyTerminalError || effectErrors.fatal(err)) throw err;
      await reserveRetry(context, { actionMarker: entry.actionMarker, startedAt, err });
    }
  }
}

// A git write that queued for the repo lock behind another holder, which can take minutes, checks the run stop and the
// human override again once it holds the lock; a push whose commit origin already has is not made again. `git` is
// unlocked; a push's `args` are its worktree, branch and sha.
export async function lockGuard(
  context: effects.EffectContext,
  verb: string,
  args: unknown[],
  git: Pick<effectEvidence.EvidenceGit, 'remoteSha'>,
): Promise<{ skip: boolean } | undefined> {
  const { record: executionRecord, gh, cwd } = context;
  checkStop(context, { retrying: false });
  const overridden = await reconcile.humanOverride(
    executionRecord,
    gh.labelNames(await gh.viewIssue(executionRecord.ticket, cwd)),
    context.labelPrefix ?? labels.DEFAULT_PREFIX,
  );
  if (overridden) throw new effectErrors.EarlyTerminalError(overridden);
  if (verb !== 'push') return undefined;
  const [worktree, branch, sha] = args as [string, string, string];
  return { skip: (await git.remoteSha(worktree, branch)) === sha };
}
