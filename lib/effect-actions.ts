// The deterministic Actions, each the write-ahead side effect of its Effect (lib/effects/): commit and push in git,
// and comment, pr-upsert and pr-ready on GitHub.
import * as checks from './checks.ts';
import * as config from './config.ts';
import * as comment from './effects/comment.ts';
import * as commit from './effects/commit.ts';
import * as prReady from './effects/pr-ready.ts';
import * as prUpsert from './effects/pr-upsert.ts';
import * as push from './effects/push.ts';
import * as sideEffect from './effects/side-effect.ts';
import * as outcome from './outcome.ts';
import type * as procedures from './procedures.ts';
import * as render from './render.ts';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type Running = visitScope.Running;
// The agent call's Signals as the commit read them, before it looked at the tree.
type CallRead = { result: visit.AgentCall['harnessResult']; claim: visit.ClaimSignal; signal: visit.CallSignal };
// A commit made, with the paths it changed, or the required Checks that no longer hold on the tree it would commit.
type Committed = { sha: string | null; files: string[]; stale?: undefined } | { stale: visit.CheckSignal[] };

// A commit intended before a restart is replayed from its recorded tree and parent, never from what is staged now, so
// a human edit made since stays in the worktree uncommitted. Reconciliation has held a moved branch. A commit counts
// only the required Checks that passed on the tree it would commit (R1b, S2).
async function makeCommit(
  runContext: RunContext,
  state: visitScope.RunningVisit,
  actionMarker: string,
  message: string,
) {
  const { record: executionRecord, git } = runContext;
  const worktree = executionRecord.worktree;
  const intended = writeAhead.findEntry(executionRecord, actionMarker, 'intent')?.payload as commit.Payload | undefined;
  const requires = visitScope.tokenOf(state).requires!.map((id) => visitScope.checkSignal(state, id));
  const stale = intended
    ? []
    : (await visitScope.fresh(runContext, requires)).filter((check) => check.state !== 'passed');
  if (stale.length) return { stale };
  if (!intended) await git.stageAll(worktree);
  const payload = intended ?? { message, tree: await git.writeTree(worktree), parent: await git.headSha(worktree) };
  const { sha } = (await sideEffect.sideEffect(runContext, {
    actionMarker,
    effect: commit.effect,
    payload,
    deferred: true,
  })) as { sha: string | null };
  // The paths the commit changed (U2, K7); with nothing to commit it is a no-op with no path.
  return { sha, files: sha ? await git.changedPaths(worktree, payload.parent, sha) : [] };
}

// Nothing was committed: a required Check passed on a tree that is no longer the worktree's. The agent call is the one
// the commit read before it looked.
function refuseStale(
  runContext: RunContext,
  { actionIdentity, state }: Running,
  { stale, startedAt, call }: { stale: visit.CheckSignal[]; startedAt: number; call: CallRead },
) {
  const { result, claim, signal } = call;
  const [first] = stale;
  const resolution = outcome.decide({
    result: signal,
    claim,
    checks: visitScope.resolverChecks([], stale),
    retries: {},
    token: visitScope.tokenOf(state),
    procedure: state.proc,
    scope: visitScope.scopeOf(
      runContext.record,
      actionIdentity,
      state,
      new Map([...state.checks, ...stale.map((check) => [check.id, check] as const)]),
    ),
  });
  return sideEffect.saveResolution(runContext, {
    actionIdentity,
    startedAt,
    resolution: {
      ...resolution,
      reason:
        `The ${first.kind} Check ${first.id} passed on tree ${first.tree}, which is no longer the worktree's, so ` +
        'nothing was committed.',
      signal: first,
    },
    fields: {
      check: first.id,
      signals: { harnessResult: { status: result.status }, claim, checks: stale, integrity: [] },
    },
  });
}

// The outputs are recorded with the commit's completion and Event, outside whileBusy so its idle save cannot publish
// them first. R3c: every gg commit is the new Test Immutability baseline, since each passed it or wrote tests. R3d: the
// first test commit is the first that changed a path under testPaths. A commit with nothing to commit moves neither.
async function commitAction(runContext: RunContext, running: Running) {
  const { record: executionRecord, ticket } = runContext;
  const { actionIdentity, action, state } = running;
  const { agent } = executionRecord.configurationSnapshot!;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const { harnessResult: result, claim, signal, response } = state.call!;
  const message = render.commitMessage(
    {
      kind: action.type,
      title: ticket!.title,
      ticket: ticket!.number,
      summary: (response as { summary?: unknown }).summary,
      vertex: actionIdentity.vertex,
      harness: agent!.harness,
      model: agent!.model,
      effort: agent!.effort,
      marker: actionMarker,
    },
    runContext.publicText,
  );
  const committed: Committed = await sideEffect.whileBusy(runContext, () =>
    makeCommit(runContext, state, actionMarker, message),
  );
  if (committed.stale)
    return refuseStale(runContext, running, { stale: committed.stale, startedAt, call: { result, claim, signal } });
  const { sha, files } = committed;
  visitScope.recordOutput(executionRecord, actionIdentity, { files });
  if (sha) executionRecord.testCommits.baseline = sha;
  if (sha && files.some(checks.testPathMatcher(executionRecord.configurationSnapshot!.testPaths)))
    executionRecord.testCommits.first ??= sha;
  return sideEffect.completeEffect(runContext, actionIdentity, startedAt, actionMarker);
}

