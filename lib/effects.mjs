import * as effectEvidence from './effect-evidence.ts';
import * as integrity from './integrity.ts';
import { DEFAULT_PREFIX, ENDS } from './labels.ts';
import * as marker from './marker.ts';
import * as outcome from './outcome.ts';
import * as reconcile from './reconcile.ts';
import * as record from './record.ts';
import * as writeAhead from './write-ahead.ts';

// Test-only crash injection (T18): rethrown untouched, so the record is left exactly as the crash found it.
export class CrashError extends Error {
  name = 'CrashError';
}

// A crash, or a record save that failed: either way nothing more of the record is saved.
export const fatal = (err) => err instanceof CrashError || err instanceof record.RecordSaveError;

// crashAt (tests only) throws at a named point of the Action or Attempt with that marker.
export function crashPoint(ctx, m, point) {
  if (ctx.crashAt?.marker === m && ctx.crashAt.point === point) throw new CrashError(`crash ${point} ${m}`);
}

export async function bracket(ctx, fn) {
  const { record: rec, database } = ctx;
  await integrity.markBusy(rec, database);
  let result;
  try {
    result = await fn();
  } catch (err) {
    // A crashed process saves nothing more: marking idle would also persist whatever the crash left unsaved.
    if (!fatal(err)) await integrity.markIdle(rec, database);
    throw err;
  }
  await integrity.markIdle(rec, database);
  return result;
}

export const logged = (rec, m, step) => rec.writeAheadLog.find((e) => e.actionMarker === m && e.step === step);

// The Actions whose effect is on GitHub or origin. A recognised transient failure is retried inside the Action, on a
// budget saved in the record before each wait, so a crash cannot refill it (#66).
export const REMOTE = ['comment', 'pr-upsert', 'push', 'pr-ready'];
const REMOTE_RETRIES = 2;
const actionKey = (m) => marker.actionKeyOf(marker.partsOf(m));
const remoteRetry = (rec, m) => rec.retries[actionKey(m)]?.remote;

// A human override, a conflicting effect or a corrupt retry deadline found before a retry, which runExecution abandons
// or holds.
export class Decided extends Error {
  constructor(decided) {
    super(decided.reason);
    this.decided = decided;
  }
}

// A run stop latched while a remote Action backs off, in a Visit, Reconciliation's lookup or ready-for-qa's Terminal:
// decide() ends the Execution at needs-human as one found before an Action does (#85).
class RunStopped extends Decided {}

// A needs-human, needs-replan, hold, fault or abandonment report is what a stop leads to, so only it goes on. `retrying`
// is false for a repo-lock wait, which keeps no retry.
function checkStop(ctx, retrying = true) {
  const stop = ctx.runState.stop;
  const vertex = ctx.record.cursor.vertex;
  if (!stop || (ENDS.includes(vertex) && vertex !== 'ready-for-qa')) return;
  throw new RunStopped({
    next: 'run-stopped',
    retrying,
    reason: `Ticket #${stop.ticket} stopped the run with class ${stop.failureClass} during ${retrying ? 'a backoff' : 'a repo-lock wait'}.`,
  });
}

// A retry deadline is never further away than this; a later or non-numeric one is corrupt, and held rather than waited for.
const MAX_RETRY_WAIT = 31 * 24 * 3_600_000;
// Node fires a timer longer than 2^31 - 1 ms at once, so a backoff sleeps in chunks of at most this.
const MAX_SLEEP = 3_600_000;

function eligibleAt(ctx, m, at) {
  if (Number.isFinite(at) && at >= 0 && at <= ctx.clock.now() + MAX_RETRY_WAIT) return at;
  // A time Date can show is logged as one; anything else as the value saved.
  const shown = Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : JSON.stringify(at);
  ctx.log(`#${ctx.record.ticket} ${actionKey(m)}: retry deadline ${shown} is not a time within 31 days, so it is held`);
  throw new Decided({
    next: 'hold',
    reason: `The retry of ${actionKey(m)} has a deadline gg will not wait for, so the Ticket is held with its retry as saved.`,
  });
}

