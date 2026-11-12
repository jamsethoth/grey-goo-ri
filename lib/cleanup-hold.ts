// A Pending cleanup hold (L11, J6): a call whose processes may still be running stops the Ticket, with the survivors
// in its comment and gg:await:cleanup on the issue, and a later Run under the ticket lock confirms cleanup afresh under
// the recorded containment (L14). The suspended Action then completes as if it had just returned (J4): each Action
// kind's completeHeld does that.
import type * as commandCleanup from './command-cleanup.ts';
import type * as effects from './effects/index.ts';
import * as effectErrors from './effect-errors.ts';
import * as labels from './labels.ts';
import type * as marker from './marker.ts';
import * as pendingReport from './pending-report.ts';
import * as reconcile from './reconcile.ts';
import * as render from './render.ts';
import type { RunContext } from './run-context.ts';
import * as terminal from './terminal.ts';
import * as writeAhead from './write-ahead.ts';

// The label the hold asks with, under V4's reserved Vertex id: no Flow can request it.
export const AWAIT_VERTEX = 'cleanup';

type HeldAction = Pick<marker.ActionIdentity, 'vertex' | 'visit' | 'action' | 'recovery'>;
type ReportAction = 'label' | 'comment' | 'release';

// One of a hold's own Actions, outside the Procedure, named with the hold's number among those of this
// Action: its retry or its Check's re-run can hold again, and an Action's remote retry budget is kept by its name.
const reportActionOf = (
  held: HeldAction,
  part: ReportAction,
  number: number,
): marker.ActionIdentity & { procedure: null } => ({
  vertex: held.vertex,
  visit: held.visit,
  procedure: null,
  action: `${held.action}.cleanup-${part}.${number}`,
  recovery: held.recovery,
});

// The holds of this Action already released, plus one.
function holdNumber(runContext: RunContext, held: HeldAction): number {
  let number = 1;
  while (
    writeAhead.findEntry(runContext.record, runContext.markerOf(reportActionOf(held, 'release', number)), 'complete')
  )
    number++;
  return number;
}

const awaitLabel = (runContext: RunContext) => labels.labelsFor(runContext.labelPrefix).await(AWAIT_VERTEX);

const REASON_MISSING = 'no reason was reported';

// What a human can do depends on what a later Run can check.
function adviceOf(runContext: RunContext, report: commandCleanup.CleanupReport): string {
  const ticket = runContext.record.ticket;
  const needsHuman = labels.labelsFor(runContext.labelPrefix).state(labels.NEEDS_HUMAN);
  const stop = `Or add ${needsHuman} to abandon the Execution.`;
  const containment = report.containment?.kind ?? 'none';
  if (containment === 'job')
    return (
      "gg closes the job's handle as this Run ends, which ends what the job still holds; " +
      `gg run ${ticket} then goes on. ${stop}`
    );
  if (containment === 'group') {
    const { pgid } = report.containment as { pgid: number };
    return `End the listed processes: gg run ${ticket} goes on once process group ${pgid} is empty. ${stop}`;
  }
  return (
    'These processes ran with no containment, so gg cannot tell when they have ended and this stays held. ' +
    `End them, then add ${needsHuman}: a human must judge the worktree.`
  );
}

function commentBody(runContext: RunContext, held: HeldAction, report: commandCleanup.CleanupReport, number: number) {
  const survivors = report.survivors
    .map(({ pid, created, commandLine, error }) => `pid ${pid}, started ${created}: ${commandLine} (${error})`)
    .join('\n');
  return render.publicBody(
    render.engineTemplate('cleanup-hold.md'),
    {
      action: terminal.actionText(held),
      vertex: held.vertex,
      reason: report.reason ?? REASON_MISSING,
      survivors,
      advice: adviceOf(runContext, report),
    },
    runContext.markerOf(reportActionOf(held, 'comment', number)),
    runContext.publicText,
  );
}

