// One Visit of a Vertex: its entry (the Configuration Snapshot and inputs), its Actions in order with their recovery
// passes, and where it leaves: a stop's Terminal, or the Visit's Outcome through the Edge it takes.
import { basename } from 'node:path';
import * as agentAction from './agent-action.ts';
import * as attempt from './attempt.ts';
import * as approvalAction from './approval-action.ts';
import * as bounds from './bounds.ts';
import * as checkAction from './check-action.ts';
import * as checks from './checks.ts';
import * as cleanupHold from './cleanup-hold.ts';
import * as config from './config.ts';
import * as effectActions from './effect-actions.ts';
import * as events from './events.ts';
import * as integrity from './integrity.ts';
import * as labels from './labels.ts';
import type * as marker from './marker.ts';
import * as model from './model.ts';
import * as outcome from './outcome.ts';
import type * as procedures from './procedures.ts';
import * as reconcile from './reconcile.ts';
import type * as record from './record.ts';
import * as rescue from './rescue.ts';
import type { RunContext } from './run-context.ts';
import * as terminal from './terminal.ts';
import type * as terminalReport from './terminal-report.ts';
import type * as visit from './visit.ts';
import * as visitInputs from './visit-inputs.ts';
import * as visitScope from './visit-scope.ts';

type ActionResolution = visitScope.ActionResolution;
type RunningVisit = visitScope.RunningVisit;

// Where a Visit leaves: the next Vertex or end, the stop a Terminal saves, the Terminal Reason if it decides one, and
// the Outcome that took the Edge, with its rule and Traversal, which visit_end records. A hold before the Visit's
// Actions took no Edge.
export interface VisitEnd {
  next: string;
  stop: terminalReport.StopDeclaration | null;
  reason: record.TerminalReason | null;
  taken: { outcome: string; rule: visit.RuleIdentity; traversal: bounds.Traversal } | null;
}
// The last Action the Visit ran and its result.
interface Ran {
  actionIdentity: marker.ActionIdentity;
  resolution: ActionResolution;
}

// Each Action kind (procedures.ACTION_KEYS) by its `do`.
const KINDS: Record<
  procedures.ActionKind,
  (runContext: RunContext, running: visitScope.Running) => Promise<ActionResolution>
> = {
  agent: agentAction.agent,
  check: checkAction.check,
  ...effectActions.EFFECT_KINDS,
  'await-approval': approvalAction.awaitApproval,
};

// A cursor inside this Visit's Actions is a restart: the Visit continues on its pinned snapshot and saved state.
// Otherwise a copy of everything the Visit reads is pinned, so a Flow or command edited mid-Visit cannot reach its
// Actions, Checks or routing. The Procedure is pinned by name and hash (S6): Reconciliation holds a resumed Visit whose
// Procedure changed.
async function enterVisit(runContext: RunContext, vertexId: string, visitNumber: number): Promise<boolean> {
  const { flow, record: executionRecord } = runContext;
  const resuming =
    executionRecord.cursor.action !== null &&
    executionRecord.configurationSnapshot?.vertex === vertexId &&
    executionRecord.configurationSnapshot.visit === visitNumber &&
    !!executionRecord.visitState;
  executionRecord.visits.set(vertexId, visitNumber);
  if (resuming) return true;
  const { agent, access, procedure, outcomes, route, inputs: declared } = model.vertex(flow, vertexId);
  // The Persona's bytes from the Source that names it; a Vertex without an Agent (publish) pins none.
  const bytes = agent && config.namedFile(runContext.files, agent.persona);
  executionRecord.configurationSnapshot = structuredClone({
    vertex: vertexId,
    visit: visitNumber,
    configHash: '',
    agent,
    access,
    procedure: { name: procedure, hash: model.procedure(flow, procedure).hash },
    outcomes,
    route: route ?? null,
    routes: flow.ticket.routes ?? null,
    inputs: visitInputs.resolveInputs(executionRecord, vertexId, declared),
    commands: runContext.commands!,
    testPaths: runContext.testPaths!,
    persona: agent && { name: basename(agent.persona), bytes: bytes!, hash: config.sha256(bytes!) },
  });
  // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry;
  // log it against the Config Hash when gg run reloads between Vertices (#184).
  runContext.database.save(executionRecord);
  return false;
}

