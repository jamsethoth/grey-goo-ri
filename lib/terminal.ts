// Terminals: the hold, abandonment, fault and run stops that end an Execution, the Terminal it ends at, and the
// sentences of their Terminal Reasons. A Terminal's report is terminal-report's.
import * as effectErrors from './effect-errors.ts';
import * as effects from './effects/index.ts';
import type * as sideEffect from './effects/side-effect.ts';
import * as flow from './flow.ts';
import * as labels from './labels.ts';
import * as record from './record.ts';
import * as terminalReport from './terminal-report.ts';
import type * as visit from './visit.ts';

type TerminalContext = terminalReport.TerminalContext;
type TerminalResult = terminalReport.TerminalResult;

// Reconciliation or admission could not proceed safely: the ticket goes to needs-human with the reason, and the record
// is kept as Held. `advice` follows the reason in the comment only; `fresh` marks a hold decided before any Execution
// ran, which may restart once it has landed.
export async function hold(
  context: TerminalContext,
  {
    name = 'reconciliation',
    terminalReasonText,
    advice,
    detail,
    fresh,
  }: {
    name?: string | null;
    terminalReasonText: string;
    advice?: string | null;
    detail?: string | null;
    fresh?: boolean;
  },
): Promise<TerminalResult> {
  const { record: executionRecord } = context;
  executionRecord.terminalReason = holdReason(executionRecord, name, terminalReasonText);
  executionRecord.cursor = record.terminalCursor(labels.NEEDS_HUMAN);
  return terminal(context, labels.NEEDS_HUMAN, { outcome: labels.NEEDS_HUMAN, held: true, advice, detail, fresh });
}

// A human's needs-human label overrides the record (request 3.5). Its abandonment is saved before any cleanup, which
// only removes in-progress, so nothing is posted or added; the abandoned state lands with ticket_end.
export async function abandon(
  context: TerminalContext,
  { terminalReasonText, inProgress }: { terminalReasonText: string; inProgress: boolean },
): Promise<TerminalResult> {
  const { record: executionRecord } = context;
  executionRecord.terminalReason = {
    decidedBy: naming(executionRecord, { human: labels.labelsFor(context.labelPrefix).state(labels.NEEDS_HUMAN) }),
    outcome: null,
    rule: null,
    text: terminalReasonText,
  };
  return terminal(context, 'abandoned', { outcome: 'abandoned', abandoned: true, inProgress });
}

// The Terminal Reason of a hold, named `name`, which names the Visit it cut off.
export const holdReason = (
  executionRecord: record.ExecutionRecord,
  name: string | null,
  text: string,
): record.TerminalReason => ({
  decidedBy: naming(executionRecord, { hold: name }),
  outcome: null,
  rule: null,
  text,
});

// A hold or a human, with the Visit it cut off when there is one.
function naming(executionRecord: record.ExecutionRecord, decider: { hold: string | null } | { human: string }) {
  const cutOff = visitCutOff(executionRecord);
  return cutOff ? { ...decider, ...cutOff } : decider;
}

// The Visit a hold or abandonment cut off, and the Action and Recovery Number the cursor is at (#341): the cursor's
// when it is inside a Visit; else, at a Terminal, the one the reason it replaces named when its Visit was entered and
// cut off, as when a hold's own report finds a human's label. A Visit that took its Edge saved its Terminal's stop with
// the Action that stopped it, or saved none, so a stop that names no Action (a hold's, a fault's, a run stop's or an
// abandonment's) is one that cut its Visit off. A fresh Execution, or the next Vertex's cursor saved before its entry,
// names none; so does a fault decided there.
function visitCutOff(executionRecord: record.ExecutionRecord): ReasonActionIdentity | null {
  const { cursor } = executionRecord;
  if (entered(executionRecord, cursor)) return actionIdentityOf(cursor);
  const cutOff = flow.isEnd(cursor.vertex) && executionRecord.terminalStop?.actionRef === null;
  const decidedBy = cutOff ? executionRecord.terminalReason?.decidedBy : undefined;
  return decidedBy?.vertex !== undefined && entered(executionRecord, decidedBy) ? actionIdentityOf(decidedBy) : null;
}

