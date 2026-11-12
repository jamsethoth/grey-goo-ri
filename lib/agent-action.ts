// The agent Action: its Attempts, each with its Brief and Session, a call to the pinned Agent's Harness (agent-call),
// and the result the Transition Table makes of its Signals.
import { existsSync } from 'node:fs';
import * as agentCall from './agent-call.ts';
import * as bounds from './bounds.ts';
import * as briefs from './briefs.ts';
import * as cleanupHold from './cleanup-hold.ts';
import type * as commandCleanup from './command-cleanup.ts';
import * as config from './config.ts';
import * as sideEffect from './effects/side-effect.ts';
import type * as integrity from './integrity.ts';
import type * as jsonValue from './json-value.ts';
import * as marker from './marker.ts';
import type * as outcome from './outcome.ts';
import * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import * as render from './render.ts';
import type { Harness, HarnessResult, RunContext } from './run-context.ts';
import * as terminal from './terminal.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type ActionResolution = visitScope.ActionResolution;
type Agent = NonNullable<visit.ConfigurationSnapshot['agent']>;
type Persona = NonNullable<visit.ConfigurationSnapshot['persona']>;
type Attempt = agentCall.Attempt;

// An agent Action's Session, which its recovery passes and retries resume.
const sessionKey = (actionIdentity: { vertex: string; visit: number; action: string }) =>
  `${actionIdentity.vertex}/${actionIdentity.visit}/${actionIdentity.action}`;
// A Session cannot be resumed without its transcript.
const resumable = (session: record.SessionEntry) => !!(session.transcriptPath && existsSync(session.transcriptPath));

// Attempt retries (parse, timeout, transient) stay inside the Action: each is a new attempt of the same (action,
// recovery). A resumed Action continues at the Attempt its cursor names, after the saved result of the one before.
export async function agent(runContext: RunContext, running: visitScope.Running): Promise<ActionResolution> {
  const { actionIdentity } = running;
  // The Harness is the Action's for all its Attempts, and each Attempt's own for its whole call.
  const harness = runContext.harnessOf()!;
  let resume = firstResume(runContext, running);
  let nudge = null;
  for (let attempt = runContext.record.cursor.attempt; ; attempt++) {
    if (attempt > 1) {
      const previous = previousAttempt(runContext, actionIdentity, attempt, resume);
      if (harness.capabilities.sessionResume?.supported) resume = previous.sessionId as string | null;
      nudge = previous.row === 'parse-retry' ? (previous.reason as string | null) : null;
      const stopped = terminal.runStopped(runContext);
      if (stopped) return stopped;
      await runContext.enter({ ...actionIdentity, attempt });
      const over = bounds.capped(runContext);
      if (over) return over;
    }
    const resolution = await callAttempt(runContext, {
      ...running,
      actionIdentity: { ...actionIdentity, attempt },
      resume,
      nudge,
    });
    if (resolution.direction !== 'retry') return resolution;
    if (resolution.retryAfterMs) await runContext.clock.sleep(resolution.retryAfterMs);
  }
}

// A recovery pass resumes its agent Action's own Session, or without its transcript starts fresh with the Brief.
function firstResume(runContext: RunContext, { actionIdentity, action }: visitScope.Running): string | null {
  const executionRecord = runContext.record;
  const parent = actionIdentity.recovery ? executionRecord.sessions[sessionKey(actionIdentity)] : null;
  if (parent && !resumable(parent)) {
    runContext.log(
      `#${executionRecord.ticket} ${marker.actionKeyOf(actionIdentity)}: the ${action.id} transcript is missing, so ` +
        `recovery ${actionIdentity.recovery} starts a fresh Session`,
    );
    return null;
  }
  return parent?.sessionId ?? null;
}

