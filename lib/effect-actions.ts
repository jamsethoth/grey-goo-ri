// The deterministic Actions, each the write-ahead side effect of its Effect (lib/effects/), run as an Attempt
// (lib/attempt.ts): commit and push in git, and comment, pr-upsert and pr-ready on GitHub.
import * as attempt from './attempt.ts';
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
): Promise<Committed> {
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
  stale: visit.CheckSignal[],
): attempt.Done<visitScope.ActionResolution> {
  const { harnessResult: result, claim, signal } = state.call!;
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
  return {
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
  };
}

// R3c: every gg commit is the new Test Immutability baseline, since each passed it or wrote tests. R3d: the first test
// commit is the first that changed a path under testPaths. A commit with nothing to commit moves neither.
function commitAction(runContext: RunContext, running: Running) {
  const { record: executionRecord, ticket } = runContext;
  const { actionIdentity, action, state } = running;
  const { agent } = executionRecord.configurationSnapshot!;
  return attempt.run(runContext, {
    actionIdentity,
    busy: true,
    settle: running.settle,
    prepare: async (actionMarker) =>
      render.commitMessage(
        {
          kind: action.type,
          title: ticket!.title,
          ticket: ticket!.number,
          summary: (state.call!.response as { summary?: unknown }).summary,
          vertex: actionIdentity.vertex,
          harness: agent!.harness,
          model: agent!.model,
          effort: agent!.effort,
          marker: actionMarker,
        },
        runContext.publicText,
      ),
    work: (message, actionMarker) => makeCommit(runContext, state, actionMarker, message),
    outputs: (committed) => (committed.stale ? {} : { outputs: { files: committed.files } }),
    finish: (committed): attempt.Done<visitScope.ActionResolution> => {
      if (committed.stale) return refuseStale(runContext, running, committed.stale);
      const { sha, files } = committed;
      if (sha) executionRecord.testCommits.baseline = sha;
      if (sha && files.some(checks.testPathMatcher(executionRecord.configurationSnapshot!.testPaths)))
        executionRecord.testCommits.first ??= sha;
      return { resolution: attempt.EFFECT_COMPLETED };
    },
  });
}

// The commit the record proves was checked, not HEAD: a branch changed by hand is never published.
function pushAction(runContext: RunContext, { actionIdentity, settle }: Running) {
  const { record: executionRecord, git } = runContext;
  return attempt.effectAction(runContext, {
    actionIdentity,
    settle,
    made: async () => ({
      effect: push.effect,
      payload: {
        branch: executionRecord.branch,
        sha: commit.lastCommit(executionRecord)?.sha ?? (await git.headSha(executionRecord.worktree)),
      },
    }),
  });
}

// `target: ticket` comments on the Ticket; the review's comment goes to the PR (W5). A Procedure with no agent Action
// has no Agent to name.
function postComment(runContext: RunContext, { actionIdentity, action, state, settle }: Running) {
  const { record: executionRecord } = runContext;
  const { agent, persona } = executionRecord.configurationSnapshot!;
  const target =
    action.target === 'ticket'
      ? { kind: 'issue', number: executionRecord.ticket }
      : { kind: 'pr', number: executionRecord.pr! };
  return attempt.effectAction(runContext, {
    actionIdentity,
    settle,
    prepare: (actionMarker) =>
      render.publicBody(
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
      ),
    made: (body) => ({ effect: comment.effect, payload: { target, body, bodyHash: config.sha256(body) } }),
  });
}

// Creates the PR after implement, and re-renders its body after a fix or review with a provenance row per Vertex. A
// `with` name shadows the scope's own (implement's `green` is its agent Action's output).
function upsertPr(runContext: RunContext, running: Running) {
  const { record: executionRecord, ticket } = runContext;
  const { actionIdentity, action, state, settle } = running;
  return attempt.effectAction(runContext, {
    actionIdentity,
    settle,
    prepare: (actionMarker) =>
      render.publicBody(
        config.namedFile(runContext.files, action.body),
        {
          ...visitScope.scopeOf(executionRecord, actionIdentity, state),
          ...visitScope.bind(executionRecord, running),
          ticket,
          provenance: () => render.provenance(executionRecord),
        },
        actionMarker,
        runContext.publicText,
      ),
    made: (body) => ({
      effect: prUpsert.effect,
      payload: {
        branch: executionRecord.branch,
        base: runContext.base,
        title: runContext.publicText(ticket!.title),
        body,
        bodyHash: config.sha256(body),
      },
    }),
  });
}

// A publishing Action (R11d, T1a): it marks ready only the last commit the record proves pushed, and only if every
// worktree Check the claimed token requires passed on that commit's tree. The target is saved in the intent, so a retry
// or a resume publishes the same commit, and each launch checks it again, with the PR's head (M1).
function markReady(runContext: RunContext, { actionIdentity, state, settle }: Running) {
  const { record: executionRecord } = runContext;
  const checked = visitScope
    .tokenOf(state)
    .requires!.map((id) => state.checks.get(id))
    .filter((check): check is visit.CheckSignal => !!check?.tree);
  const [first] = checked;
  const tree =
    first && checked.every((check) => check.state === 'passed' && check.tree === first.tree) ? first.tree : null;
  const lastSha = commit.lastCommit(executionRecord)?.sha ?? null;
  const target = { number: executionRecord.pr!, sha: lastSha, tree };
  return attempt.effectAction(runContext, {
    actionIdentity,
    settle,
    made: () => ({ effect: prReady.effect, payload: target }),
  });
}

// The deterministic Action kinds by their `do`.
export const EFFECT_KINDS: Record<
  Exclude<procedures.ActionKind, 'agent' | 'check' | 'await-approval'>,
  (runContext: RunContext, running: Running) => Promise<visitScope.ActionResolution>
> = { commit: commitAction, push: pushAction, comment: postComment, 'pr-upsert': upsertPr, 'pr-ready': markReady };
