// An Attempt from its start to its saved result: its start, its Action Marker, its work, bracketed busy when the work
// touches the worktree, and one save that holds its result, its side effect's completion, its outputs and its Action
// Event. An Attempt whose marker is already complete returns its saved result without running again.
import * as effectErrors from './effect-errors.ts';
import * as sideEffect from './effects/side-effect.ts';
import type * as events from './events.ts';
import * as integrity from './integrity.ts';
import * as jsonValue from './json-value.ts';
import * as marker from './marker.ts';
import type * as outcome from './outcome.ts';
import type * as record from './record.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type Context = sideEffect.EffectContext;

// The Visit's write of an Attempt's result, applied inside the Attempt's save (lib/visit-runner.ts). A held
// completion that leaves no result passes null.
export type Settle = (resolution: visit.Resolution | null) => void;

// What a kind's work leaves as its outputs, and the output fields it drops.
export interface Outputs {
  outputs?: visit.ActionOutputValue;
  dropped?: (keyof visit.ActionOutputValue)[];
}

// The result the save holds, the Action Event's fields beyond the result's, and the evidence its completion saves.
export interface Done<Settled extends visit.Resolution> {
  resolution: Settled;
  fields?: events.EventInput<'action'>;
  evidence?: writeAhead.Evidence;
}

export interface Attempting<Prepared, Worked, Settled extends visit.Resolution> {
  // The identity the Action Event records; the marker is its own unless `actionMarker` names another.
  actionIdentity: marker.ActionIdentity;
  actionMarker?: string;
  // The work touches the worktree, so it runs bracketed busy.
  busy: boolean;
  // Run before the Attempt starts, and only when it is not already complete.
  prepare?: (actionMarker: string) => Promise<Prepared>;
  work: (prepared: Prepared, actionMarker: string) => Promise<Worked>;
  outputs?: (worked: Worked) => Outputs;
  // Run after the work, outside the bracket, and synchronous, so nothing saves between the outputs and the save: the
  // result the save holds, decided over a scope that holds the Attempt's own outputs.
  finish: (worked: Worked, prepared: Prepared) => Done<Settled>;
  // The saved result of a complete Attempt, from the evidence its completion saved; an Effect's by default.
  resumed?: (evidence: writeAhead.Evidence | undefined) => Settled;
  settle?: Settle;
}

// A held completion (J4): its validation of the worktree, and a result that replaces the one the hold saved, or none.
export interface Held<Worked, Settled extends visit.Resolution> {
  actionIdentity: marker.ActionIdentity;
  actionMarker?: string;
  work: () => Promise<Worked>;
  outputs?: (worked: Worked) => Outputs;
  finish: (worked: Worked) => Done<Settled> | (Omit<Done<Settled>, 'resolution'> & { resolution: null });
  settle?: Settle;
}

export const EFFECT_COMPLETED: visit.EffectResolution = {
  outcome: 'ok',
  direction: 'advance',
  row: 'effect-completed',
  rule: { table: 'fixed', row: 'effect-completed' },
};

const completed = (executionRecord: record.ExecutionRecord, actionMarker: string) =>
  !!writeAhead.findEntry(executionRecord, actionMarker, 'complete');

// Whether an Attempt's marker is complete: its result is saved, and it never runs again.
export const complete = (context: Pick<Context, 'record' | 'markerOf'>, actionIdentity: marker.ActionIdentity) =>
  completed(context.record, context.markerOf(actionIdentity));

// The worktree is busy while `work` runs, so other Tickets' Integrity Assertions leave it alone.
export async function whileBusy<Result>(
  context: Pick<Context, 'record' | 'database'>,
  work: () => Promise<Result>,
): Promise<Result> {
  const { record: executionRecord, database } = context;
  await integrity.markBusy(executionRecord, database);
  let result;
  try {
    result = await work();
  } catch (err) {
    // A crashed process saves nothing more: marking idle would also persist whatever the crash left unsaved.
    if (!effectErrors.fatal(err)) await integrity.markIdle(executionRecord, database);
    throw err;
  }
  await integrity.markIdle(executionRecord, database);
  return result;
}

