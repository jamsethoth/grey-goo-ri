// The agent Action: its Attempts, each with its Brief and Session, a call to the pinned Agent's Harness (agent-call),
// and the result the Transition Table makes of its Signals.
import { existsSync } from 'node:fs';
import * as agentCall from './agent-call.ts';
import * as agentHandoff from './agent-handoff.ts';
import * as attempt from './attempt.ts';
import * as bounds from './bounds.ts';
import * as briefs from './briefs.ts';
import * as cleanupHold from './cleanup-hold.ts';
import type * as commandCleanup from './command-cleanup.ts';
import * as config from './config.ts';
import type * as integrity from './integrity.ts';
import * as jsonValue from './json-value.ts';
import * as marker from './marker.ts';
import * as paths from './paths.ts';
import type * as outcome from './outcome.ts';
import * as record from './record.ts';
import * as render from './render.ts';
import type { Harness, HarnessResult, RunContext } from './run-context.ts';
import * as terminal from './terminal.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type ActionResolution = visitScope.ActionResolution;
type Agent = NonNullable<visit.ConfigurationSnapshot['agent']>;
type Persona = NonNullable<visit.ConfigurationSnapshot['persona']>;
type Attempt = agentCall.Attempt & { handoff?: agentHandoff.Handoff | null };

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
  let handoff = null;
  for (let attempt = runContext.record.cursor.attempt; ; attempt++) {
    if (attempt > 1) {
      const previous = previousAttempt(runContext, actionIdentity, attempt, resume);
      handoff = agentHandoff.handoffOf(runContext.record, actionIdentity, previous);
      if (harness.capabilities.sessionResume?.supported) resume = handoff ? null : (previous.sessionId ?? null);
      nudge = previous.row === 'parse-retry' ? (previous.reason ?? null) : null;
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
      handoff,
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
  attemptNumber: number,
  resume: string | null,
): { sessionId?: string | null; row?: visit.Resolution['row']; reason?: string | null } {
  const executionRecord = runContext.record;
  const saved = executionRecord.sessions[sessionKey(actionIdentity)];
  const previousMarker = runContext.markerOf({ ...actionIdentity, attempt: attemptNumber - 1 });
  const evidence = writeAhead.findEntry(executionRecord, previousMarker, 'evidence')?.evidence;
  if (evidence?.usageDelta !== undefined) return evidence;
  // An Interrupted Attempt, completed by its recovery with nothing found: its retry starts a fresh Session (ADR 0011).
  if (attempt.complete(runContext, { ...actionIdentity, attempt: attemptNumber - 1 })) return { sessionId: null };
  if (!saved) return { sessionId: resume };
  return { sessionId: resumable(saved) ? saved.sessionId : null };
}

// A recovery Brief's sections: each Check that failed in the pass before, with its output and how it failed (T4b). A
// Check with no recoverBrief gets gg's own section.
const sectionsOf = (runContext: RunContext, state: visitScope.RunningVisit): briefs.BriefSection[] =>
  state.procedure.actions
    .filter((action) => action.do === 'check' && state.checks.get(action.id)?.state === 'failed')
    .map((action) => ({
      text: action.recoverBrief
        ? config.namedFile(runContext.record.configurationSnapshot!.files, action.recoverBrief)
        : render.engineTemplate('recover-section.md'),
      id: action.id,
      kind: action.kind,
      command: runContext.record.configurationSnapshot!.commands[action.command as string],
      ...state.runs.get(action.id),
    }));
// A recovery pass gets the recovery Brief with a section for each Check that failed in the pass before it (T4b); a
// parse retry gets gg's own nudge; the Attempt after a hand-off gets its Brief and gg's hand-off section (#430).
async function briefOf(runContext: RunContext, briefed: Attempt, commands: Record<string, unknown>): Promise<string> {
  const { record: executionRecord, ticket, base, git } = runContext;
  const { actionIdentity, action, state, nudge, handoff } = briefed;
  const recovering = actionIdentity.recovery > 0 && !nudge;
  const sections = recovering ? sectionsOf(runContext, state) : undefined;
  const name = (recovering ? state.procedure.recover!.brief : action.brief) as string;
  const renderBrief = (recovering ? briefs.recoveryBrief : briefs.brief) as typeof briefs.recoveryBrief;
  const files = executionRecord.configurationSnapshot!.files;
  const text = await renderBrief(nudge ? render.engineTemplate('nudge.md') : config.namedFile(files, name), {
    ...visitScope.scopeOf(executionRecord, actionIdentity, state),
    ticket,
    baseBranch: base,
    commands: commands as Record<string, string>,
    history: executionRecord.history,
    sections: sections!,
    reason: nudge,
    // The branch diff and every test file changed since the Execution's first test commit, including a fix's named
    // ones, read git only for a Brief that names them.
    diff: () => attempt.whileBusy(runContext, () => git.branchDiff(executionRecord.worktree, base!)),
    // A red Visit that needed no test committed none (N6), so no test file changed since.
    changedTestFiles: async () => {
      const first = executionRecord.testCommits.first;
      if (first == null) return [];
      const { changed } = await attempt.whileBusy(runContext, () =>
        runContext.testImmutability(executionRecord.worktree, first, executionRecord.configurationSnapshot!.testPaths),
      );
      return changed;
    },
  });
  return agentHandoff.withSection(text, handoff);
}

// One Attempt. A completed one is never run again: runVisit routes every saved result but a retry's, which ends here.
// The Brief is made before the Attempt starts; the call, with its response's validation, runs busy.
function callAttempt(runContext: RunContext, running: Attempt): Promise<ActionResolution> {
  const executionRecord = runContext.record;
  const { actionIdentity, action } = running;
  const harness = runContext.harnessOf()!;
  return attempt.run(runContext, {
    actionIdentity,
    busy: true,
    settle: running.settle,
    resumed: (evidence): ActionResolution => {
      if (evidence?.usageDelta !== undefined) return evidence;
      throw new Error(`the completed call ${actionIdentity.action} saved no Resolution`);
    },
    prepare: async (actionMarker): Promise<Prepared> => {
      // Each call gets its own copy: a Harness that edits its call must not change the next one.
      const pinned = structuredClone(executionRecord.configurationSnapshot!);
      const brief = await briefOf(runContext, running, pinned.commands);
      const call = callOf(runContext, running, { pinned, brief, actionMarker, harness });
      // The marker, Agent and Persona stay the Attempt's own: a Harness editing its call cannot change what is saved.
      return { call, own: { actionMarker, agent: pinned.agent as Agent, persona: pinned.persona as Persona } };
    },
    work: async ({ call }) => {
      const called = await agentCall.guardedCall(runContext, running, call, harness);
      return { ...called, claim: briefs.validateResponse(call.schema, called.response) };
    },
    outputs: ({ response, result, claim }) => ({
      outputs: { ...(claim.valid && { response }), cleanup: result.cleanup },
    }),
    finish: (called, { call, own }) => {
      const settled = settleAttempt(runContext, running, { call, own, called });
      saveSession(executionRecord, { ...running, result: called.result, row: settled.resolution.row }, own);
      return settled;
    },
  });
}
type Prepared = { call: SentCall; own: Own };

// `access` is the Vertex's, which the validator resolved (H9): read-only unless its Agent allows more and its
// Procedure does not cap it. The Phase is the agent Action's id, and a recovery pass's call is the Phase recover. A
// resumed call carries its Session's saved total, so the Harness can log this call's share; a fresh one has none.
function callOf(
  runContext: RunContext,
  { actionIdentity, action, resume }: Attempt,
  { pinned, brief, actionMarker, harness }: CallParts,
) {
  const agentPinned = pinned.agent as Agent;
  const session = runContext.record.sessions[sessionKey(actionIdentity)];
  const commands = agentHandoff.askable(session, pinned.commands as Record<string, string>);
  const declared = JSON.parse(config.namedFile(pinned.files, action.schema));
  briefs.assertStrict(declared);
  const schema = agentHandoff.schemaOf(agentPinned, declared);
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
    previousUsage: resume ? (session?.cumulativeUsage ?? null) : null,
    runDirectory: paths.runDirectory(runContext.record.commonDir, runContext.run),
    access: pinned.access,
    network: agentPinned.network,
    // A copy, as the Harness's answer is: the Harness keeps the tools it returns and may change them later.
    tools: structuredClone(harness.resolveTools(agentPinned, { commands, platform: process.platform })),
    timeouts: agentPinned.timeouts ?? {},
    env: {},
  };
}
type CallParts = { pinned: visit.ConfigurationSnapshot; brief: string; actionMarker: string; harness: Harness };
type SentCall = ReturnType<typeof callOf>;
type Own = { actionMarker: string; agent: Agent; persona: Persona };