// A remote Action whose Attempt fails for good records its Action Event where it fails, in a Visit or a Terminal alike:
// its class, its error, and the outcome and rule of what it leads to, a run stop or a fault (#251). Its save failing is
// fatal, as any Event's is.
function failedEvent(ctx, m, t0, err, failureClass, consequence) {
  const { vertex, visit, action, recovery, attempt } = marker.partsOf(m);
  const snapshot = ctx.record.configurationSnapshot;
  // A Terminal's report runs outside any Procedure.
  const inVisit = snapshot?.vertex === vertex && snapshot.visit === Number(visit);
  const event = () =>
    ctx.emit(
      {
        vertex,
        visit: Number(visit),
        procedure: inVisit ? snapshot.procedure.name : null,
        action,
        recovery: Number(recovery),
        attempt: Number(attempt),
      },
      t0,
      {
        outcome: consequence,
        direction: 'stop',
        rule: { table: 'fixed', row: consequence },
        signals: {},
        failureClass,
        error: err?.message || String(err),
      },
    );
  return ctx.database.save(ctx.record, event);
}

// A final remote failure names its Action and class in the Terminal Reason. One whose class reaches the whole Run latches
// the run stop, as a Harness run stop does, and ends this Execution at needs-human; in a Terminal's own report, which is
// what a stop leads to, it is only latched (#240). The latch comes first, so the Run stops even when the Event's save fails.
async function finalFailure(ctx, m, t0, err, failure) {
  const { failureClass, status } = failure;
  const source = logged(ctx.record, m, 'intent')?.effect ?? 'remote Action';
  const { reach } = outcome.FAILURE_CLASSES[failureClass];
  const vertex = ctx.record.cursor.vertex;
  const stops = reach === 'run' && (!ENDS.includes(vertex) || vertex === 'ready-for-qa');
  if (reach === 'run') ctx.runState.stop ??= { failureClass, ticket: ctx.record.ticket, source };
  // A relaunch refused with its budget spent is unknown to the classifier; its Event names the class its retries were
  // spent on.
  const eventClass = err?.retriesExhausted?.failureClass ?? failureClass;
  await failedEvent(ctx, m, t0, err, eventClass, stops ? 'run-stop' : 'fault');
  if (stops)
    return new Decided({
      next: 'run-stop',
      failureClass,
      source,
      detail: err?.message || String(err),
      reason: `The ${source} failed with class ${failureClass}.`,
    });
  // An unknown failure stays an unexpected fault.
  if (failureClass !== 'unknown' && err && typeof err === 'object')
    err.remoteFailure = { failureClass, status, reach, effect: source };
  return err;
}

// Spends one retry on a recognised transient failure, and saves it with its deadline, which the Run's shared cooldown
// also waits for, before any wait. Any other failure, or one past the budget, is rethrown; `t0` is when the Action began.
async function reserveRetry(ctx, m, t0, err) {
  const rec = ctx.record;
  const failure = outcome.classifyRemoteFailure(err);
  const spent = remoteRetry(rec, m)?.count ?? 0;
  if (!failure.retryable) throw await finalFailure(ctx, m, t0, err, failure);
  if (spent >= REMOTE_RETRIES) {
    await failedEvent(ctx, m, t0, err, failure.failureClass, 'fault');
    ctx.log(
      `#${rec.ticket} ${actionKey(m)}: ${failure.failureClass} failure, retries exhausted after ${spent} of ${REMOTE_RETRIES}`,
    );
    // The fault's Terminal Reason says the budget ran out, not that the fault was unexpected.
    if (err && typeof err === 'object')
      err.retriesExhausted = {
        failureClass: failure.failureClass,
        status: failure.status,
        count: spent,
        effect: logged(rec, m, 'intent')?.effect,
      };
    throw err;
  }
  const now = ctx.clock.now();
  const retry = {
    count: spent + 1,
    failureClass: failure.failureClass,
    nextEligibleAt: eligibleAt(ctx, m, now + outcome.remoteRetryDelay(failure, spent + 1, now)),
    started: false,
  };
  (rec.retries[actionKey(m)] ??= {}).remote = retry;
  ctx.runState.remoteNotBefore = Math.max(ctx.runState.remoteNotBefore, retry.nextEligibleAt);
  ctx.log(
    `#${rec.ticket} ${actionKey(m)}: ${failure.failureClass} failure, retry ${retry.count} of ${REMOTE_RETRIES} at ${new Date(retry.nextEligibleAt).toISOString()}`,
  );
  await ctx.database.save(rec);
  crashPoint(ctx, m, 'after-retry-saved');
}