// Whether the Visit an identity names was entered: the cursor of a Visit not yet entered names its number already.
const entered = (executionRecord: record.ExecutionRecord, { vertex, visit: visitNumber }: ReasonActionIdentity) =>
  visitNumber !== null && executionRecord.visits.get(vertex) === visitNumber;

const actionIdentityOf = ({ vertex, visit: visitNumber, action, recovery }: ReasonActionIdentity) => ({
  vertex,
  visit: visitNumber,
  action,
  recovery,
});

const ON_TICKET_END = 'the error is in this comment and on ticket_end.';

const httpOf = (status: number | null) => (status ? ` (HTTP ${status})` : '');

// A fault's Terminal Reason: a retry budget that ran out, a final remote failure by its class, or an unexpected fault.
function faultText(err: unknown, where: string | null): string {
  if (err instanceof effectErrors.RetriesExhaustedError) {
    const { spent } = err;
    // A spent push names it; every other remote Effect lands on GitHub.
    const target = effects.lookup(spent.effect)?.remote === 'origin' ? 'push' : 'GitHub';
    const what = spent.failureClass === 'rate-limited' ? `A ${target} rate limit` : `A transient ${target} failure`;
    return `${what}${httpOf(spent.status)} at ${where} persisted after ${spent.count} retries; ${ON_TICKET_END}`;
  }
  const final = (err as { remoteFailure?: effectErrors.FinalRemoteFailure } | null | undefined)?.remoteFailure;
  if (final) {
    const reach = final.reach === 'run' ? 'stops the whole run' : 'faults only this Ticket';
    return (
      `The ${final.effect} at ${where} failed with class ${final.failureClass}${httpOf(final.status)}, which ` +
      `${reach}; ${ON_TICKET_END}`
    );
  }
  return `An unexpected fault stopped the Execution at ${where}; ${ON_TICKET_END}`;
}

// An unexpected fault is never retried: the ticket goes to needs-human with the error, and the record is marked fault
// with its ticket_end.
export async function fault(context: TerminalContext, err: unknown): Promise<TerminalResult> {
  const { record: executionRecord } = context;
  const error = effectErrors.errorText(err) || 'unknown error';
  const { vertex, visit: visitNumber, action, recovery } = executionRecord.cursor;
  // The fault replaces the Terminal Reason, so the reason of a Terminal it interrupted travels in the fault comment.
  const interrupted =
    flow.isEnd(vertex) && executionRecord.terminalReason
      ? { terminal: vertex, terminalReason: executionRecord.terminalReason }
      : null;
  executionRecord.cursor = record.terminalCursor(labels.NEEDS_HUMAN);
  const where = action ? actionText({ action, recovery }) : vertex;
  executionRecord.terminalReason = {
    decidedBy: { vertex, visit: visitNumber, action, recovery },
    outcome: null,
    rule: null,
    text: faultText(err, where),
  };
  return terminal(context, labels.NEEDS_HUMAN, { outcome: 'fault', detail: error, error, interrupted });
}

// Another Execution's run stop ends this one at needs-human before it starts another Action or Attempt (request 3.4).
export const runStopped = (context: {
  runState?: sideEffect.RunState;
}): (visit.RunStoppedResolution & { source: string | null }) | null => {
  const stop = context.runState?.stop;
  return stop
    ? {
        outcome: labels.NEEDS_HUMAN,
        direction: 'stop',
        row: 'run-stopped',
        rule: { table: 'fixed', row: 'run-stopped' },
        failureClass: stop.failureClass,
        runStopTicket: stop.ticket,
        source: stop.source ?? null,
      }
    : null;
};

// The Action a Terminal Reason names: a Visit's Action, or the cursor where a stop or fault found the Execution.
type ReasonActionIdentity = { vertex: string; visit: number | null; action: string | null; recovery: number };