// The saved result of the Attempt before. A record saved before Attempts were write-ahead has none: its Session resumes
// with the full Brief, or starts fresh without its transcript, and record.retries already holds its spent budget.
function previousAttempt(
  runContext: RunContext,
  actionIdentity: visitScope.Running['actionIdentity'],
  attempt: number,
  resume: string | null,
): Record<string, unknown> {
  const executionRecord = runContext.record;
  const saved = executionRecord.sessions[sessionKey(actionIdentity)];
  const previousMarker = runContext.markerOf({ ...actionIdentity, attempt: attempt - 1 });
  const evidence = writeAhead.findEntry(executionRecord, previousMarker, 'evidence')?.evidence;
  if (evidence) return evidence as Record<string, unknown>;
  if (!saved) return { sessionId: resume };
  return { sessionId: resumable(saved) ? saved.sessionId : null };
}

// A recovery Brief's sections: each Check that failed in the pass before, with its output and how it failed (T4b). A
// Check with no recoverBrief gets gg's own section.
const sectionsOf = (runContext: RunContext, state: visitScope.RunningVisit): briefs.BriefSection[] =>
  state.proc.actions
    .filter((action) => action.do === 'check' && state.checks.get(action.id)?.state === 'failed')
    .map((action) => ({
      text: action.recoverBrief
        ? config.namedFile(runContext.files, action.recoverBrief)
        : render.engineTemplate('recover-section.md'),
      id: action.id,
      kind: action.kind,
      command: runContext.record.configurationSnapshot!.commands[action.command as string],
      ...state.runs.get(action.id),
    }));
// A recovery pass gets the recovery Brief with a section for each Check that failed in the pass before it (T4b); a
// parse retry gets gg's own nudge.
async function briefOf(runContext: RunContext, attempt: Attempt, commands: Record<string, unknown>): Promise<string> {
  const { record: executionRecord, ticket, base, git } = runContext;
  const { actionIdentity, action, state, nudge } = attempt;
  const recovering = actionIdentity.recovery > 0 && !nudge;
  const sections = recovering ? sectionsOf(runContext, state) : undefined;
  const name = (recovering ? state.proc.recover!.brief : action.brief) as string;
  const renderBrief = (recovering ? briefs.recoveryBrief : briefs.brief) as typeof briefs.recoveryBrief;
  return renderBrief(nudge ? render.engineTemplate('nudge.md') : config.namedFile(runContext.files, name), {
    ...visitScope.scopeOf(executionRecord, actionIdentity, state),
    ticket,
    baseBranch: base,
    commands: commands as Record<string, string>,
    history: executionRecord.history,
    sections: sections!,
    reason: nudge,
    // The branch diff and every test file changed since the Execution's first test commit, including a fix's named
    // ones, read git only for a Brief that names them.
    diff: () => sideEffect.whileBusy(runContext, () => git.branchDiff(executionRecord.worktree, base!)),
    // A red Visit that needed no test committed none (N6), so no test file changed since.
    changedTestFiles: async () => {
      const first = executionRecord.testCommits.first;
      if (first == null) return [];
      const { changed } = await sideEffect.whileBusy(runContext, () =>
        runContext.testImmutability(executionRecord.worktree, first, executionRecord.configurationSnapshot!.testPaths),
      );
      return changed;
    },
  });
}

// One Attempt. A completed one is never run again: runVisit routes every saved result but a retry's, which ends here.
async function callAttempt(runContext: RunContext, attempt: Attempt): Promise<ActionResolution> {
  const executionRecord = runContext.record;
  const { actionIdentity } = attempt;
  const actionMarker = runContext.markerOf(actionIdentity);
  if (writeAhead.findEntry(executionRecord, actionMarker, 'complete'))
    return writeAhead.findEntry(executionRecord, actionMarker, 'evidence')!.evidence as unknown as ActionResolution;
  const harness = runContext.harnessOf()!;
  // Each call gets its own copy: a Harness that edits its call must not change the next one.
  const pinned = structuredClone(executionRecord.configurationSnapshot!);
  const brief = await briefOf(runContext, attempt, pinned.commands);
  const call = callOf(runContext, attempt, { pinned, brief, actionMarker, harness });
  const startedAt = runContext.clock.now();
  const called = await sideEffect.whileBusy(runContext, () =>
    agentCall.guardedCall(runContext, attempt, call, harness),
  );
  // The marker, Agent and Persona stay the Attempt's own: a Harness that edits its call cannot change what is saved.
  const own = { actionMarker, agent: pinned.agent as Agent, persona: pinned.persona as Persona };
  saveSession(executionRecord, actionIdentity, called.result, own);
  return settleAttempt(runContext, attempt, { call, own, called, startedAt });
}

