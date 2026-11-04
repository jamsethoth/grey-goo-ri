// The deterministic Actions, each a write-ahead side effect (lib/effects.ts): commit and push in git, and comment,
// pr-upsert and pr-ready on GitHub.
import * as checks from './checks.ts';
import * as config from './config.mjs';
import * as effectErrors from './effect-errors.ts';
import * as effects from './effects.ts';
import * as github from './github.ts';
import * as integrity from './integrity.ts';
import * as outcome from './outcome.ts';
import type * as procedures from './procedures.ts';
import * as render from './render.mjs';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type Running = visitScope.Running;
// The intents these Actions write ahead, which Effect Evidence reads at resume (lib/effect-evidence.ts).
export type CommitPayload = { message: string; tree: string; parent: string };
export type PushPayload = { branch: string; sha: string };
export type CommentPayload = { target: { kind: string; number: number }; body: string; bodyHash: string };
export type PrUpsertPayload = { branch: string; base?: string; title: string; body: string; bodyHash: string };
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
  const intended = effects.logged(executionRecord, actionMarker, 'intent')?.payload as CommitPayload | undefined;
  const requires = visitScope.tokenOf(state).requires!.map((id) => state.checks[id]);
  const stale = intended
    ? []
    : (await visitScope.fresh(runContext, requires)).filter((check) => check.state !== 'passed');
  if (stale.length) return { stale };
  if (!intended) await git.stageAll(worktree);
  const payload = intended ?? { message, tree: await git.writeTree(worktree), parent: await git.headSha(worktree) };
  const { sha } = (await effects.sideEffect<CommitPayload>(runContext, {
    actionMarker,
    effect: 'commit',
    payload,
    perform: async (planned) => ({
      sha: intended ? await git.commitTree(worktree, planned) : await git.commitStaged(worktree, planned.message),
    }),
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
  { stale, startedAt, call }: { stale: visit.CheckSignal[]; startedAt: number; call: visit.AgentCall },
) {
  const { harnessResult: result, claim, signal } = call;
  const [first] = stale;
  const resolution = outcome.decide({
    result: signal,
    claim,
    checks: visitScope.resolverChecks([], stale),
    retries: {},
    token: visitScope.tokenOf(state),
    procedure: state.proc,
    scope: visitScope.scopeOf(runContext.record, actionIdentity, state, {
      ...state.checks,
      ...Object.fromEntries(stale.map((check) => [check.id, check])),
    }),
  });
  return effects.finish(runContext, {
    actionRef: actionIdentity,
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

// The outputs are recorded with the commit's completion and Event, outside the bracket so its idle save cannot publish
// them first. R3c: every gg commit is the new Test Immutability baseline, since each passed it or wrote tests. R3d: the
// first test commit is the first that changed a path under testPaths. A commit with nothing to commit moves neither.
async function commit(runContext: RunContext, running: Running) {
  const { record: executionRecord, ticket } = runContext;
  const { actionIdentity, action, state } = running;
  const { agent } = executionRecord.configurationSnapshot!;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const call = state.call!;
  const { response } = call;
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
  const committed: Committed = await effects.bracket(runContext, () =>
    makeCommit(runContext, state, actionMarker, message),
  );
  if (committed.stale) return refuseStale(runContext, running, { stale: committed.stale, startedAt, call });
  const { sha, files } = committed;
  visitScope.recordOutput(executionRecord, actionIdentity, { files });
  if (sha) executionRecord.testCommits.baseline = sha;
  if (sha && files.some(checks.testPathMatcher(executionRecord.configurationSnapshot!.testPaths)))
    executionRecord.testCommits.first ??= sha;
  return effects.effectDone(runContext, actionIdentity, startedAt, actionMarker);
}

// The commit the record proves was checked, not HEAD: a branch changed by hand is never published.
async function push(runContext: RunContext, { actionIdentity }: Running) {
  const { record: executionRecord, git } = runContext;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  await effects.bracket(runContext, async () => {
    const sha =
      (writeAhead.lastCommit(executionRecord)?.evidence as { sha: string } | undefined)?.sha ??
      (await git.headSha(executionRecord.worktree));
    await effects.sideEffect<PushPayload>(runContext, {
      actionMarker,
      effect: 'push',
      payload: { branch: executionRecord.branch, sha },
      perform: async (planned) => {
        await git.push(executionRecord.worktree, planned.branch, planned.sha);
        const remoteSha = await git.remoteSha(executionRecord.worktree, planned.branch);
        if (remoteSha !== planned.sha)
          throw new Error(`origin has ${planned.branch} at ${remoteSha}, not the intended ${planned.sha}`);
        return { remoteSha };
      },
      deferred: true,
    });
  });
  return effects.effectDone(runContext, actionIdentity, startedAt, actionMarker);
}

// `target: ticket` comments on the Ticket; the review's comment goes to the PR (W5). A Procedure with no agent Action
// has no Agent to name.
async function comment(runContext: RunContext, { actionIdentity, action, state }: Running) {
  const { record: executionRecord, gh, cwd } = runContext;
  const { agent, persona } = executionRecord.configurationSnapshot!;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const body = await render.publicBody(
    config.layerFile(runContext.files, action.body),
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
  await effects.bracket(runContext, () =>
    effects.sideEffect<CommentPayload>(runContext, {
      actionMarker,
      effect: 'comment',
      payload: { target, body, bodyHash: config.sha256(body) },
      perform: async (planned) => ({
        id: github.commentId(await gh.comment(planned.target.number, planned.body, cwd)),
      }),
      deferred: true,
    }),
  );
  return effects.effectDone(runContext, actionIdentity, startedAt, actionMarker);
}

// Creates the PR after implement, and re-renders its body after a fix or review with a provenance row per Vertex. A
// `with` name shadows the scope's own (implement's `green` is its agent Action's output).
async function prUpsert(runContext: RunContext, running: Running) {
  const { record: executionRecord, gh, ticket, cwd } = runContext;
  const { actionIdentity, action, state } = running;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const body = await render.publicBody(
    config.layerFile(runContext.files, action.body),
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
  await effects.bracket(runContext, () =>
    effects.sideEffect<PrUpsertPayload>(runContext, {
      actionMarker,
      effect: 'pr-upsert',
      payload,
      perform: async (planned) => {
        const pr = await gh.upsertPr(planned as Parameters<typeof gh.upsertPr>[0], cwd);
        executionRecord.pr = pr.number;
        return { number: pr.number, url: pr.url };
      },
      deferred: true,
    }),
  );
  return effects.effectDone(runContext, actionIdentity, startedAt, actionMarker);
}

// A publishing Action (R11d, T1a): it marks ready only the last commit the record proves pushed, and only if every
// worktree Check the claimed token requires passed on that commit's tree. The target is saved in the intent, so a retry
// or a resume publishes the same commit, and each launch checks it again, with the PR's head (M1).
async function prReady(runContext: RunContext, { actionIdentity, state }: Running) {
  const { record: executionRecord, gh, cwd } = runContext;
  const startedAt = runContext.clock.now();
  const actionMarker = runContext.markerOf(actionIdentity);
  const checked = visitScope
    .tokenOf(state)
    .requires!.map((id) => state.checks[id])
    .filter((check) => check?.tree);
  const [first] = checked;
  const tree =
    first && checked.every((check) => check.state === 'passed' && check.tree === first.tree) ? first.tree : null;
  const lastSha = (writeAhead.lastCommit(executionRecord)?.evidence as { sha: string } | undefined)?.sha ?? null;
  const target = { number: executionRecord.pr!, sha: lastSha, tree };
  await effects.bracket(runContext, () =>
    effects.sideEffect(runContext, {
      actionMarker,
      effect: 'pr-ready',
      payload: target,
      perform: async (planned) => {
        const why = await unpublishable(runContext, planned);
        if (why)
          throw new effectErrors.EarlyTerminalError({
            next: 'hold',
            name: 'unchecked-publish',
            reason: `PR #${planned.number} was not marked ready: ${why}; nothing was published.`,
          });
        await gh.markReady(planned.number, cwd);
        return {};
      },
      deferred: true,
    }),
  );
  return effects.effectDone(runContext, actionIdentity, startedAt, actionMarker);
}

// Why the target cannot be marked ready, or null: the worktree must be clean at the commit, and the PR's head that
// commit on gg's branch in this repository. A head that cannot be read proves nothing, so it holds too.
// shortcut: the head read and GitHub's ready call are not atomic, so a push between them cannot be excluded, as with
// GitHub's own required checks; close it if GitHub gains a ready call conditioned on the head.
async function unpublishable(
  runContext: RunContext,
  { sha, tree, number }: { sha: string | null; tree: string | null; number: number },
): Promise<string | null> {
  const { record: executionRecord, git, gh, cwd } = runContext;
  if (!sha) return 'the record proves no pushed commit';
  const published = await git.treeOf(executionRecord.worktree, sha);
  if (tree !== published) return `its Check passed on tree ${tree}, not on tree ${published} of commit ${sha}`;
  const now = await integrity.snapshot(executionRecord.worktree, git, runContext.locks);
  if (now.head !== sha || now.index !== published || now.tree !== published)
    return `the worktree is not clean at commit ${sha}`;
  let pr;
  try {
    pr = await gh.viewPr(number, cwd);
  } catch (err) {
    return `its head could not be read (${String((err as Error | null)?.message ?? err).split('\n')[0]})`;
  }
  if (pr.isCrossRepository !== false || pr.headRefName !== executionRecord.branch || pr.headRefOid !== sha) {
    const where = pr.isCrossRepository === false ? '' : ' in another repository';
    return `its head is ${pr.headRefName} at ${pr.headRefOid}${where}, not ${executionRecord.branch} at ${sha}`;
  }
  return null;
}

// The deterministic Action kinds by their `do`.
export const EFFECT_KINDS: Record<
  Exclude<procedures.ActionKind, 'agent' | 'check' | 'await-approval'>,
  (runContext: RunContext, running: Running) => Promise<visitScope.ActionResolution>
> = { commit, push, comment, 'pr-upsert': prUpsert, 'pr-ready': prReady };
