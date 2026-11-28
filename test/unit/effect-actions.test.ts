// The deterministic Actions on a ticket branch with nothing to publish, no commit its base on origin lacks (#490 Q1 A).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as effectActions from '../../lib/effect-actions.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as procedures from '../../lib/procedures.ts';
import * as runContextModule from '../../lib/run-context.ts';
import type * as visit from '../../lib/visit.ts';
import type * as visitScope from '../../lib/visit-scope.ts';
import * as exampleRun from '../support/example-run.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as keys from '../support/keys.ts';
import * as remoteFailures from '../support/remote-failures.ts';

type Kind = keyof typeof effectActions.EFFECT_KINDS;

// A Visit's state as runVisit starts it, whose claimed ok token requires no Check.
function runningVisit(): visitScope.RunningVisit {
  const state: visit.VisitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  Object.defineProperty(state, 'claimTokens', { value: new Map([['ok', { requires: [] }]]), enumerable: false });
  return state as visitScope.RunningVisit;
}

// The golden Ticket's worktree on its branch, cut from main on origin and still equal to it, with no PR open, as a Run
// context over the fake git and gh; `ahead` commits one change of its own first.
async function ticketBranch(t: TestContext, { ahead = false } = {}) {
  const fixture = await golden.fixture(t);
  if (ahead) {
    writeFileSync(join(fixture.worktree, 'work.txt'), 'work');
    fixture.fakeGit!.commit(fixture.worktree, 'work');
  }
  const context = runContextModule.createRunContext(fixture.options);
  context.record.configurationSnapshot = {
    vertex: 'green',
    visit: 1,
    configHash: context.record.configHash,
    agent: null,
    access: 'workspace-write',
    procedure: { name: 'implement', hash: 'procedure-hash' },
    outcomes: [],
    route: {},
    routes: {},
    inputs: {},
    commands: {},
    testPaths: [],
    persona: null,
    files: exampleRun.exampleConfig().files,
  };
  return { fixture, context };
}

// What an Action left on origin and GitHub: the ticket branch pushed, and each `gh pr create` run. The fake git is read
// unobserved, as the record a refused Action left may not load.
async function published({ fixture }: Awaited<ReturnType<typeof ticketBranch>>) {
  const pushed = await fixture.fakeGit!.git.remoteSha(fixture.mainRoot, golden.BRANCH);
  const created = fixture.gh.calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'create');
  return [...(pushed ? [`push ${golden.BRANCH}`] : []), ...created.map(() => 'gh pr create')];
}

// The first declaration of each kind in the example's Procedures, as a Visit runs it at green.
async function runKind(given: Awaited<ReturnType<typeof ticketBranch>>, kind: Kind) {
  const declared = Object.values(exampleRun.exampleConfig().procedures)
    .flatMap((procedure) => procedure.actions)
    .find((action) => action.do === kind) as procedures.Action;
  const actionIdentity = { vertex: 'green', visit: 1, procedure: 'implement', action: declared.id, recovery: 0 };
  return effectActions.EFFECT_KINDS[kind](given.context, { actionIdentity, action: declared, state: runningVisit() });
}

test('a push of a branch with no commit its base lacks ends with nothing-to-publish and pushes nothing', async (t) => {
  const given = await ticketBranch(t);
  const resolution = await runKind(given, 'push');
  assert.equal(resolution.outcome, 'nothing-to-publish');
  assert.equal(resolution.direction, 'stop');
  assert.deepEqual(await published(given), []);
});

test('a pr-upsert of a branch with no commit its base lacks is nothing-to-publish and creates no PR', async (t) => {
  const given = await ticketBranch(t);
  const resolution = await runKind(given, 'pr-upsert');
  assert.equal(resolution.outcome, 'nothing-to-publish');
  assert.equal(resolution.direction, 'stop');
  assert.deepEqual(await published(given), []);
});

test('a pr-upsert of a branch with no commit its base lacks still updates its open PR', async (t) => {
  const given = await ticketBranch(t);
  given.fixture.gh.prs.set(golden.BRANCH, {
    number: 7,
    state: 'OPEN',
    isDraft: true,
    url: 'https://github.com/o/r/pull/7',
    body: 'the PR body before',
    headRefName: golden.BRANCH,
  });
  const resolution = await runKind(given, 'pr-upsert');
  assert.equal(resolution.outcome, 'ok');
  assert.notEqual(given.fixture.gh.prs.get(golden.BRANCH)?.body, 'the PR body before');
  assert.deepEqual(await published(given), []);
});

// Every effect Action kind, each on its own ticket branch: which publish the branch with one commit ahead, and which
// still publish it with none (Q1 A: every push and every pr-upsert asks first).
test('no effect Action kind publishes a ticket branch with no commit its base lacks', async (t) => {
  const publishedBy = async (ahead: boolean) => {
    const byKind: Record<string, string[]> = {};
    for (const kind of Object.keys(effectActions.EFFECT_KINDS) as Kind[]) {
      const given = await ticketBranch(t, { ahead });
      // A kind this context cannot carry through (a commit with no agent call, a comment with no PR) publishes nothing;
      // push and pr-upsert must run through, so a throw is not read as publishing nothing.
      const running = runKind(given, kind);
      await (kind === 'push' || kind === 'pr-upsert' ? running : running.catch(() => null));
      byKind[kind] = await published(given);
    }
    return byKind;
  };
  assert.deepEqual(await publishedBy(true), {
    commit: [],
    push: [`push ${golden.BRANCH}`],
    comment: [],
    'pr-upsert': ['gh pr create'],
    'pr-ready': [],
  });
  assert.deepEqual(await publishedBy(false), {
    commit: [],
    push: [],
    comment: [],
    'pr-upsert': [],
    'pr-ready': [],
  });
});

// The check whether there is anything to publish reads origin and GitHub before the launch, so a transient failure of
// either is retried on the Action's remote budget, as the launch's own is (#490 Q1 A).
test("a transient failure of push's fetch for its check is retried and pushes once", async (t) => {
  const fixture = await golden.fixture(t);
  const git = fixture.options.deps.git;
  let checks = 0;
  fixture.options.deps.git = {
    ...git,
    commitsAhead: (...args) =>
      ++checks === 1 ? Promise.reject(remoteFailures.pushError()) : git.commitsAhead(...args),
  };
  const result = await interpreter.runExecution(fixture.options);

  const push = keys.retryKey({ vertex: 'green', visit: 1, action: 'push', recovery: 0 });
  await remoteFailures.retriedOnce(fixture, result, push, executionReads.actionMarker(fixture, 'green', 'push'));
  assert.equal(await executionReads.originSha(fixture), await executionReads.headSha(fixture));
});

test("a transient failure of pr-upsert's PR lookup for its check is retried and opens one PR", async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: remoteFailures.isPr('list'), status: 502 });
  const result = await interpreter.runExecution(fixture.options);

  const prUpsert = keys.retryKey({ vertex: 'green', visit: 1, action: 'pr', recovery: 0 });
  const marker = executionReads.attemptMarker(fixture, 'green', 1, 'pr', 0);
  await remoteFailures.retriedOnce(fixture, result, prUpsert, marker);
  assert.equal(remoteFailures.prCalls(fixture, 'create').length, 1, 'one create, after the retried lookup');
});