// Waits out the Action's saved retry deadline and the Run's shared cooldown, whichever is later; true if it waited.
// A wait leaves the labels last read stale (`ctx.labelsStale`), wherever it happened, Reconciliation's lookup included.
// A busy worktree is idle while it waits, so other Tickets' integrity checks see a stray write into it, and busy again
// before the lookup and the launch. A run stop is checked before each sleep and after the last.
async function cooldown(ctx, m) {
  const rec = ctx.record;
  const busy = rec.activity.busy;
  const deadline = () => {
    const retry = remoteRetry(rec, m);
    return Math.max(retry ? eligibleAt(ctx, m, retry.nextEligibleAt) : 0, ctx.runState.remoteNotBefore);
  };
  let waited = false;
  for (let wait; (wait = deadline() - ctx.clock.now()) > 0;) {
    checkStop(ctx);
    if (busy && !waited) await integrity.markIdle(rec, ctx.database);
    waited = ctx.labelsStale = true;
    await ctx.clock.sleep(Math.min(wait, MAX_SLEEP));
  }
  if (!waited) return false;
  if (busy) await integrity.markBusy(rec, ctx.database);
  checkStop(ctx);
  return true;
}

// A launch that had started when the process stopped may have landed or not; Reconciliation's lookup found it absent, so
// launching it again spends a new retry, saved first, and none is left once the budget is spent.
async function relaunch(ctx, m) {
  const retry = remoteRetry(ctx.record, m);
  if (retry.count >= REMOTE_RETRIES) {
    const err = new Error(
      `Action Marker ${m} was launched again for its last retry, which did not finish; with its retries spent it is not launched again.`,
    );
    // A budget spent on transient failures says so in the Terminal Reason, as reserveRetry's does; no status is saved.
    if (retry.failureClass) {
      ctx.log(
        `#${ctx.record.ticket} ${actionKey(m)}: ${retry.failureClass} failure, retries exhausted after ${retry.count} of ${REMOTE_RETRIES}`,
      );
      err.retriesExhausted = {
        failureClass: retry.failureClass,
        status: null,
        count: retry.count,
        effect: logged(ctx.record, m, 'intent')?.effect,
      };
    }
    throw err;
  }
  Object.assign(retry, { count: retry.count + 1, nextEligibleAt: ctx.clock.now(), started: false });
  await ctx.database.save(ctx.record);
}

// Looks for a remote Action's effect by its marker. A failed lookup proves nothing, so it is retried on the Action's
// budget; only a lookup that worked can find the effect absent.
export async function lookup(ctx, entry, finderCtx) {
  const t0 = ctx.clock.now();
  for (;;) {
    await cooldown(ctx, entry.actionMarker);
    const found = await effectEvidence.findEffect(entry, finderCtx);
    if (found.status !== 'unknown') return found;
    await reserveRetry(ctx, entry.actionMarker, t0, found.error);
  }
}

