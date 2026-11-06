// One Visit of a Vertex: its entry (the Configuration Snapshot and inputs), its Actions in order with their recovery
// passes, and where it leaves: a stop's Terminal, or the Visit's Outcome through the Edge it takes.
import { basename } from 'node:path';
import * as agentAction from './agent-action.ts';
import * as bounds from './bounds.ts';
import * as checkAction from './check-action.ts';
import * as checks from './checks.ts';
import * as config from './config.ts';
import * as effectActions from './effect-actions.ts';
import * as effects from './effects.ts';
import * as integrity from './integrity.ts';
import * as labels from './labels.ts';
import type * as marker from './marker.ts';
import * as outcome from './outcome.ts';
import type * as procedures from './procedures.ts';
import * as reconcile from './reconcile.ts';
import type * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import type { RunContext } from './run-context.ts';
import * as terminal from './terminal.ts';
import type * as terminalReport from './terminal-report.ts';
import type * as inputs from './validate/inputs.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';

type ActionResolution = visitScope.ActionResolution;
type RunningVisit = visitScope.RunningVisit;

// Where a Visit leaves: the next Vertex or end, the stop a Terminal saves, and the Terminal Reason if it decides one.
export interface VisitEnd {
  next: string;
  stop: terminalReport.StopDeclaration | null;
  reason: record.TerminalReason | null;
}
// The last Action the Visit ran and its result.
interface Ran {
  actionIdentity: marker.ActionIdentity;
  resolution: ActionResolution;
}

// Each Action kind (procedures.ACTION_KEYS) by its `do`; #119 builds await-approval.
type BuiltKind = Exclude<procedures.ActionKind, 'await-approval'>;
const KINDS: Record<BuiltKind, (runContext: RunContext, running: visitScope.Running) => Promise<ActionResolution>> = {
  agent: agentAction.agent,
  check: checkAction.check,
  ...effectActions.EFFECT_KINDS,
};

// Each input at Visit entry (S4, T6): the value from the latest Visit that produced any of its sources, with that
// Vertex, Visit and Action. An optional input none produced is absent (T10); a required one stops the Execution, which
// admission prevents by checking inputs on every route (Q7, H1-H4), so this is a backstop.
function resolveInputs(
  executionRecord: record.ExecutionRecord,
  vertexId: string,
  declared: Record<string, inputs.ResolvedInput> = {},
): Record<string, visit.VertexInput> {
  return Object.fromEntries(
    Object.entries(declared).map(([name, { from, optional, pick }]) => {
      const sources = [from].flat().map((ref) => {
        const [vertex, action, ...path] = referencePaths.parse(ref).steps ?? [];
        return { vertex, action, path: path.join('.') };
      });
      for (const output of executionRecord.outputs.toReversed()) {
        for (const source of sources) {
          const matches = output.vertex === source.vertex && output.action === source.action;
          const value = matches ? referencePaths.read(output.value, source.path) : undefined;
          if (value === undefined) continue;
          const picked =
            pick === undefined ? value : (value as unknown[]).map((item) => referencePaths.read(item, pick));
          return [
            name,
            { value: picked, vertex: output.vertex, visit: output.visit, action: output.action, absent: false },
          ];
        }
      }
      if (!optional)
        throw new Error(`${vertexId}'s input ${name} has no value: no Visit produced ${[from].flat().join(' or ')}`);
      return [name, { value: null, vertex: null, visit: null, action: null, absent: true }];
    }),
  );
}

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
  executionRecord.visits[vertexId] = visitNumber;
  if (resuming) return true;
  const { agent, access, procedure, outcomes, route, inputs: declared } = flow.ticket.vertices[vertexId];
  // The Persona's bytes from the Layer that names it; a Vertex without an Agent (publish) pins none.
  const bytes = agent && config.layerFile(runContext.files, agent.persona);
  executionRecord.configurationSnapshot = structuredClone({
    vertex: vertexId,
    visit: visitNumber,
    agent,
    access,
    procedure: { name: procedure, hash: flow.procedures[procedure].hash },
    outcomes,
    route: route ?? null,
    routes: flow.ticket.routes ?? null,
    inputs: resolveInputs(executionRecord, vertexId, declared),
    commands: runContext.commands!,
    testPaths: runContext.testPaths!,
    persona: agent && { name: basename(agent.persona), bytes: bytes!, hash: config.sha256(bytes!) },
  });
  // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry;
  // log it against the Config Hash when gg run reloads between Vertices (#184).
  await runContext.database.save(executionRecord);
  return false;
}