// The commit the record proves was checked, not HEAD: a branch changed by hand is never published.
async function pushAction(runContext: RunContext, { actionIdentity }: Running) {
  const { record: executionRecord, git } = runContext;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  await sideEffect.whileBusy(runContext, async () => {
    const sha = commit.lastCommit(executionRecord)?.sha ?? (await git.headSha(executionRecord.worktree));
    await sideEffect.sideEffect(runContext, {
      actionMarker,
      effect: push.effect,
      payload: { branch: executionRecord.branch, sha },
      deferred: true,
    });
  });
  return sideEffect.completeEffect(runContext, actionIdentity, startedAt, actionMarker);
}

// `target: ticket` comments on the Ticket; the review's comment goes to the PR (W5). A Procedure with no agent Action
// has no Agent to name.
async function postComment(runContext: RunContext, { actionIdentity, action, state }: Running) {
  const { record: executionRecord } = runContext;
  const { agent, persona } = executionRecord.configurationSnapshot!;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const body = await render.publicBody(
    config.namedFile(runContext.files, action.body),
    {
      ...visitScope.scopeOf(executionRecord, actionIdentity, state),
      ...(agent && {
        agent: {
          harness: agent.harness,
          model: agent.model,
          effort: agent.effort,
          persona: persona!.name,
          personaHash: persona!.hash.slice(0, 12),
        },
      }),
    },
    actionMarker,
    runContext.publicText,
  );
  const target =
    action.target === 'ticket'
      ? { kind: 'issue', number: executionRecord.ticket }
      : { kind: 'pr', number: executionRecord.pr! };
  await sideEffect.whileBusy(runContext, () =>
    sideEffect.sideEffect(runContext, {
      actionMarker,
      effect: comment.effect,
      payload: { target, body, bodyHash: config.sha256(body) },
      deferred: true,
    }),
  );
  return sideEffect.completeEffect(runContext, actionIdentity, startedAt, actionMarker);
}

// Creates the PR after implement, and re-renders its body after a fix or review with a provenance row per Vertex. A
// `with` name shadows the scope's own (implement's `green` is its agent Action's output).
async function upsertPr(runContext: RunContext, running: Running) {
  const { record: executionRecord, ticket } = runContext;
  const { actionIdentity, action, state } = running;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const body = await render.publicBody(
    config.namedFile(runContext.files, action.body),
    {
      ...visitScope.scopeOf(executionRecord, actionIdentity, state),
      ...visitScope.bind(executionRecord, running),
      ticket,
      provenance: () => render.provenance(executionRecord),
    },
    actionMarker,
    runContext.publicText,
  );
  const payload = {
    branch: executionRecord.branch,
    base: runContext.base,
    title: runContext.publicText(ticket!.title),
    body,
    bodyHash: config.sha256(body),
  };
  await sideEffect.whileBusy(runContext, () =>
    sideEffect.sideEffect(runContext, { actionMarker, effect: prUpsert.effect, payload, deferred: true }),
  );
  return sideEffect.completeEffect(runContext, actionIdentity, startedAt, actionMarker);
}

// A publishing Action (R11d, T1a): it marks ready only the last commit the record proves pushed, and only if every
// worktree Check the claimed token requires passed on that commit's tree. The target is saved in the intent, so a retry
// or a resume publishes the same commit, and each launch checks it again, with the PR's head (M1).
async function markReady(runContext: RunContext, { actionIdentity, state }: Running) {
  const { record: executionRecord } = runContext;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const checked = visitScope
    .tokenOf(state)
    .requires!.map((id) => state.checks.get(id))
    .filter((check): check is visit.CheckSignal => !!check?.tree);
  const [first] = checked;
  const tree =
    first && checked.every((check) => check.state === 'passed' && check.tree === first.tree) ? first.tree : null;
  const lastSha = commit.lastCommit(executionRecord)?.sha ?? null;
  const target = { number: executionRecord.pr!, sha: lastSha, tree };
  await sideEffect.whileBusy(runContext, () =>
    sideEffect.sideEffect(runContext, { actionMarker, effect: prReady.effect, payload: target, deferred: true }),
  );
  return sideEffect.completeEffect(runContext, actionIdentity, startedAt, actionMarker);
}

// The deterministic Action kinds by their `do`.
export const EFFECT_KINDS: Record<
  Exclude<procedures.ActionKind, 'agent' | 'check' | 'await-approval'>,
  (runContext: RunContext, running: Running) => Promise<visitScope.ActionResolution>
> = { commit: commitAction, push: pushAction, comment: postComment, 'pr-upsert': upsertPr, 'pr-ready': markReady };