// A remote effect, retried on a recognised transient failure. A retry first re-reads the human-override labels and looks
// for the effect by its marker, so a write that landed before its call failed is found, never made twice. pr-ready has
// no finder: gh pr ready on a ready PR succeeds, so it is simply made again.
async function remoteEffect(ctx, entry, perform) {
  const { record: rec, gh, cwd } = ctx;
  const t0 = ctx.clock.now();
  for (;;) {
    try {
      const retry = remoteRetry(rec, entry.actionMarker);
      // A pending report is the exception: each later Run may deliver it once more (#60).
      if (retry?.started && !ctx.laterRunReport) {
        checkStop(ctx);
        await relaunch(ctx, entry.actionMarker);
        continue;
      }
      await cooldown(ctx, entry.actionMarker);
      // Every retry, and every launch after a wait since the labels were read, first checks the human override and
      // looks for the effect again, whether or not it had started (a pending report's has).
      if ((retry && !retry.started) || ctx.labelsStale) {
        const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
        ctx.labelsStale = false;
        const overridden = await reconcile.humanOverride(rec, issueLabels, ctx.labelPrefix ?? DEFAULT_PREFIX);
        if (overridden) throw new Decided(overridden);
        const found = await effectEvidence.findEffect(entry, {
          executionRecord: rec,
          git: ctx.git,
          gh,
          cwd,
          issueLabels,
        });
        if (found.status === 'unknown') throw found.error;
        if (found.status === 'conflicting') throw new Decided({ next: 'hold', reason: found.reason });
        if (found.status === 'found') return found.evidence;
        // Another Ticket may have raised the cooldown during the lookup: wait it out, then check the labels again.
        if (await cooldown(ctx, entry.actionMarker)) continue;
      }
      if (retry && !retry.started) {
        retry.started = true;
        await ctx.database.save(rec);
      } else if (!retry) {
        // The first launch is saved too, so launching it again after a crash spends a retry like any other.
        (rec.retries[actionKey(entry.actionMarker)] ??= {}).remote = {
          count: 0,
          failureClass: null,
          nextEligibleAt: 0,
          started: true,
        };
        await ctx.database.save(rec);
      }
      return await perform(entry.payload);
    } catch (err) {
      if (err instanceof Decided || fatal(err)) throw err;
      await reserveRetry(ctx, entry.actionMarker, t0, err);
    }
  }
}

// A git write that queued for the repo lock behind another holder, which can take minutes, checks the run stop and the
// human override again once it holds the lock; a push whose commit origin already has is not made again. `git` is unlocked.
export async function lockGuard(ctx, verb, args, git) {
  const { record: rec, gh, cwd } = ctx;
  checkStop(ctx, false);
  const decided = await reconcile.humanOverride(
    rec,
    gh.labelNames(await gh.viewIssue(rec.ticket, cwd)),
    ctx.labelPrefix ?? DEFAULT_PREFIX,
  );
  if (decided) throw new Decided(decided);
  if (verb === 'push') return { skip: (await git.remoteSha(args[0], args[1])) === args[2] };
}

// An Action whose effect is proven by saved evidence is not repeated; an open one, left by Reconciliation to be redone, reuses
// its intended payload. A `deferred` Action is completed by `finish`, with its Event.
export async function sideEffect(ctx, m, effect, payload, perform, deferred = false) {
  const rec = ctx.record;
  const found = writeAhead.proof(rec, m);
  if (found) {
    if (!deferred && !logged(rec, m, 'complete')) await ctx.database.complete(rec, m);
    return found.evidence;
  }
  const intended = logged(rec, m, 'intent')?.payload;
  if (!intended) await ctx.database.intent(rec, m, effect, payload);
  crashPoint(ctx, m, 'before-effect');
  const p = intended ?? payload;
  const evidence = REMOTE.includes(effect)
    ? await remoteEffect(ctx, { actionMarker: m, effect, payload: p }, perform)
    : await perform(p);
  crashPoint(ctx, m, 'after-effect');
  await ctx.database.evidence(rec, m, evidence);
  if (deferred) return evidence;
  await ctx.database.complete(rec, m);
  crashPoint(ctx, m, 'after-completion');
  return evidence;
}

// Saves an Action's result, its marker's completion when it has one, and its Action Event in one transaction. A resumed
// Visit routes the saved (settled) result instead of running the Action again; a retried Attempt's result stays in its
// evidence for the next Attempt to read.
export async function finish(ctx, at, t0, r, fields = {}, m = null, evidence = undefined) {
  const rec = ctx.record;
  if (m && logged(rec, m, 'complete')) return r;
  if (at.procedure && r.direction !== 'retry')
    rec.visitState.settled = { action: at.action, recovery: at.recovery, resolution: r };
  const event = () =>
    ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.rule, signals: {}, ...fields });
  await (m ? ctx.database.complete(rec, m, { evidence, event }) : ctx.database.save(rec, event));
  if (m) crashPoint(ctx, m, 'after-completion');
  return r;
}

export const effectDone = (ctx, at, t0, m) =>
  finish(
    ctx,
    at,
    t0,
    { outcome: 'ok', direction: 'advance', row: 'effect-completed', rule: { table: 'fixed', row: 'effect-completed' } },
    {},
    m,
  );