// A rollback (an Integrity Violation) is safe only when the agent made every change (request 3.5), and any Vertex's
// agent may cause one whatever its access, so every Vertex starts only on a clean worktree or one an open intent
// explains, as at admission (R2d); anything else is Held before any agent runs.
async function heldDirty(runContext: RunContext, vertexId: string): Promise<VisitEnd | null> {
  const executionRecord = runContext.record;
  const dirty = await attempt.whileBusy(runContext, () =>
    reconcile.dirtyState(executionRecord, {
      git: runContext.git,
      worktree: executionRecord.worktree,
      integrity: runContext.integrity,
    }),
  );
  if (!dirty) return null;
  executionRecord.history.push({
    kind: 'held',
    text: `The worktree had uncommitted changes before ${vertexId}; nothing was deleted.`,
  });
  return {
    next: labels.NEEDS_HUMAN,
    stop: { outcome: labels.NEEDS_HUMAN },
    taken: null,
    reason: {
      decidedBy: { hold: 'dirty-worktree' },
      outcome: null,
      rule: null,
      text: `The worktree had uncommitted changes before ${vertexId}, so no agent ran and nothing was deleted.`,
    },
  };
}

// Saved with the record, so a restart has the agent call and Check runs the remaining Actions read. `call` is the agent
// Action's latest Attempt, `checks` each Check's latest signal, `runs` what the recovery Brief and the Terminal Reason
// read.
function visitStateOf(executionRecord: record.ExecutionRecord, resuming: boolean, proc: model.Procedure) {
  const state = (executionRecord.visitState = resuming
    ? executionRecord.visitState!
    : {
        recovery: 0,
        firstAttemptBaseline: null,
        call: null,
        response: null,
        runs: new Map(),
        checks: new Map(),
        checkFollows: false,
        settled: null,
        unconfirmedCleanup: null,
      });
  // Not enumerable, so the Procedure's data stays out of the saved record.
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  Object.defineProperty(state, 'claimTokens', { value: proc.claimTokens, enumerable: false });
  return state as RunningVisit;
}

export async function runVisit(runContext: RunContext, vertexId: string, visitNumber: number): Promise<VisitEnd> {
  const { flow, record: executionRecord } = runContext;
  const resuming = await enterVisit(runContext, vertexId, visitNumber);
  const proc = model.procedure(flow, executionRecord.configurationSnapshot!.procedure.name);
  if (!resuming) {
    const held = await heldDirty(runContext, vertexId);
    if (held) return held;
  }
  const state = visitStateOf(executionRecord, resuming, proc);
  const ran = await runActions(runContext, state, resuming);
  return 'next' in ran ? ran : completeVisit(runContext, ran, state);
}

// The Visit's Actions from the cursor's, each entered with the Recovery Number of its pass. A result saved before a
// crash is routed again; its Action is not rerun, as a stop's rollback may have removed the work. A `recover` result
// starts the next pass, which resumes the agent's Session, then every Check runs again (T4a, R1a). The first stop ends
// the Visit; else the last Action's result decides it.
async function runActions(runContext: RunContext, state: RunningVisit, resuming: boolean): Promise<VisitEnd | Ran> {
  const executionRecord = runContext.record;
  const snapshot = executionRecord.configurationSnapshot!;
  const { actions } = state.proc;
  const agentIndex = actions.findIndex((action) => action.do === 'agent');
  let last: Ran | null = null;
  for (
    let actionIndex = resuming ? actions.findIndex((candidate) => candidate.id === executionRecord.cursor.action) : 0;
    actionIndex < actions.length;
    actionIndex++
  ) {
    const action = actions[actionIndex];
    const actionIdentity = {
      vertex: snapshot.vertex,
      visit: snapshot.visit,
      procedure: snapshot.procedure.name,
      action: action.id,
      recovery: state.recovery,
    };
    await runContext.enter(actionIdentity);
    state.checkFollows = actions.slice(actionIndex + 1).some((later) => later.do === 'check');
    const running = { actionIdentity, action, state, settle: settleOf(executionRecord, { actionIdentity, state }) };
    const settled = await savedResult(runContext, running);
    if (settled === 'rerun-checks') {
      actionIndex = actions.findIndex((candidate) => candidate.do === 'check') - 1;
      continue;
    }
    approvalAction.waitThroughStop(runContext, running, settled);
    const resolution: ActionResolution =
      settled ??
      terminal.runStopped(runContext) ??
      bounds.capped(runContext) ??
      (await KINDS[action.do](runContext, running));
    // A run stop routed again from its saved result still stops the other Executions.
    if (resolution.row === 'run-stop' && runContext.runState)
      runContext.runState.stop ??= { failureClass: resolution.failureClass!, ticket: executionRecord.ticket };
    last = { actionIdentity, resolution };
    if (resolution.row === 'recover') {
      state.recovery += 1;
      actionIndex = agentIndex - 1;
      continue;
    }
    if (resolution.direction === 'advance') continue;
    return stopVisit(runContext, state, last, !settled);
  }
  return last!;
}

