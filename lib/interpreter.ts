// The interpreter: runs one Execution of a Ticket through its Flow, Visit by Visit, from its cursor to a Terminal. It
// reconciles a resumed record first, finishes a report a Run before decided, and ends whatever is thrown as a Terminal.
// Its modules: run-context (the deps and the context every step reads), visit-runner (one Visit), the Action kinds
// (agent-action, check-action, effect-actions), visit-scope (what every Action reads) and bounds (Edge traversal).
import * as cleanupHold from './cleanup-hold.ts';
import * as effectErrors from './effect-errors.ts';
import * as effectEvidence from './effect-evidence.ts';
import * as effects from './effects.ts';
import * as eventRead from './event-read.ts';
import * as events from './events.ts';
import * as flow from './flow.ts';
import * as labels from './labels.ts';
import * as pendingRun from './pending-report.ts';
import * as reconcile from './reconcile.ts';
import * as record from './record.ts';
import * as remoteEffects from './remote-effects.ts';
import * as context from './run-context.ts';
import * as terminal from './terminal.ts';
import * as terminalReport from './terminal-report.ts';
import * as visitRunner from './visit-runner.ts';
import type * as writeAhead from './write-ahead.ts';

export { CrashError } from './effect-errors.ts';
export type { Deps, ExecutionOptions, RunContext } from './run-context.ts';

type RunContext = context.RunContext;
type TerminalResult = terminalReport.TerminalResult;

// gg's own Protected Files; every shipped Harness adds the paths that configure it, whichever Harness an Agent uses,
// since a later Vertex on that Harness would load them (request 3.6).
const GG_PROTECTED_PATHS = ['.agents/', '.github/actions/', '.github/workflows/'];
// Built before preflight from every shipped Harness, so a malformed declaration fails here, by name, not as an
// unprotected path.
export function protectedFiles(harnesses: Record<string, { protectedPaths?: unknown }>): string[] {
  const declared = Object.entries(harnesses).flatMap(([name, { protectedPaths: paths }]) => {
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string' && path))
      throw new Error(`harness ${name} must declare protectedPaths as an array of paths`);
    return paths as string[];
  });
  return [...new Set([...GG_PROTECTED_PATHS, ...declared])].sort();
}

// A hold, fault or abandonment decided and saved, at admission or by a Terminal, whose ticket_end has not landed: the
// next Run finishes its report.
export const pendingReport = (executionRecord: record.ExecutionRecord): boolean =>
  (!!executionRecord.admissionStop && !eventRead.hasTicketEnd(executionRecord.commonDir, executionRecord.execution)) ||
  context.reportDecided(executionRecord);

// Reconciliation looks for a remote effect as a retry does: a failed lookup is retried on the Action's budget.
const findEffect =
  (runContext: RunContext): effectEvidence.FindEffect =>
  (entry: writeAhead.WriteAheadEntry, evidenceContext: effectEvidence.EvidenceContext) =>
    remoteEffects.REMOTE_ACTIONS.includes(entry.effect as string)
      ? remoteEffects.findEffectRetrying(runContext, entry, evidenceContext)
      : effectEvidence.findEffect(entry, evidenceContext);

export async function runExecution(options: context.ExecutionOptions): Promise<TerminalResult> {
  // Missing, nothing would be protected.
  if (!options.protectedPaths) throw new Error('runExecution needs protectedPaths');
  const runContext = context.createRunContext(options);
  const executionRecord = runContext.record;
  // A decision admission saved with the record is reported as decided, never decided again.
  const admission = options.admission ?? executionRecord.admissionStop;
  try {
    if (options.fault) throw options.fault;
    if (admission?.kind === 'fault') throw new Error(admission.error as string);
    if (admission?.kind === 'hold') return await terminal.hold(runContext, admission as HoldDecision);
    if (admission?.kind === 'abandon') return await terminal.abandon(runContext, admission as AbandonDecision);
    if (runContext.laterRunReport) return await finishReport(runContext);
    // A record that has entered a Vertex is resumed, so GitHub and git are reconciled with it first.
    if (executionRecord.visits.size) {
      const ended = await resume(runContext);
      if (ended) return ended;
    }
    return await runVertices(runContext);
  } catch (caught) {
    return await endCaught(runContext, caught);
  } finally {
    closeHeldJob(executionRecord);
  }
}

// Before the ticket lock is released, so kill-on-close has fired by the time a later Run holds it (#245).
const closeHeldJob = (executionRecord: record.ExecutionRecord) =>
  executionRecord.visitState?.unconfirmedCleanup?.closeJob?.();
type HoldDecision = Parameters<typeof terminal.hold>[1];
type AbandonDecision = Parameters<typeof terminal.abandon>[1];

// A decided needs-human or abandonment report is a comment and a label: only their own intents are looked for.
async function finishReport(runContext: RunContext): Promise<TerminalResult> {
  const { record: executionRecord } = runContext;
  const terminalStop = executionRecord.terminalStop!;
  const name = terminalStop.abandoned ? 'abandoned' : labels.NEEDS_HUMAN;
  const markers = ['comment', 'label'].map((effect) =>
    runContext.markerOf(terminalReport.terminalActionIdentity(name, terminalStop)(effect)),
  );
  const decided = await reconcile.terminalEffects(executionRecord, {
    gh: runContext.gh,
    database: runContext.database,
    labelPrefix: runContext.labelPrefix,
    cwd: runContext.cwd,
    markers,
    find: findEffect(runContext),
  });
  if (decided.next === 'abandon')
    return await terminal.abandon(runContext, { terminalReasonText: decided.reason, inProgress: decided.inProgress });
  return await terminal.terminal(runContext, name);
}

