// An Effect's write-ahead side effect: the context the effects read, and its intent, launch and evidence in the
// write-ahead log; its completion is its Attempt's save (lib/attempt.ts). A remote Effect's retries are
// remote-effects'.
import * as effectErrors from '../effect-errors.ts';
import type * as marker from '../marker.ts';
import type * as outcome from '../outcome.ts';
import type * as reconcile from '../reconcile.ts';
import type * as record from '../record.ts';
import * as remoteEffects from '../remote-effects.ts';
import type * as events from '../events.ts';
import * as writeAhead from '../write-ahead.ts';
import type * as effects from './index.ts';

type Evidence = writeAhead.Evidence;

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
  emit: (actionIdentity: marker.ActionIdentity, startedAt: number, fields: events.EventInput<'action'>) => void;
  markerOf: (actionIdentity: marker.ActionIdentity) => string;
  gh: reconcile.ReconcileGh;
  git?: effects.EvidenceGit;
  cwd?: string;
  labelPrefix?: string;
  crashAt?: { marker: string; point: effectErrors.CrashPointName };
  // A wait since the labels were last read leaves them stale, wherever it happened.
  labelsStale?: boolean;
  // A report a later Run delivers once more (#60).
  laterRunReport?: boolean;
}

export interface SideEffect<Payload, Context> {
  actionMarker: string;
  effect: effects.Effect<Payload, Context>;
  payload: Payload;
  // Completed by its Attempt's save, with its Action Event (lib/attempt.ts).
  deferred?: boolean;
}

// An Action whose effect is proven by saved evidence is not repeated; an open one, left by Reconciliation to be redone,
// reuses its intended payload. The context is what every Action's effects read, and what the Effect's perform reads.
export async function sideEffect<Payload extends writeAhead.Payload, Context>(
  context: EffectContext & NoInfer<Context>,
  { actionMarker, effect, payload, deferred = false }: SideEffect<Payload, Context>,
): Promise<Evidence> {
  const { record: executionRecord } = context;
  const found = writeAhead.evidenceOf(executionRecord, actionMarker);
  if (found) {
    if (!deferred && !writeAhead.findEntry(executionRecord, actionMarker, 'complete'))
      context.database.complete(executionRecord, actionMarker);
    return found.evidence as Evidence;
  }
  const intended = writeAhead.findEntry(executionRecord, actionMarker, 'intent')?.payload as Payload | undefined;
  if (!intended) context.database.intent(executionRecord, actionMarker, effect.name, payload);
  effectErrors.crashPoint(context, actionMarker, 'before-effect');
  const launched = intended ?? payload;
  const perform = (planned: Payload) => effect.perform(context, planned, { redo: !!intended });
  const evidence = effect.remote
    ? await remoteEffects.remoteEffect(context, { actionMarker, effect: effect.name, payload: launched }, perform)
    : await perform(launched);
  effectErrors.crashPoint(context, actionMarker, 'after-effect');
  context.database.evidence(executionRecord, actionMarker, evidence);
  if (deferred) return evidence;
  context.database.complete(executionRecord, actionMarker);
  effectErrors.crashPoint(context, actionMarker, 'after-completion');
  return evidence;
}