// The outputs go to the record after the work, outside the bracket, so its idle save cannot publish them; the
// synchronous finish that decides the result reads them, and the save that follows carries them. A finish that throws
// takes them back, so no later save (a fault's report) publishes them without their result and Event.
function keepOutputs(context: Context, actionIdentity: marker.ActionIdentity, { outputs, dropped = [] }: Outputs = {}) {
  const { record: executionRecord } = context;
  const entry = visitScope.outputOf(executionRecord, actionIdentity);
  // Shallow: outputs only set or drop an Action's fields, never change one in place.
  const before = entry && { ...entry.value };
  for (const field of dropped) if (entry) Reflect.deleteProperty(entry.value, field);
  if (outputs) visitScope.recordOutput(executionRecord, actionIdentity, outputs);
  return () => {
    if (entry) entry.value = before!;
    else {
      const added = visitScope.outputOf(executionRecord, actionIdentity);
      if (added) executionRecord.outputs.splice(executionRecord.outputs.indexOf(added), 1);
    }
  };
}

function finishing<Result>(takeBack: () => void, finish: () => Result): Result {
  try {
    return finish();
  } catch (err) {
    takeBack();
    throw err;
  }
}

const eventOf =
  (context: Context, actionIdentity: marker.ActionIdentity, startedAt: number, done: Done<visit.Resolution>) => () =>
    context.emit(actionIdentity, startedAt, {
      outcome: done.resolution.outcome,
      direction: done.resolution.direction,
      rule: done.resolution.rule,
      signals: {},
      ...done.fields,
    });

// The one save. An Attempt with a write-ahead intent completes it here, with its evidence; one without (a Check) saves
// the record. A retried Attempt's result stays in its evidence for the next Attempt to read.
function save(
  context: Context,
  {
    actionIdentity,
    actionMarker,
    startedAt,
  }: { actionIdentity: marker.ActionIdentity; actionMarker: string; startedAt: number },
  done: Done<visit.Resolution>,
  settle: Settle | undefined,
) {
  const { record: executionRecord, database } = context;
  settle?.(done.resolution);
  const event = eventOf(context, actionIdentity, startedAt, done);
  const opened = !!writeAhead.findEntry(executionRecord, actionMarker, 'intent');
  if (!opened) return void database.save(executionRecord, event);
  database.complete(executionRecord, actionMarker, { evidence: done.evidence, event });
  effectErrors.crashPoint(context, actionMarker, 'after-completion');
}

// An Effect's saved result is fixed, so an Attempt that names no other resumes to it.
const effectResumed = () => EFFECT_COMPLETED;

export async function run<Prepared, Worked, Settled extends visit.Resolution>(
  context: Context,
  attempting: Attempting<Prepared, Worked, Settled>,
): Promise<Settled> {
  const { actionIdentity, busy, prepare, work, outputs, finish, settle } = attempting;
  const resumed = (attempting.resumed ?? effectResumed) as NonNullable<typeof attempting.resumed>;
  const { record: executionRecord } = context;
  const actionMarker = attempting.actionMarker ?? context.markerOf(actionIdentity);
  const savedResult = () =>
    resumed(writeAhead.findEntry(executionRecord, actionMarker, 'evidence')?.evidence ?? undefined);
  const complete = completed(executionRecord, actionMarker);
  // A complete Effect whose evidence proves nothing (a label write that did not land saves { ok: false }) is made
  // again, as an open one would be; its result and Event are saved already.
  const unproven =
    complete &&
    !!writeAhead.findEntry(executionRecord, actionMarker, 'intent') &&
    !writeAhead.evidenceOf(executionRecord, actionMarker);
  if (complete && !unproven) return savedResult();
  const prepared = (prepare ? await prepare(actionMarker) : undefined) as Prepared;
  const startedAt = context.clock.now();
  const working = () => work(prepared, actionMarker);
  const worked = busy ? await whileBusy(context, working) : await working();
  if (unproven) return savedResult();
  const takeBack = keepOutputs(context, actionIdentity, outputs?.(worked));
  const done = finishing(takeBack, () => finish(worked, prepared));
  save(context, { actionIdentity, actionMarker, startedAt }, done, settle);
  return done.resolution;
}

