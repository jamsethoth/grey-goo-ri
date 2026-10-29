import * as integrity from './integrity.mjs';
import { ENDS } from './labels.mjs';
import * as marker from './marker.mjs';
import * as outcome from './outcome.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';

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

export async function bracket(rec, fn) {
  await integrity.markBusy(rec);
  let result;
  try {
    result = await fn();
  } catch (err) {
    // A crashed process saves nothing more: marking idle would also persist whatever the crash left unsaved.
    if (!fatal(err)) await integrity.markIdle(rec);
    throw err;
  }
  await integrity.markIdle(rec);
  return result;
}

export const logged = (rec, m, step) => rec.log.find((e) => e.marker === m && e.step === step);

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
  throw new RunStopped({ next: 'run-stopped', retrying,
    reason: `Ticket #${stop.ticket} stopped the run with class ${stop.failureClass} during ${retrying ? 'a backoff' : 'a repo-lock wait'}.` });
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
  throw new Decided({ next: 'hold', reason: `The retry of ${actionKey(m)} has a deadline gg will not wait for, so the Ticket is held with its retry as saved.` });
}

// Spends one retry on a recognised transient failure, and saves it with its deadline, which the Run's shared cooldown
// also waits for, before any wait. Any other failure, or one past the budget, is rethrown.
async function reserveRetry(ctx, m, err) {
  const rec = ctx.record;
  const failure = outcome.classifyRemoteFailure(err);
  const spent = remoteRetry(rec, m)?.count ?? 0;
  if (!failure.retryable) throw err;
  if (spent >= REMOTE_RETRIES) {
    ctx.log(`#${rec.ticket} ${actionKey(m)}: ${failure.class} failure, retries exhausted after ${spent} of ${REMOTE_RETRIES}`);
    // The fault's Terminal Reason says the budget ran out, not that the fault was unexpected.
    if (err && typeof err === 'object') err.retriesExhausted = { class: failure.class, status: failure.status, count: spent, action: logged(rec, m, 'intent')?.action };
    throw err;
  }
  const now = ctx.clock.now();
  const retry = { count: spent + 1, class: failure.class, nextEligibleAt: eligibleAt(ctx, m, now + outcome.remoteRetryDelay(failure, spent + 1, now)), started: false };
  (rec.retries[actionKey(m)] ??= {}).remote = retry;
  ctx.runState.remoteNotBefore = Math.max(ctx.runState.remoteNotBefore, retry.nextEligibleAt);
  ctx.log(`#${rec.ticket} ${actionKey(m)}: ${failure.class} failure, retry ${retry.count} of ${REMOTE_RETRIES} at ${new Date(retry.nextEligibleAt).toISOString()}`);
  await record.save(rec);
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
    if (busy && !waited) await integrity.markIdle(rec);
    waited = ctx.labelsStale = true;
    await ctx.clock.sleep(Math.min(wait, MAX_SLEEP));
  }
  if (!waited) return false;
  if (busy) await integrity.markBusy(rec);
  checkStop(ctx);
  return true;
}

// A launch that had started when the process stopped may have landed or not; Reconciliation's lookup found it absent, so
// launching it again spends a new retry, saved first, and none is left once the budget is spent.
async function relaunch(ctx, m) {
  const retry = remoteRetry(ctx.record, m);
  if (retry.count >= REMOTE_RETRIES) {
    const err = new Error(`Action Marker ${m} was launched again for its last retry, which did not finish; with its retries spent it is not launched again.`);
    // A budget spent on transient failures says so in the Terminal Reason, as reserveRetry's does; no status is saved.
    if (retry.class) {
      ctx.log(`#${ctx.record.ticket} ${actionKey(m)}: ${retry.class} failure, retries exhausted after ${retry.count} of ${REMOTE_RETRIES}`);
      err.retriesExhausted = { class: retry.class, status: null, count: retry.count, action: logged(ctx.record, m, 'intent')?.action };
    }
    throw err;
  }
  Object.assign(retry, { count: retry.count + 1, nextEligibleAt: ctx.clock.now(), started: false });
  await record.save(ctx.record);
}

// Looks for a remote Action's effect by its marker. A failed lookup proves nothing, so it is retried on the Action's
// budget; only a lookup that worked can find the effect absent.
export async function lookup(ctx, entry, finderCtx) {
  for (;;) {
    await cooldown(ctx, entry.marker);
    const found = await reconcile.findEffect(entry, finderCtx);
    if (found.status !== 'unknown') return found;
    await reserveRetry(ctx, entry.marker, found.error);
  }
}