// `access` is the Vertex's, which the validator resolved (H9): read-only unless its Agent allows more and its
// Procedure does not cap it. The Phase is the agent Action's id, and a recovery pass's call is the Phase recover.
function callOf(
  runContext: RunContext,
  { actionIdentity, action, resume }: Attempt,
  { pinned, brief, actionMarker, harness }: CallParts,
) {
  const agentPinned = pinned.agent as Agent;
  const schema = JSON.parse(config.namedFile(runContext.files, action.schema)) as referencePaths.SchemaNode;
  return {
    marker: actionMarker,
    vertex: actionIdentity.vertex,
    visit: actionIdentity.visit,
    phase: actionIdentity.recovery ? 'recover' : action.id,
    attempt: actionIdentity.attempt,
    agent: agentPinned,
    persona: pinned.persona as Persona,
    brief,
    schema,
    cwd: runContext.record.worktree,
    resume,
    access: pinned.access,
    network: agentPinned.network,
    tools: harness.resolveTools(agentPinned),
    timeouts: agentPinned.timeouts ?? {},
    env: {},
  };
}
type CallParts = { pinned: visit.ConfigurationSnapshot; brief: string; actionMarker: string; harness: Harness };
type SentCall = ReturnType<typeof callOf>;
type Own = { actionMarker: string; agent: Agent; persona: Persona };

function saveSession(
  executionRecord: record.ExecutionRecord,
  actionIdentity: visitScope.Running['actionIdentity'],
  result: HarnessResult,
  { agent: pinned, persona }: Own,
) {
  executionRecord.sessions[sessionKey(actionIdentity)] = {
    sessionId: result.sessionId,
    harness: pinned.harness,
    personaHash: persona.hash,
    transcriptPath: result.transcriptPath,
    cumulativeUsage: result.usage.cumulative,
    vertex: actionIdentity.vertex,
    model: pinned.model,
    effort: pinned.effort,
    personaName: persona.name,
  };
}

// The Transition Table reads a call's three Signals as one flat result. A retry spends its budget in the Attempt's
// completion, so a resume never spends it twice. A violation always stops (its row is first); runVisit rolls it back.
function settleAttempt(
  runContext: RunContext,
  { actionIdentity, action, state }: Attempt,
  { call, own, called, startedAt }: { call: SentCall; own: Own; called: agentCall.Called; startedAt: number },
): Promise<ActionResolution> {
  const executionRecord = runContext.record;
  const { response, result, failure, violations, baseline } = called;
  const claim = briefs.validateResponse(call.schema, response);
  if (claim.valid) visitScope.recordOutput(executionRecord, actionIdentity, { response });
  visitScope.recordOutput(executionRecord, actionIdentity, { cleanup: result.cleanup });
  state.call = {
    harnessResult: result,
    claim,
    response,
    baseline,
    signal: { status: result.status, response, failure },
  };
  state.response = response;
  const { done, resolution, integrityRows } = decideCall(runContext, { actionIdentity, state }, violations);
  return sideEffect.saveResolution(runContext, {
    actionIdentity,
    startedAt,
    resolution: done,
    fields: {
      ...agentFields(own, call.tools),
      // A recovery pass's Session descends from its agent Action's.
      ...harnessFields(result, actionIdentity.recovery ? action.id : null),
      ...decisionFields(resolution, { result, claim, integrityRows }),
    },
    actionMarker: own.actionMarker,
    evidence: { ...done, usageDelta: result.usage.delta },
  });
}