// The Action's saved result, if any. One held for cleanup is completed first (J4): a retry leaves it none, so the agent
// Action goes on to its next Attempt, and a changed tree re-runs the Visit's Checks.
async function savedResult(
  runContext: RunContext,
  running: visitScope.Running,
): Promise<ActionResolution | 'rerun-checks' | null> {
  const { actionIdentity, action, state } = running;
  if (state.settled?.action !== actionIdentity.action || state.settled.recovery !== actionIdentity.recovery)
    return null;
  if (state.settled.resolution.row !== 'cleanup-unconfirmed') return state.settled.resolution;
  const held = { ...running, settle: settleOf(runContext.record, running, { held: true }) };
  return action.do === 'agent'
    ? agentAction.completeHeld(runContext, held)
    : checkAction.completeHeld(runContext, held);
}

// The Visit's write of an Action's result, which lib/attempt.ts applies inside the Attempt's save, so a resumed Visit
// routes it instead of running the Action again. A retry is no result: its Action runs its next Attempt. A held
// completion's retry clears the held result; one with no result found the tree changed, so the Visit's Checks re-run
// from the first (T1), the cursor moving there in the same write, so a crash re-runs them all. Saved with the cursor,
// which then reads as this Attempt already entered, the re-run counts once toward the Action Cap.
export function settleOf(
  executionRecord: record.ExecutionRecord,
  { actionIdentity, state }: Pick<visitScope.Running, 'actionIdentity' | 'state'>,
  { held = false }: { held?: boolean } = {},
): attempt.Settle {
  return (resolution) => {
    if (resolution && resolution.direction !== 'retry')
      state.settled = { action: actionIdentity.action, recovery: actionIdentity.recovery, resolution };
    else if (held) state.settled = null;
    if (!held || resolution) return;
    const firstCheck = state.proc.actions.find((candidate) => candidate.do === 'check')!;
    executionRecord.cursor = { ...executionRecord.cursor, action: firstCheck.id, attempt: 1 };
    executionRecord.attempts += 1;
  };
}

// An Action that stopped the Visit: its result is saved, so a restart routes it again, and the stop takes its Edge.
async function stopVisit(runContext: RunContext, state: RunningVisit, ran: Ran, unsaved: boolean): Promise<VisitEnd> {
  const { actionIdentity, resolution } = ran;
  const outcomeName = resolution.outcome;
  if (unsaved) {
    state.settled = {
      action: actionIdentity.action,
      recovery: actionIdentity.recovery,
      resolution: resolution as visit.Resolution,
    };
    runContext.database.save(runContext.record);
  }
  if (resolution.row === 'cleanup-unconfirmed') return cleanupHold.holdTicket(runContext, actionIdentity);
  // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4): an
  // agent Attempt's violation, Test Immutability included, rolls back to that Attempt's baseline. The call's own marker
  // is complete, so its rollback is an Action of its own. A failure routed to a Vertex is rescued, and one routed to an
  // end leaves the work in place for the human (R5, U10).
  if (resolution.row === 'integrity-violation') await rollBack(runContext, state, ran);
  else await rescueRouted(runContext, state, ran);
  const traversal = bounds.traverse(runContext, outcomeName);
  const text = terminal.stopText(actionIdentity, outcomeName, resolution);
  const spent = traversal.spent.length ? `${text.replace(/\.$/, '')}${bounds.spentText(traversal)}.` : text;
  return {
    next: traversal.next,
    stop: stopOf(state, ran),
    reason: terminal.terminalReason(actionIdentity, resolution.outcome, resolution, spent),
    taken: { outcome: outcomeName, rule: resolution.rule, traversal },
  };
}

// The stop a Terminal saves for an Action that stopped the Visit.
function stopOf(state: RunningVisit, { actionIdentity, resolution }: Ran): terminalReport.StopDeclaration {
  const stop: terminalReport.StopDeclaration = {
    outcome: resolution.outcome,
    response: state.response,
    actionRef: actionIdentity,
  };
  // A Check's reason can quote agent-reported test names, so it is posted fenced, never in the reason text; a Check
  // with no reason of its own (a failing command) posts its output.
  const detail =
    resolution.signal && resolution.rule.table === 'failed' ? (resolution.reason ?? resolution.output) : null;
  if (detail) stop.detail = detail;
  // A stop token's `stopped` table decided, and the token may name the template its comment renders.
  if (resolution.rule.table === 'stopped') {
    stop.stopped = true;
    stop.commentTemplate = (visitScope.tokenOf(state) as { comment?: string } | undefined)?.comment;
  }
  if (resolution.outcome === 'run-stop') stop.failureClass = resolution.failureClass;
  return stop;
}