// A fresh call's Session id is the one saved; a resumed call may report another, which never replaces it (request 3.2).
// Its total is saved either way, so the next resume's previous Usage is this call's.
function saveSession(
  executionRecord: record.ExecutionRecord,
  { actionIdentity, resume, result, row }: Pick<Attempt, 'actionIdentity' | 'resume'> & SessionResult,
  { agent: pinned, persona }: Own,
) {
  const key = sessionKey(actionIdentity);
  const before = executionRecord.sessions[key];
  const stored = resume ? before?.sessionId : undefined;
  executionRecord.sessions[key] = {
    sessionId: stored ?? result.sessionId,
    harness: pinned.harness,
    personaHash: persona.hash,
    transcriptPath: result.transcriptPath,
    cumulativeUsage: result.usage.cumulative,
    vertex: actionIdentity.vertex,
    model: pinned.model,
    effort: pinned.effort,
    personaName: persona.name,
    ...agentHandoff.kept(before, { row, attempt: actionIdentity.attempt! }, result),
  };
}
type SessionResult = { result: HarnessResult; row: visit.Resolution['row'] };

// The Transition Table reads a call's three Signals as one flat result. A retry spends its budget in the Attempt's
// completion, so a resume never spends it twice. A violation always stops (its row is first); runVisit rolls it back.
function settleAttempt(
  runContext: RunContext,
  { actionIdentity, action, state, handoff }: Attempt,
  { call, own, called }: { call: SentCall; own: Own; called: agentCall.Called & { claim: visit.ClaimSignal } },
): attempt.Done<ActionResolution> {
  const { response, result, failure, violations, baseline, claim } = called;
  state.call = {
    harnessResult: result,
    claim,
    response,
    baseline,
    signal: { status: result.status, response, failure },
  };
  state.response = response;
  const { done, resolution, integrityRows } = decideCall(runContext, { actionIdentity, state }, violations);
  return {
    resolution: done,
    fields: {
      ...agentFields(own, call.tools),
      // A fresh Session after a hand-off descends from the handed-off one, a recovery pass's from its agent Action's.
      ...harnessFields(result, handoff?.sessionId ?? (actionIdentity.recovery ? action.id : null)),
      ...decisionFields(resolution, { result, claim, integrityRows }),
    },
    // The evidence keeps its own copy of the Resolution, apart from the one the Visit settles on.
    evidence: structuredClone({ ...done, usageDelta: result.usage.delta }),
  };
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
    policy: executionRecord.configurationSnapshot!.agent!.resolutionPolicy as outcome.Signals['policy'],
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
  { actionIdentity, action, state, settle }: visitScope.Running,
): Promise<ActionResolution | null> {
  const identity = { ...actionIdentity, attempt: runContext.record.cursor.attempt };
  const held = state.call!;
  const done = await attempt.runHeld(runContext, {
    actionIdentity: identity,
    actionMarker: runContext.markerOf(identity),
    settle,
    work: async () => {
      await agentCall.validateHeld(runContext, { actionIdentity: identity, action, state }, held);
      return cleanupHold.confirmedReport(held.harnessResult.cleanup as commandCleanup.CleanupReport);
    },
    outputs: (cleanup) => ({ outputs: { cleanup } }),
    finish: (cleanup) => {
      held.harnessResult.cleanup = cleanup;
      const decided = decideCall(runContext, { actionIdentity: identity, state }, []);
      const session = runContext.record.sessions[sessionKey(identity)]!;
      Object.assign(session, agentHandoff.kept(session, { row: decided.done.row, ...identity }, held.harnessResult));
      return {
        resolution: decided.done,
        fields: {
          cleanup,
          ...decisionFields(decided.resolution, {
            result: held.harnessResult,
            claim: held.claim,
            integrityRows: decided.integrityRows,
          }),
        },
      };
    },
  });
  return done!.retryKind ? null : done;
}

// The Action Event's agent fields: the Agent the call ran as and the tools its Harness resolved.
const agentFields = ({ agent: pinned, persona }: Own, tools: jsonValue.JsonValue) => ({
  agent: true,
  harness: pinned.harness,
  model: pinned.model,
  effort: pinned.effort,
  personaHash: persona.hash,
  tools,
});

// What the Harness reported of the call's Session and process, and of its own run: null where it reported none.
const harnessFields = (result: HarnessResult, sessionLineage: string | null) => ({
  agentCliVersion: result.agentCliVersion ?? null,
  effectiveModel: result.effectiveModel ?? null,
  effectiveEffort: result.effectiveEffort ?? null,
  repositoryDigest: result.repositoryDigest ?? null,
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