// The Transition Table's result for the Visit's saved call and these violations, with the retry it spends.
function decideCall(
  runContext: RunContext,
  { actionIdentity, state }: Pick<Attempt, 'actionIdentity' | 'state'>,
  violations: integrity.IntegrityViolation[],
) {
  const executionRecord = runContext.record;
  const { claim, signal, harnessResult } = state.call!;
  const integrityRows = [{ name: 'integrity', passed: violations.length === 0, violations }];
  const key = marker.actionKeyOf(actionIdentity);
  const resolution = visitScope.settle(executionRecord, actionIdentity, state, {
    result: signal,
    claim,
    checks: visitScope.resolverChecks(integrityRows, []),
    retries: executionRecord.retries[key] ?? {},
    cleanup: harnessResult.cleanup,
  });
  if (resolution.retryKind)
    (executionRecord.retries[key] ??= {})[resolution.retryKind] =
      (executionRecord.retries[key][resolution.retryKind] ?? 0) + 1;
  const surfaces = violations.length ? [...new Set(violations.map((violation) => violation.surface))] : null;
  const done = {
    ...resolution,
    sessionId: harnessResult.sessionId,
    reason: claim.reason ?? null,
    surfaces,
    attempt: actionIdentity.attempt,
  };
  return { done, resolution, integrityRows };
}

// A call held for cleanup, its processes now confirmed gone (J4): its validation, then its response's and the
// resolver's rows, a retry spent once, in one write. The usage it spent stays on its first Event. A retry leaves the
// next Attempt to agent(): null sends it there, past this completed Attempt, whose evidence now says to retry.
export async function completeHeld(
  runContext: RunContext,
  { actionIdentity, action, state }: visitScope.Running,
): Promise<ActionResolution | null> {
  const executionRecord = runContext.record;
  const identity = { ...actionIdentity, attempt: executionRecord.cursor.attempt };
  const startedAt = runContext.clock.now();
  const held = state.call!;
  await sideEffect.whileBusy(runContext, () =>
    agentCall.validateHeld(runContext, { actionIdentity: identity, action, state }, held),
  );
  const cleanup = cleanupHold.confirmedReport(held.harnessResult.cleanup as commandCleanup.CleanupReport);
  held.harnessResult.cleanup = cleanup;
  visitScope.recordOutput(executionRecord, actionIdentity, { cleanup });
  const { done, resolution, integrityRows } = decideCall(runContext, { actionIdentity: identity, state }, []);
  await sideEffect.replaceResolution(runContext, {
    actionIdentity: identity,
    startedAt,
    resolution: done,
    fields: {
      cleanup,
      ...decisionFields(resolution, {
        result: held.harnessResult,
        claim: held.claim,
        integrityRows,
      }),
    },
    actionMarker: runContext.markerOf(identity),
  });
  return done.retryKind ? null : done;
}

// The Action Event's agent fields: the Agent the call ran as and the tools its Harness resolved.
const agentFields = ({ agent: pinned, persona }: Own, tools: jsonValue.JsonValue) => ({
  agent: true,
  harness: pinned.harness,
  agentCliVersion: null,
  model: pinned.model,
  effort: pinned.effort,
  personaHash: persona.hash,
  tools,
});

// What the Harness reported of the call's Session and process.
const harnessFields = (result: HarnessResult, sessionLineage: string | null) => ({
  sessionInit: result.sessionInit,
  sessionId: result.sessionId,
  sessionLineage,
  transcriptPath: result.transcriptPath,
  usage: result.usage,
  exitCode: result.exitCode,
  exitSignal: result.exitSignal,
  finalEventSubtype: result.finalEventSubtype,
  permissionDenials: result.permissionDenials,
  commandsRun: result.commandsRun,
  cleanup: result.cleanup,
});

// How the Transition Table decided, and the Signals it read: the Harness Result, the Claim and the Integrity Assertion.
const decisionFields = (
  resolution: visit.TableResolution,
  { result, claim, integrityRows }: { result: HarnessResult; claim: visit.ClaimSignal; integrityRows: IntegrityRow[] },
) => ({
  failureClass: resolution.failureClass,
  outcome: resolution.outcome,
  direction: resolution.direction,
  rule: resolution.rule,
  signals: {
    harnessResult: { status: result.status, failureClass: resolution.failureClass },
    claim,
    checks: [],
    integrity: integrityRows,
  },
  integrityViolations: integrityRows[0].violations.length ? integrityRows[0].violations : null,
});
type IntegrityRow = { name: string; passed: boolean; violations: integrity.IntegrityViolation[] };