async function report(runContext: RunContext, held: HeldAction, cleanup: commandCleanup.CleanupReport) {
  const number = holdNumber(runContext, held);
  const complete = (part: ReportAction) =>
    writeAhead.findEntry(runContext.record, runContext.markerOf(reportActionOf(held, part, number)), 'complete');
  if (!complete('label'))
    await pendingReport.labelAction(runContext, reportActionOf(held, 'label', number), {
      add: [awaitLabel(runContext)],
    });
  if (!complete('comment'))
    await pendingReport.commentAction(
      runContext,
      reportActionOf(held, 'comment', number),
      await commentBody(runContext, held, cleanup, number),
    );
}

const pendingEnding = (held: HeldAction) =>
  pendingReport.pending(`What ${held.action} at ${held.vertex} started may still be running, so the Ticket waits.`);

// The Action whose result is held: no further Action touches the worktree, and no route or recovery applies.
export async function holdTicket(runContext: RunContext, held: HeldAction): Promise<never> {
  await report(runContext, held, runContext.record.visitState!.unconfirmedCleanup!);
  throw pendingEnding(held);
}

// A human's needs-human label wins, a report a crash cut short is finished, and the Run ends here unless the
// containment confirms the call's processes gone. Once it does the report clears, so the worktree can go idle again.
async function confirm(
  runContext: RunContext,
  held: HeldAction,
  cleanup: commandCleanup.CleanupReport,
  find: effects.FindEffect,
) {
  const { record: executionRecord, database } = runContext;
  const number = holdNumber(runContext, held);
  const markers = (['label', 'comment'] as const).map((part) =>
    runContext.markerOf(reportActionOf(held, part, number)),
  );
  const decided = await pendingReport.keepPendingIfUnread(runContext, `The hold on ${held.action}`, () =>
    reconcile.terminalEffects(executionRecord, {
      gh: runContext.gh,
      database,
      labelPrefix: runContext.labelPrefix,
      cwd: runContext.cwd,
      markers,
      find,
    }),
  );
  if (decided.next === 'abandon') throw new effectErrors.EarlyTerminalError(decided);
  await report(runContext, held, cleanup);
  // A stopped Run starts no work, and a confirmed hold leads straight to some, so it waits for a Run with no stop.
  if (runContext.runState.stop || !runContext.exec.cleanupConfirmed(cleanup.containment)) throw pendingEnding(held);
  executionRecord.visitState!.unconfirmedCleanup = null;
  database.save(executionRecord);
}

// A resumed record held for cleanup, confirmed once. The label comes down after that save, so a crash cannot make this
// hold read as a new one: while it stands its number is fixed, and once released no label of the next number exists.
// The suspended Action completes at its Visit (visit-runner).
export async function awaitConfirmation(runContext: RunContext, find: effects.FindEffect): Promise<void> {
  const { record: executionRecord } = runContext;
  const state = executionRecord.visitState;
  if (state?.settled?.resolution.row !== 'cleanup-unconfirmed') return;
  const held = {
    vertex: executionRecord.cursor.vertex,
    visit: executionRecord.cursor.visit as number,
    action: state.settled.action,
    recovery: state.settled.recovery,
  };
  if (state.unconfirmedCleanup) await confirm(runContext, held, state.unconfirmedCleanup, find);
  const number = holdNumber(runContext, held);
  if (writeAhead.findEntry(executionRecord, runContext.markerOf(reportActionOf(held, 'label', number)), 'intent'))
    await pendingReport.labelAction(runContext, reportActionOf(held, 'release', number), {
      remove: [awaitLabel(runContext)],
    });
}

// The report as a later Run read it: its containment confirmed its processes gone.
export const confirmedReport = (
  { containment }: Pick<commandCleanup.CleanupReport, 'containment'> = { containment: { kind: 'none' } },
): commandCleanup.CleanupReport => ({ confirmed: true, survivors: [], reason: null, containment });