// A remote effect, retried on a recognised transient failure. A retry first re-reads the human-override labels and looks
// for the effect by its marker, so a write that landed before its call failed is found, never made twice. pr-ready has
// no finder: gh pr ready on a ready PR succeeds, so it is simply made again.
async function remoteEffect(ctx, entry, effect) {
  const { record: rec, gh, cwd } = ctx;
  for (;;) {
    try {
      const retry = remoteRetry(rec, entry.marker);
      // A pending report is the exception: each later Run may deliver it once more (#60).
      if (retry?.started && !ctx.laterRunReport) {
        checkStop(ctx);
        await relaunch(ctx, entry.marker);
        continue;
      }
      await cooldown(ctx, entry.marker);
      // Every retry, and every launch after a wait since the labels were read, first checks the human override and
      // looks for the effect again, whether or not it had started (a pending report's has).
      if ((retry && !retry.started) || ctx.labelsStale) {
        const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
        ctx.labelsStale = false;
        const overridden = await reconcile.humanOverride(rec, issueLabels, ctx.labelPrefix ?? 'gg');
        if (overridden) throw new Decided(overridden);
        const found = await reconcile.findEffect(entry, { rec, git: ctx.git, gh, cwd, issueLabels });
        if (found.status === 'unknown') throw found.error;
        if (found.status === 'conflicting') throw new Decided({ next: 'hold', reason: found.reason });
        if (found.status === 'found') return found.evidence;
        // Another Ticket may have raised the cooldown during the lookup: wait it out, then check the labels again.
        if (await cooldown(ctx, entry.marker)) continue;
      }
      if (retry && !retry.started) {
        retry.started = true;
        await record.save(rec);
      } else if (!retry) {
        // The first launch is saved too, so launching it again after a crash spends a retry like any other.
        (rec.retries[actionKey(entry.marker)] ??= {}).remote = { count: 0, class: null, nextEligibleAt: 0, started: true };
        await record.save(rec);
      }
      return await effect(entry.payload);
    } catch (err) {
      if (err instanceof Decided || fatal(err)) throw err;
      await reserveRetry(ctx, entry.marker, err);
    }
  }
}

// A git write that queued for the repo lock behind another holder, which can take minutes, checks the run stop and the
// human override again once it holds the lock; a push whose commit origin already has is not made again. `git` is unlocked.
export async function lockGuard(ctx, verb, args, git) {
  const { record: rec, gh, cwd } = ctx;
  checkStop(ctx, false);
  const decided = await reconcile.humanOverride(rec, gh.labelNames(await gh.viewIssue(rec.ticket, cwd)), ctx.labelPrefix ?? 'gg');
  if (decided) throw new Decided(decided);
  if (verb === 'push') return { skip: await git.remoteSha(args[0], args[1]) === args[2] };
}

// An Action whose effect is proven by saved evidence is not repeated; an open one, left by Reconciliation to be redone, reuses
// its intended payload. A `deferred` Action is completed by `finish`, with its Event.
export async function sideEffect(ctx, m, action, payload, effect, deferred = false) {
  const rec = ctx.record;
  const found = record.proof(rec, m);
  if (found) {
    if (!deferred && !logged(rec, m, 'complete')) await record.complete(rec, m);
    return found.evidence;
  }
  const intended = logged(rec, m, 'intent')?.payload;
  if (!intended) await record.intent(rec, m, action, payload);
  crashPoint(ctx, m, 'before-effect');
  const p = intended ?? payload;
  const evidence = REMOTE.includes(action) ? await remoteEffect(ctx, { marker: m, action, payload: p }, effect) : await effect(p);
  crashPoint(ctx, m, 'after-effect');
  await record.evidence(rec, m, evidence);
  if (deferred) return evidence;
  await record.complete(rec, m);
  crashPoint(ctx, m, 'after-completion');
  return evidence;
}

// Saves an Action's result, its marker's completion when it has one, and its Action Event in one transaction. A resumed
// Visit routes the saved (settled) result instead of running the Action again; a retried Attempt's result stays in its
// evidence for the next Attempt to read.
export async function finish(ctx, at, t0, r, fields = {}, m = null, evidence = undefined) {
  const rec = ctx.record;
  if (m && logged(rec, m, 'complete')) return r;
  if (at.procedure && r.direction !== 'retry') rec.visitState.settled = { action: at.action, recovery: at.recovery, r };
  const event = () => ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, signals: {}, ...fields });
  await (m ? record.complete(rec, m, { evidence, event }) : record.save(rec, event));
  if (m) crashPoint(ctx, m, 'after-completion');
  return r;
}

export const effectDone = (ctx, at, t0, m) => finish(ctx, at, t0, { outcome: 'ok', direction: 'advance', row: 'effect-completed' }, {}, m);