// Reconciliation of a resumed record: a hold or abandonment it decides ends the Execution here, else it continues.
async function resume(runContext: RunContext): Promise<TerminalResult | null> {
  const { record: executionRecord } = runContext;
  await cleanupHold.awaitConfirmation(runContext, findEffect(runContext));
  const reconciled = () =>
    effects.whileBusy(runContext, () =>
      reconcile.reconcile({
        record: executionRecord,
        flow: runContext.flow,
        git: runContext.git,
        integrity: runContext.integrity,
        gh: runContext.gh,
        database: runContext.database,
        labelPrefix: runContext.labelPrefix,
        cwd: runContext.cwd,
        find: findEffect(runContext),
      }),
    );
  const decided =
    executionRecord.approvalRequest || reconcile.heldForCleanup(executionRecord)
      ? await pendingRun.keepPendingIfUnread(runContext, `#${executionRecord.ticket}`, reconciled)
      : await reconciled();
  if (decided.next !== 'continue') {
    const advice = 'advice' in decided && decided.advice ? ` ${decided.advice}` : '';
    runContext.log(`#${executionRecord.ticket} ${decided.next}: ${decided.reason}${advice}`);
  }
  if (decided.next === 'abandon')
    return await terminal.abandon(runContext, { terminalReasonText: decided.reason, inProgress: decided.inProgress });
  if (decided.next === 'hold')
    return await terminal.hold(runContext, {
      name: decided.name,
      terminalReasonText: decided.reason,
      advice: decided.advice,
    });
  return null;
}

// The persisted cursor, not the Flow's entry: a restart continues at the Action it names with the Edge counts already
// taken. Each next Vertex's cursor is saved with the traversal count and the ended Visit's visit_end, so a crash
// before it runs routes the same way and writes that visit_end once. The Terminal cursor, reason, stop and visit_end
// are one save, before any Terminal side effect, so a crash inside the Terminal keeps all four. A resume inside the
// Terminal has them saved already.
async function runVertices(runContext: RunContext): Promise<TerminalResult> {
  const { record: executionRecord } = runContext;
  let ended: visitRunner.VisitEnd = { next: executionRecord.cursor.vertex, stop: null, reason: null, taken: null };
  while (!flow.isEnd(ended.next)) {
    ended = await visitRunner.runVisit(runContext, ended.next, executionRecord.cursor.visit!);
    if (flow.isEnd(ended.next)) break;
    const visitEnd = visitEndEvent(runContext, ended);
    const visitNumber = (executionRecord.visits.get(ended.next) ?? 0) + 1;
    executionRecord.cursor = { vertex: ended.next, visit: visitNumber, action: null, recovery: 0, attempt: 1 };
    runContext.database.save(executionRecord, visitEnd);
  }
  const { next, stop, reason } = ended;
  if (reason) {
    executionRecord.cursor = record.terminalCursor(next);
    executionRecord.terminalReason =
      next === 'ready-for-qa'
        ? { ...reason, text: `${reason.text} PR #${executionRecord.pr} is ready for review.` }
        : reason;
    executionRecord.terminalStop = stop && terminalReport.declaredStop(stop);
    runContext.database.save(executionRecord, visitEndEvent(runContext, ended));
  }
  return await terminal.terminal(runContext, next);
}

// The ended Visit's visit_end, written in the save that moves the cursor past it; none for a Visit that took no Edge.
function visitEndEvent(runContext: RunContext, { next, taken }: visitRunner.VisitEnd): (() => void) | null {
  if (!taken) return null;
  const { record: executionRecord } = runContext;
  const { vertex, visit } = executionRecord.configurationSnapshot!;
  const { outcome, rule, traversal } = taken;
  return () =>
    runContext.events('visit_end', {
      run: runContext.run,
      execution: executionRecord.execution,
      ticket: executionRecord.ticket,
      vertex,
      visit,
      outcome,
      rule,
      next,
      edge: traversal.withinBound ? traversal.key : null,
      count: traversal.withinBound ? traversal.count : null,
      spent: traversal.spentBounds,
    });
}

// An Action found deep inside it that the Execution ends now (effectErrors.EarlyTerminalError), so it unwound to here
// to be ended as found. An ending whose own report fails is settled below like any other Terminal's: a run stop's
// becomes a fault, and its class stays on its Action Event. A decided hold, abandonment or resumed fault stays as
// decided when its report fails: its open intents are the next Run's to reconcile, so nothing is reported twice.
async function endCaught(runContext: RunContext, caught: unknown): Promise<TerminalResult> {
  const { record: executionRecord } = runContext;
  let err = caught;
  if (err instanceof effectErrors.EarlyTerminalError) {
    try {
      return await terminal.endEarly(runContext, err.ending);
    } catch (reportErr) {
      err = reportErr;
    }
  }
  if (effectErrors.fatal(err)) throw err;
  if (runContext.laterRunReport || executionRecord.terminalStop?.held || executionRecord.terminalStop?.abandoned) {
    const result: TerminalResult & { error: string } = {
      outcome: executionRecord.terminalStop!.abandoned ? 'abandoned' : labels.NEEDS_HUMAN,
      fault: true,
      error: effectErrors.errorText(err),
    };
    const runStop = terminalReport.runStopOf(executionRecord, runContext.log);
    if (runStop) result.runStop = runStop;
    return result;
  }
  return await terminal.fault(runContext, err);
}