// Only the Visit that routes to a Terminal keeps its reason; the Signals stay on the deciding Action's Event. `rule` is
// the rule identity { table, row } (request 3.3).
export const terminalReason = (
  { vertex, visit: visitNumber, action, recovery }: ReasonActionIdentity,
  outcomeName: string,
  resolution: { rule: visit.RuleIdentity },
  text: string,
): record.TerminalReason => ({
  decidedBy: { vertex, visit: visitNumber, action, recovery },
  outcome: outcomeName,
  rule: resolution.rule,
  text,
});

// An Action as a Terminal Reason names it: its id, and the recovery pass it ran in.
export const actionText = ({ action, recovery }: { action: string | null; recovery: number }): string | null =>
  recovery ? `${action} (recovery ${recovery})` : action;

// What stopText reads of the resolution that stopped an Action.
export interface StopResolution {
  row?: string | null;
  rule: { table: string; row: string | number | null };
  failureClass?: string | null;
  // What failed in a run stop: a remote Action's effect; absent for a harness call.
  source?: string | null;
  surfaces?: string[] | null;
  runStopTicket?: number;
  // A stop found during a backoff, rather than before the Action.
  retrying?: boolean;
  actionCap?: number;
  signal?: visit.CheckSignal;
}

// The sentence for a fixed row of the Transition Table, or undefined for a row of a Procedure's table.
function rowText(where: string | null, vertex: string, resolution: StopResolution): string | undefined {
  const failureClass = resolution.failureClass ?? 'unknown';
  // A run stop names what failed: a remote Action's effect, else the harness call.
  const source = resolution.source ?? 'harness call';
  switch (resolution.row) {
    case 'integrity-violation':
      return resolution.surfaces
        ? `The agent's Attempt at ${where} broke an Integrity Assertion on ${resolution.surfaces.join(' and ')}, so ` +
            'the worktree was restored to its baseline head.'
        : `Test Immutability failed at ${where}: a committed test was changed.`;
    case 'parse-exhausted':
      return `The agent gave no valid Structured Response at ${where}, even after the return-the-result nudge.`;
    case 'timeout-exhausted':
      return `The harness call at ${where} timed out or was killed, and so did its retry.`;
    case 'transient-exhausted':
      return `The harness call at ${where} kept failing with class ${failureClass} until its retry budget ran out.`;
    case 'run-stop':
      return `The ${source} at ${where} failed with class ${failureClass}, which stops the whole run.`;
    // A stop found during a backoff (`retrying`) leaves the Action's retry as saved.
    case 'run-stopped':
      return (
        `The ${source} of Ticket #${resolution.runStopTicket} failed with class ${failureClass}, which stops the ` +
        'whole run, so this Execution stopped ' +
        (resolution.retrying ? `while waiting to retry ${where}; its retry is kept as saved.` : `before ${where}.`)
      );
    case 'unknown-failure':
      return `The harness call at ${where} failed with class ${failureClass}, which is never retried.`;
    case 'action-cap':
      return (
        `The Execution reached its Action Cap of ${resolution.actionCap} Attempts, so ${where} at ${vertex} did ` +
        'not run.'
      );
  }
  return undefined;
}

// The Terminal Reason's sentence for an Action that stopped with `outcomeName`.
export function stopText(
  actionIdentity: { vertex: string; action: string | null; recovery: number },
  outcomeName: string,
  resolution: StopResolution,
): string {
  const where = actionText(actionIdentity);
  if (resolution.row === 'decision') return `The Decision at ${actionIdentity.vertex} was ${outcomeName}.`;
  const fixed = rowText(where, actionIdentity.vertex, resolution);
  if (fixed !== undefined) return fixed;
  // A final failure names its Check from the Check signal (U14); the Check's reason is posted fenced, as it may quote
  // the agent.
  if (outcomeName === 'failed' && resolution.signal) {
    const check = `${actionIdentity.vertex}.${resolution.signal.id}`;
    return `The ${resolution.signal.kind} Check ${check} failed with no recovery left.`;
  }
  // The agent's diagnosis stays out: the blocked comment posts it fenced, and it need not be one sentence.
  if (outcomeName === 'blocked')
    return `The agent made a blocked Claim at ${actionIdentity.vertex}; its diagnosis in the blocked comment says why.`;
  if (outcomeName === 'misscoped')
    return `The agent made a misscoped Claim at ${actionIdentity.vertex}; its diagnosis is posted with this reason.`;
  return `${where} ended with ${outcomeName} (${resolution.rule.table} rule ${resolution.rule.row ?? 'default'}).`;
}