// A rollback (an Integrity Violation) is safe only when the agent made every change (request 3.5), and any Vertex's
// agent may cause one whatever its access, so every Vertex starts only on a clean worktree or one an open intent
// explains, as at admission (R2d); anything else is Held before any agent runs.
async function heldDirty(runContext: RunContext, vertexId: string): Promise<VisitEnd | null> {
  const executionRecord = runContext.record;
  const dirty = await effects.bracket(runContext, () =>
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
function visitStateOf(executionRecord: record.ExecutionRecord, resuming: boolean, proc: procedures.Procedure) {
  const state = (executionRecord.visitState = resuming
    ? executionRecord.visitState!
    : {
        recovery: 0,
        firstAttemptBaseline: null,
        call: null,
        response: null,
        runs: {},
        checks: {},
        checkFollows: false,
        settled: null,
      });
  // Not enumerable, so the Procedure's data stays out of the saved record.
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  Object.defineProperty(state, 'claimTokens', { value: proc.claimTokens, enumerable: false });
  return state as RunningVisit;
}

export async function runVisit(runContext: RunContext, vertexId: string, visitNumber: number): Promise<VisitEnd> {
  const { flow, record: executionRecord } = runContext;
  const resuming = await enterVisit(runContext, vertexId, visitNumber);
  const proc = flow.procedures[executionRecord.configurationSnapshot!.procedure.name];
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
    const settled =
      state.settled?.action === actionIdentity.action && state.settled.recovery === actionIdentity.recovery
        ? state.settled.resolution
        : null;
    const resolution: ActionResolution =
      settled ??
      terminal.runStopped(runContext) ??
      bounds.capped(runContext) ??
      (await KINDS[action.do as BuiltKind](runContext, { actionIdentity, action, state }));
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
    await runContext.database.save(runContext.record);
  }
  // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4): an
  // agent Attempt's violation, Test Immutability included, rolls back to that Attempt's baseline. The call's own marker
  // is complete, so its rollback is an Action of its own. A failure routed to an end leaves the work in place for the
  // human (U10).
  if (resolution.row === 'integrity-violation') await rollBack(runContext, state, ran);
  const traversal = bounds.traverse(runContext, outcomeName);
  const text = terminal.stopText(actionIdentity, outcomeName, resolution);
  const spent = traversal.spent.length ? `${text.replace(/\.$/, '')}${bounds.spentText(traversal)}.` : text;
  return {
    next: traversal.next,
    stop: stopOf(state, ran),
    reason: terminal.terminalReason(actionIdentity, resolution.outcome, resolution, spent),
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

// The Visit's Outcome (Q3d): its required Checks passed, so the first `passed` row that matches, else `otherwise`, else
// the Claim token; a Check counts only on the current tree.
async function completeVisit(runContext: RunContext, { actionIdentity }: Ran, state: RunningVisit): Promise<VisitEnd> {
  const { vertex, visit: visitNumber, procedure } = actionIdentity;
  const signals = Object.values(state.checks);
  const checked =
    state.proc.passed.length && signals.some((signal) => signal.tree)
      ? await effects.bracket(runContext, () => visitScope.fresh(runContext, signals))
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
  };
}

// An Integrity Violation leaves nothing behind and tells the next Brief why. Rollback is limited to what this Visit's
// agent made (request 3.5), and passes what git clean leaves (integrity.rollbackSet).
function rollBack(runContext: RunContext, state: RunningVisit, { actionIdentity, resolution }: Ran) {
  const { baseline } = state.call!;
  const testPaths = runContext.record.configurationSnapshot!.testPaths;
  return discard(runContext, {
    actionIdentity: { ...actionIdentity, action: 'reset', attempt: resolution.attempt },
    baseline: baseline.head,
    history: {
      kind: 'integrity violation',
      text:
        `Attempt ${resolution.attempt} of ${terminal.whereOf(actionIdentity)} changed ` +
        `${resolution.surfaces!.join(' and ')}; the worktree was restored to its baseline head.`,
    },
    untracked: integrity.rollbackSet(baseline, runContext.protectedPaths, checks.testPathSet(testPaths)),
  });
}

// The History item is saved with the reset's evidence, so Reconciliation adds it exactly once. The intent saves what
// git clean leaves, so a crash after the reset can still finish the restore.
async function discard(
  runContext: RunContext,
  { actionIdentity, ...reset }: { actionIdentity: marker.ActionIdentity } & Omit<visit.ResetPayload, 'left'>,
) {
  const { record: executionRecord, git } = runContext;
  // The worktree as the agent left it: at admission, only dirty state that still matches this is proven the agent's.
  // The ignored Protected Files and tests are in it too: the tree cannot see them, but the restore rewrites them.
  const left = await effects.bracket(runContext, async () => ({
    ...(await runContext.integrity.snapshot(executionRecord.worktree)),
    files: reset.untracked
      ? await runContext.integrity.ignoredFiles(executionRecord.worktree, reset.untracked.within)
      : {},
  }));
  const payload: visit.ResetPayload = {
    ...reset,
    left: { head: left.head, index: left.index, tree: left.tree, files: left.files },
  };
  await effects.bracket(runContext, () =>
    effects.sideEffect(runContext, {
      actionMarker: runContext.markerOf(actionIdentity),
      effect: 'reset',
      payload,
      perform: async () => {
        await git.resetTo(executionRecord.worktree, payload.baseline);
        if (payload.untracked) await runContext.integrity.restoreUntracked(executionRecord.worktree, payload.untracked);
        // HEAD is read first: nothing awaited may sit between the History push and saving the evidence that proves it.
        const head = await git.headSha(executionRecord.worktree);
        executionRecord.history.push(payload.history);
        return { head };
      },
    }),
  );
}