// A held completion's validation reads the worktree, so it is always bracketed. Its result replaces the one the hold
// saved, merged into the evidence its completion saved, with its Action Event and whatever its caller spent, in one
// write; one with no result saves only its outputs and the Visit's routing.
export async function runHeld<Worked, Settled extends visit.Resolution>(
  context: Context,
  { actionIdentity, actionMarker, work, outputs, finish, settle }: Held<Worked, Settled>,
): Promise<Settled | null> {
  const { record: executionRecord, database } = context;
  const startedAt = context.clock.now();
  const worked = await whileBusy(context, work);
  const takeBack = keepOutputs(context, actionIdentity, outputs?.(worked));
  const { resolution, ...done } = finishing(takeBack, () => finish(worked));
  settle?.(resolution);
  if (resolution === null) {
    database.save(executionRecord);
    return null;
  }
  const saved = actionMarker && writeAhead.findEntry(executionRecord, actionMarker, 'evidence');
  const settled: visit.Resolution = resolution;
  if (saved) saved.evidence = { ...saved.evidence, ...jsonValue.checkedObject(settled, 'the resolution') };
  database.save(executionRecord, eventOf(context, actionIdentity, startedAt, { ...done, resolution }));
  if (actionMarker) effectErrors.crashPoint(context, actionMarker, 'after-completion');
  return resolution;
}

// An Attempt's launch that failed for good: its marker, when the launch (or the lookup) began, and the error.
export interface FailedLaunch {
  actionMarker: string;
  startedAt: number;
  err: unknown;
}

// A remote Action whose Attempt fails for good records its Action Event where it fails, in a Visit or a Terminal alike:
// its class, its error, and the outcome and rule of what it leads to, a run stop or a fault (#251). Its save failing is
// fatal, as any Event's is.
export function failed(
  context: Context,
  { actionMarker, startedAt, err }: FailedLaunch,
  { failureClass, consequence }: { failureClass: outcome.FailureClass; consequence: 'run-stop' | 'fault' },
) {
  const { vertex, visit: visitNumber, action, recovery, attempt: attemptNumber } = marker.partsOf(actionMarker);
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
        attempt: Number(attemptNumber),
      },
      startedAt,
      {
        outcome: consequence,
        direction: 'stop',
        rule: { table: 'fixed', row: consequence },
        signals: {},
        failureClass,
        error: effectErrors.errorText(err),
      },
    );
  context.database.save(context.record, event);
}

// One Effect's Attempt: its payload made in the bracket (after `prepare`, when given), launched write-ahead, and
// completed with its Action Event. A Visit's effect Actions, a Terminal's and a Pending report's.
export function effectAction<Payload extends writeAhead.Payload, EffectContext, Prepared = undefined>(
  context: Context & NoInfer<EffectContext>,
  {
    actionIdentity,
    prepare,
    made,
    settle,
  }: {
    actionIdentity: marker.ActionIdentity;
    prepare?: (actionMarker: string) => Promise<Prepared>;
    made: (
      prepared: Prepared,
    ) =>
      | Omit<sideEffect.SideEffect<Payload, EffectContext>, 'actionMarker' | 'deferred'>
      | Promise<Omit<sideEffect.SideEffect<Payload, EffectContext>, 'actionMarker' | 'deferred'>>;
    settle?: Settle;
  },
): Promise<visit.EffectResolution> {
  return run(context, {
    actionIdentity,
    busy: true,
    prepare,
    work: async (prepared, actionMarker) =>
      sideEffect.sideEffect<Payload, EffectContext>(context, {
        actionMarker,
        ...(await made(prepared)),
        deferred: true,
      }),
    finish: () => ({ resolution: EFFECT_COMPLETED }),
    settle,
  });
}