// An Execution ended early, as an Action found it must (effectErrors.EarlyTerminalError): held, abandoned, or stopped.
export function endEarly(context: TerminalContext, ending: effectErrors.Ending): Promise<TerminalResult> {
  context.log(`#${context.record.ticket} ${ending.next}: ${ending.reason}`);
  if (ending.next === 'pending')
    return Promise.resolve({ outcome: 'pending', ...(ending.unread && { unread: ending.unread }) });
  // A run stop ends what would start new work (request 3.4). An Execution Pending on its request or on a cleanup hold
  // starts none, and ending it would lose the request or end a hold whose writers may still run, so it waits on as it
  // was, its intents and retry budgets with it.
  const { approvalRequest, visitState } = context.record;
  if (ending.next === 'run-stopped' && (approvalRequest || visitState?.unconfirmedCleanup))
    return Promise.resolve({ outcome: 'pending' });
  if (ending.next === 'run-stopped') return runStoppedAt(context, ending.retrying);
  if (ending.next === 'run-stop') return runStopAt(context, ending);
  return ending.next === 'abandon'
    ? abandon(context, { terminalReasonText: ending.reason, inProgress: ending.inProgress })
    : hold(context, {
        name: ending.name,
        terminalReasonText: ending.reason,
        advice: ending.advice,
        detail: ending.detail,
      });
}

// A run stop found during a backoff or a repo-lock wait ends the Execution at needs-human with the run-stopped reason,
// naming the Action it stopped; one stopped in a backoff is left with its retry as saved.
function runStoppedAt(context: TerminalContext, retrying: boolean) {
  const { record: executionRecord } = context;
  const resolution = runStopped(context)!;
  const cursor = executionRecord.cursor;
  executionRecord.terminalReason = terminalReason(
    cursor,
    resolution.outcome,
    resolution,
    stopText(cursor, resolution.outcome, { ...resolution, retrying }),
  );
  executionRecord.cursor = record.terminalCursor(labels.NEEDS_HUMAN);
  return terminal(context, labels.NEEDS_HUMAN, { outcome: labels.NEEDS_HUMAN });
}

// A remote Action whose Failure Class reaches the whole Run ends its Execution as a Harness run stop does (#240).
function runStopAt(context: TerminalContext, { failureClass, source, detail }: effectErrors.RunStopEnding) {
  const { record: executionRecord } = context;
  const cursor = executionRecord.cursor;
  const resolution = { row: 'run-stop', rule: { table: 'fixed', row: 'run-stop' } as const, failureClass, source };
  executionRecord.terminalReason = terminalReason(
    cursor,
    'run-stop',
    resolution,
    stopText(cursor, 'run-stop', resolution),
  );
  executionRecord.cursor = record.terminalCursor(labels.NEEDS_HUMAN);
  return terminal(context, labels.NEEDS_HUMAN, { outcome: 'run-stop', failureClass, detail });
}

// Runs a Terminal's report. An Action of its own that finds the Execution must end otherwise (a retry that meets a
// human's label, or a run stop) throws effectErrors.EarlyTerminalError like any other, and is ended here, since a fault
// report may run from runExecution's catch, past the one there.
export async function terminal(
  context: TerminalContext,
  name: string,
  stop?: terminalReport.StopDeclaration,
): Promise<TerminalResult> {
  try {
    return await terminalReport.report(context, name, stop);
  } catch (err) {
    if (err instanceof effectErrors.EarlyTerminalError) return endEarly(context, err.ending);
    throw err;
  }
}