// A failed or stopped write Vertex whose effective target is a Vertex (R5a, U5): its work moves to a Rescue Ref and the
// worktree back to the Visit's baseline, and the ref is the Vertex's `rescue` output (W3), saved with the next Vertex's
// entry. A Visit with no baseline ran no agent, and a read-only one wrote nothing. Before the traversal counts, so a
// crash here routes the same way again.
async function rescueRouted(runContext: RunContext, state: RunningVisit, { actionIdentity, resolution }: Ran) {
  const executionRecord = runContext.record;
  const baseline = state.firstAttemptBaseline;
  const { access, testPaths } = executionRecord.configurationSnapshot!;
  if (!baseline || access === 'read-only' || !bounds.routesToVertex(runContext, resolution.outcome)) return;
  const rescued = await rescue.rescueAndReset(runContext, {
    actionIdentity: { ...actionIdentity, attempt: resolution.attempt ?? 1 },
    baseline,
    failure: `${terminal.actionText(actionIdentity)} at ${actionIdentity.vertex} ended with ${resolution.outcome}`,
  });
  if (!rescued) return;
  const files = await attempt.whileBusy(runContext, () =>
    runContext.git.diffStats(executionRecord.worktree, baseline.head, rescued.commit),
  );
  visitScope.recordOutput(
    executionRecord,
    { ...actionIdentity, action: 'rescue' },
    {
      ref: rescued.ref,
      diffStat: events.diffStats(files, testPaths),
      output: resolution.output ?? resolution.reason ?? '',
    },
  );
}

// The Visit's Outcome (Q3d): its required Checks passed, so the first `passed` row that matches, else `otherwise`, else
// the Claim token; a Check counts only on the current tree.
async function completeVisit(runContext: RunContext, { actionIdentity }: Ran, state: RunningVisit): Promise<VisitEnd> {
  const { vertex, visit: visitNumber, procedure } = actionIdentity;
  const signals = [...state.checks.values()];
  const checked =
    state.proc.passed.length && signals.some((signal) => signal.tree)
      ? await attempt.whileBusy(runContext, () => visitScope.fresh(runContext, signals))
      : signals;
  const { claim, signal } = state.call ?? visitScope.IMPLICIT_OK;
  const { outcome: outcomeName, rule } = outcome.decide({
    result: signal,
    claim,
    checks: visitScope.resolverChecks([], checked),
    retries: {},
    token: visitScope.tokenOf(state),
    procedure: state.proc,
    scope: visitScope.scopeOf(runContext.record, actionIdentity, state, checked),
  });
  const traversal = bounds.traverse(runContext, outcomeName);
  const passed = checked.filter((check) => check.state === 'passed').map((check) => check.id);
  const done = `${vertex} visit ${visitNumber} completed every ${procedure} Action`;
  const text =
    outcomeName !== 'ok'
      ? `${done} with outcome ${outcomeName}${bounds.spentText(traversal)}.`
      : `${done}${passed.length ? `: ${passed.join(' and ')} passed` : ''}${bounds.spentText(traversal)}.`;
  return {
    next: traversal.next,
    stop: null,
    reason: terminal.terminalReason(actionIdentity, outcomeName, { rule }, text),
    taken: { outcome: outcomeName, rule, traversal },
  };
}

// An Integrity Violation leaves nothing behind and tells the next Brief why. Rollback is limited to what this Visit's
// agent made (request 3.5), and passes what git clean leaves (integrity.rollbackSet).
function rollBack(runContext: RunContext, state: RunningVisit, { actionIdentity, resolution }: Ran) {
  const { baseline } = state.call!;
  const testPaths = runContext.record.configurationSnapshot!.testPaths;
  return rescue.reset(runContext, {
    actionIdentity: { ...actionIdentity, action: 'reset', attempt: resolution.attempt },
    baseline: baseline.head,
    history: {
      kind: 'integrity violation',
      text:
        `Attempt ${resolution.attempt} of ${terminal.actionText(actionIdentity)} changed ` +
        `${resolution.surfaces!.join(' and ')}; the worktree was restored to its baseline head.`,
    },
    untracked: integrity.rollbackSet(baseline, runContext.protectedPaths, checks.testPathSet(testPaths)),
  });
}
