// The write-ahead side effects of an Execution's Actions: the context they read, whileBusy, and each
// effect's intent, evidence and completion with its Action Event. A remote Action's retries are remote-effects'.
import * as effectErrors from './effect-errors.ts';
import type * as effectEvidence from './effect-evidence.ts';
import * as integrity from './integrity.ts';
import type * as marker from './marker.ts';
import type * as outcome from './outcome.ts';
import type * as reconcile from './reconcile.ts';
import type * as record from './record.ts';
import * as remoteEffects from './remote-effects.ts';
import type * as visit from './visit.ts';
import * as writeAhead from './write-ahead.ts';

type Evidence = Record<string, unknown>;

// The run stop a Run latched: the first Failure Class that reached the whole Run, the Ticket it came from, and the
// remote Action's effect that failed (none for a Harness's).
export interface RunStop {
  failureClass: string;
  ticket: number;
  source?: string;
}
// What every Execution of a Run shares: its run stop, and the cooldown no remote Action launches before.
export interface RunState {
  stop: RunStop | null;
  remoteNotBefore: number;
}

// A remote Action's retry budget as the record saves it, under its Action key's `remote` (record.retries).
export interface RemoteRetry {
  count: number;
  failureClass: outcome.FailureClass | null;
  nextEligibleAt: number;
  started: boolean;
}

// What the effects read of the Execution they run in, which runExecution builds (lib/run-context.ts).
export interface EffectContext {
  record: record.ExecutionRecord;
  database: Pick<record.StateDatabase, 'save' | 'intent' | 'evidence' | 'complete'>;
  runState: RunState;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  log: (line: string) => void;
  // Records one Action Event: the Action's identity, when it began, and its outcome and payload.
  emit: (actionIdentity: marker.ActionIdentity, startedAt: number, fields: Record<string, unknown>) => void;
  gh: reconcile.ReconcileGh;
  git?: effectEvidence.EvidenceGit;
  cwd?: string;
  labelPrefix?: string;
  crashAt?: { marker: string; point: effectErrors.CrashPointName };
  // A wait since the labels were last read leaves them stale, wherever it happened.
  labelsStale?: boolean;
  // A report a later Run delivers once more (#60).
  laterRunReport?: boolean;
}

// The worktree is busy while `work` runs, so other Tickets' Integrity Assertions leave it alone. It stays busy once a
// call's cleanup is unconfirmed: a writer may still be running there (L11).
export async function whileBusy<Result>(
  context: Pick<EffectContext, 'record' | 'database'>,
  work: () => Promise<Result>,
): Promise<Result> {
  const { record: executionRecord, database } = context;
  await integrity.markBusy(executionRecord, database);
  const markIdle = async () => {
    if (!executionRecord.visitState?.unconfirmedCleanup) await integrity.markIdle(executionRecord, database);
  };
  let result;
  try {
    result = await work();
  } catch (err) {
    // A crashed process saves nothing more: marking idle would also persist whatever the crash left unsaved.
    if (!effectErrors.fatal(err)) await markIdle();
    throw err;
  }
  await markIdle();
  return result;
}

export interface SideEffect<Payload> {
  actionMarker: string;
  effect: string;
  payload: Payload;
  perform: (payload: Payload) => Promise<Evidence>;
  // Completed by `saveResolution`, with its Action Event.
  deferred?: boolean;
}

// An Action whose effect is proven by saved evidence is not repeated; an open one, left by Reconciliation to be redone,
// reuses its intended payload.
export async function sideEffect<Payload>(
  context: EffectContext,
  { actionMarker, effect, payload, perform, deferred = false }: SideEffect<Payload>,
): Promise<Evidence> {
  const { record: executionRecord } = context;
  const found = writeAhead.evidenceOf(executionRecord, actionMarker);
  if (found) {
    if (!deferred && !writeAhead.findEntry(executionRecord, actionMarker, 'complete'))
      await context.database.complete(executionRecord, actionMarker);
    return found.evidence as Evidence;
  }
  const intended = writeAhead.findEntry(executionRecord, actionMarker, 'intent')?.payload as Payload | undefined;
  if (!intended) await context.database.intent(executionRecord, actionMarker, effect, payload);
  effectErrors.crashPoint(context, actionMarker, 'before-effect');
  const launched = intended ?? payload;
  const evidence = remoteEffects.REMOTE_ACTIONS.includes(effect)
    ? await remoteEffects.remoteEffect(context, { actionMarker, effect, payload: launched }, perform)
    : await perform(launched);
  effectErrors.crashPoint(context, actionMarker, 'after-effect');
  await context.database.evidence(executionRecord, actionMarker, evidence);
  if (deferred) return evidence;
  await context.database.complete(executionRecord, actionMarker);
  effectErrors.crashPoint(context, actionMarker, 'after-completion');
  return evidence;
}

export interface SavedResolution<Settled extends visit.Resolution> {
  actionIdentity: marker.ActionIdentity;
  startedAt: number;
  resolution: Settled;
  // The Action Event's fields beyond the resolution's.
  fields?: Record<string, unknown>;
  // The marker of a side effect this completes, with the evidence saved in the same write.
  actionMarker?: string | null;
  evidence?: Evidence;
}

// Saves an Action's result, its marker's completion when it has one, and its Action Event in one transaction. A resumed
// Visit routes the saved (settled) result instead of running the Action again; a retried Attempt's result stays in its
// evidence for the next Attempt to read.
export async function saveResolution<Settled extends visit.Resolution>(
  context: EffectContext,
  {
    actionIdentity,
    startedAt,
    resolution,
    fields = {},
    actionMarker = null,
    evidence = undefined,
  }: SavedResolution<Settled>,
): Promise<Settled> {
  const { record: executionRecord } = context;
  if (actionMarker && writeAhead.findEntry(executionRecord, actionMarker, 'complete')) return resolution;
  if (actionIdentity.procedure && resolution.direction !== 'retry')
    executionRecord.visitState!.settled = {
      action: actionIdentity.action,
      recovery: actionIdentity.recovery,
      resolution,
    };
  const event = () =>
    context.emit(actionIdentity, startedAt, {
      outcome: resolution.outcome,
      direction: resolution.direction,
      rule: resolution.rule,
      signals: {},
      ...fields,
    });
  await (actionMarker
    ? context.database.complete(executionRecord, actionMarker, { evidence, event })
    : context.database.save(executionRecord, event));
  if (actionMarker) effectErrors.crashPoint(context, actionMarker, 'after-completion');
  return resolution;
}

export const completeEffect = (
  context: EffectContext,
  actionIdentity: marker.ActionIdentity,
  startedAt: number,
  actionMarker: string,
): Promise<visit.EffectResolution> =>
  saveResolution(context, {
    actionIdentity,
    startedAt,
    resolution: {
      outcome: 'ok',
      direction: 'advance',
      row: 'effect-completed',
      rule: { table: 'fixed', row: 'effect-completed' },
    },
    fields: {},
    actionMarker,
  });
