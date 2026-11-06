import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as exec from '../../lib/exec.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as rescue from '../../lib/rescue.ts';
import * as addSuite from '../support/add-suite.ts';
import * as childScripts from '../support/child-scripts.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as processProbe from '../support/process-probe.ts';
import * as rescueFlow from '../support/rescue-flow.ts';
import * as reviewFlow from '../support/review-flow.ts';
import * as suiteRuns from '../support/suite-runs.ts';
import * as tempDirectory from '../support/temp-directory.ts';
import type * as fakeHarness from '../support/fake-harness.ts';
import { actionEvent, actionMarker, intents, loadTicket } from '../support/execution-reads.ts';
import { FIRST_VISIT, TDD_VERTICES, terminalReasonOf } from '../support/golden-run.ts';
import { contendRepoLock, onLockedGit } from '../support/repo-lock-contention.ts';
import { ticketComments } from '../support/review-flow.ts';
import * as fakeGhModule from '../support/fake-gh.ts';
import * as gitShell from '../support/git-shell.ts';

// The deterministic Actions of a first visit, each an advance at Attempt 1 of its Vertex's first Visit: red runs
// tests-fail and green runs implement. A call and a Check whose pass passed hand the Claim over (claimed); an effect
// completed.
const deterministic = (vertex: string, action: string, row: string) => {
  const procedure = vertex === 'red' ? 'tests-fail' : 'implement';
  return {
    action,
    recovery: 0,
    schemaVersion: 2,
    vertex,
    visit: 1,
    procedure,
    attempt: 1,
    direction: 'advance',
    rule: { table: 'fixed', row },
    agent: false,
  };
};

// The golden first Visit on real git, run to its end, and whether the PR was still a draft when pr-ready marked it.
async function firstVisitPass(t: TestContext) {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const marked: { draft?: boolean } = {};
  const { markReady } = fixture.options.deps.gh;
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    markReady: async (...args: Parameters<typeof markReady>) => {
      marked.draft = fixture.gh.pr()!.isDraft;
      return markReady(...args);
    },
  };
  await interpreter.runExecution(fixture.options);
  return { ...fixture, events: fixture.readEvents(), draft: marked.draft };
}
type FirstVisitPass = Awaited<ReturnType<typeof firstVisitPass>>;

function tracesRedAndGreen(fixture: FirstVisitPass) {
  const { events: traced } = fixture;
  assert.deepEqual(
    golden.trace(traced).filter((event) => TDD_VERTICES.includes(event.vertex)),
    FIRST_VISIT,
  );
  const fields = ({
    action,
    recovery,
    schemaVersion,
    vertex,
    visit,
    procedure,
    attempt,
    direction,
    rule,
    agent,
  }: events.ActionEvent) => ({
    action,
    recovery,
    schemaVersion,
    vertex,
    visit,
    procedure,
    attempt,
    direction,
    rule,
    agent,
  });
  const actions = traced.filter(
    (event): event is events.ActionEvent => event.type === 'action' && TDD_VERTICES.includes(event.vertex),
  );
  assert.deepEqual(actions.map(fields), [
    { ...deterministic('red', 'red', 'claimed'), agent: true },
    deterministic('red', 'red-check', 'claimed'),
    deterministic('red', 'commit', 'effect-completed'),
    { ...deterministic('green', 'green', 'claimed'), agent: true },
    deterministic('green', 'test', 'claimed'),
    deterministic('green', 'commit', 'effect-completed'),
    deterministic('green', 'push', 'effect-completed'),
    deterministic('green', 'pr', 'effect-completed'),
  ]);
  assert.deepEqual(
    actions.filter((event) => event.signals == null).map((event) => `${event.action}/${event.recovery}`),
    [],
    'every Action carries its signals',
  );
}

function runsPublishWithoutAnAgent(fixture: FirstVisitPass) {
  const { events: traced } = fixture;
  // publish has no Agent: its test Check, the PR body re-render and pr-ready, each at Recovery Number 0.
  assert.deepEqual(
    golden.trace(traced).filter((event) => event.vertex === 'publish'),
    ['test', 'pr', 'pr-ready'].map((action) => ({ vertex: 'publish', action, recovery: 0, attempt: 1, outcome: 'ok' })),
  );
  assert.deepEqual(
    traced
      .filter((event): event is events.ActionEvent => event.type === 'action' && event.vertex === 'publish')
      .map((event) => [event.action, event.agent, event.procedure]),
    [
      ['test', false, 'publish'],
      ['pr', false, 'publish'],
      ['pr-ready', false, 'publish'],
    ],
  );
  assert.equal(fixture.shells.length, 3, 'publish runs the test command again, on the tree pr-ready publishes');
}

function startsFreshSessions(fixture: FirstVisitPass) {
  const red = actionEvent(fixture, 'red', 'red') as events.AgentActionEvent;
  assert.equal(red.sessionId, 'fake-session-1');
  assert.equal(red.sessionLineage, null, 'red starts a fresh session');
  assert.match(red.transcriptPath!, /fake-session-1\.jsonl$/);
  assert.equal(red.usage.cumulative.costUsd, null, 'red: absent cost capability is null');
  assert.equal(red.usage.cumulative.reasoningTokens, null, 'red: absent reasoning capability is null');
  assert.equal(typeof red.usage.cumulative.inputTokens, 'number');
  const green = actionEvent(fixture, 'green', 'green') as events.AgentActionEvent;
  assert.equal(green.sessionId, 'fake-session-2');
  assert.equal(green.sessionLineage, null, 'green starts a fresh session');
  assert.match(green.transcriptPath!, /fake-session-2\.jsonl$/);
  assert.equal(green.usage.cumulative.costUsd, null, 'green: absent cost capability is null');
  assert.equal(green.usage.cumulative.reasoningTokens, null, 'green: absent reasoning capability is null');
  assert.equal(typeof green.usage.cumulative.inputTokens, 'number');
}

function pushesTwoCommitsWithTrailers(fixture: FirstVisitPass) {
  // Two commits on the branch, each carrying both trailers.
  const messages = gitShell
    .sh(fixture.worktree, 'log', '--format=%B%x00', `${fixture.base}..HEAD`)
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean)
    .reverse();
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^test: /);
  assert.ok(messages[0].includes('Gg-Vertex: red fake/model-x/high'), messages[0]);
  assert.ok(messages[0].includes(`Gg-Action: ${actionMarker(fixture, 'red', 'commit')}`), messages[0]);
  assert.match(messages[1], /^feat: /);
  assert.ok(messages[1].includes('Gg-Vertex: green fake/model-x/high'), messages[1]);
  assert.ok(messages[1].includes(`Gg-Action: ${actionMarker(fixture, 'green', 'commit')}`), messages[1]);
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0],
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
  );
}

function opensADraftPrThatPublishMarksReady(fixture: FirstVisitPass) {
  // The draft PR body carries the marker line, the red Evidence and the provenance row.
  assert.equal(fixture.draft, true, 'the PR is opened as a draft');
  const body = fixture.gh.pr()!.body!;
  assert.ok(body.includes("Cannot find module 'lib/add.mjs'"), 'red evidence in the PR body');
  assert.match(body, /^\| red \| fake \| model-x \| high \| /m);
  assert.match(body, /^\| green \| fake \| model-x \| high \| /m);
  assert.equal(fixture.gh.pr()!.isDraft, false, "publish's pr-ready marks the PR ready");
  assert.ok(
    fixture.gh.pr()!.body!.includes(marker.markerComment(actionMarker(fixture, 'publish', 'pr'))),
    'publish re-renders the PR body',
  );
}

function endsAtReadyForQa(fixture: FirstVisitPass) {
  const end = fixture.events.at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.ticket, golden.TICKET);
  assert.deepEqual(fixture.executionRecord.cursor, {
    vertex: 'ready-for-qa',
    visit: 1,
    action: 'end-label',
    recovery: 0,
    attempt: 1,
  });
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1, publish: 1 });
  assert.equal(fixture.executionRecord.state, 'ready-for-qa');
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
  assert.equal(
    fixture.executionRecord.terminalReason!.text,
    'publish visit 1 completed every publish Action: test passed. ' +
      `PR #${fixture.executionRecord.pr} is ready for review.`,
  );
}

// One run on real git, whose cases each assert one behaviour of it.
test('golden: a first-visit pass', async (t) => {
  const pass = await firstVisitPass(t);
  await t.test('golden: a first-visit pass traces red and green as advances', () => tracesRedAndGreen(pass));
  await t.test('golden: a first-visit pass runs publish with no Agent', () => runsPublishWithoutAnAgent(pass));
  await t.test('golden: a first-visit pass starts a fresh Session for red and for green', () =>
    startsFreshSessions(pass),
  );
  await t.test('golden: a first-visit pass pushes two commits that carry both trailers', () =>
    pushesTwoCommitsWithTrailers(pass),
  );
  await t.test('golden: a first-visit pass opens a draft PR that publish marks ready', () =>
    opensADraftPrThatPublishMarksReady(pass),
  );
  await t.test('golden: a first-visit pass ends at ready-for-qa through publish', () => endsAtReadyForQa(pass));
});

// Red committed its tests, then a human edited a tracked file before green started (R2d).
test("a write Vertex on a dirty worktree gg's records do not explain is held", async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const { commitStaged } = fixture.options.deps.git;
  let edited: string | null | undefined = null;
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    commitStaged: async (...args: Parameters<typeof commitStaged>) => {
      const sha = await commitStaged(...args);
      [edited] = gitShell.sh(fixture.worktree, 'ls-files').split('\n');
      writeFileSync(join(fixture.worktree, edited!), 'a human edit\n');
      return sha;
    },
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    fixture.harness.calls.map((call) => call.marker),
    [actionMarker(fixture, 'red', 'red')],
    'no green agent runs over unknown changes',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), `M ${edited}`, 'the human edit survives');
  assert.match(gitShell.sh(fixture.worktree, 'log', '-1', '--format=%s'), /^test: /, "red's commit stays");
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(fixture.executionRecord.history.at(-1)?.kind, 'held');
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1 });
  const reason = terminalReasonOf(fixture);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.match(reason.text, /uncommitted changes before green/);
});

// A gh call that changes GitHub: a comment, a label, a label definition or a pull request.
const ghWrite = (args: string[]) =>
  fakeGhModule.isCommentPost(args) ||
  (args[0] === 'issue' && args[1] === 'edit') ||
  (args[0] === 'label' && args[1] === 'create') ||
  (args[0] === 'pr' && ['create', 'edit', 'ready'].includes(args[1]));

test('a run stop during a repo-lock wait skips the queued effect and only needs-human reporting follows', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const runState: { stop: { failureClass: string; ticket: number } | null; remoteNotBefore: number } = {
    stop: null,
    remoteNotBefore: 0,
  };
  let before: number | undefined;
  let written: Record<string, number> | undefined;
  // Another Ticket stops the run while this one's push waits for the repo lock.
  const lock = contendRepoLock(fixture, async () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
    before = fixture.gh.calls.length;
    written = { ...counts };
  });
  const counts = onLockedGit(fixture, (verb, count) => {
    if (verb === 'commitStaged' && count === 2) lock.arm();
  });
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(lock.state(), 'released', 'the push waited for the lock');
  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
  assert.deepEqual(counts, written, 'no git write follows the stop');
  assert.equal(gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
  const final = await loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.equal(
    final.terminalReason!.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped before push.',
  );
  const writes = fixture.gh.calls.slice(before).filter((call) => ghWrite(call.args));
  assert.equal(writes.length, 2, JSON.stringify(writes.map((call) => call.args)));
  assert.ok(fakeGhModule.isCommentPost(writes[0].args, golden.TICKET), 'the needs-human comment');
  assert.ok(ticketComments(fixture).at(-1)!.body.startsWith('### gg: needs-human'));
  assert.ok(writes[1].args.join(' ').includes('--add-label gg:state:needs-human'), 'the needs-human label');
});

// Rescue Refs: a failed Vertex's work leaves the worktree when its route goes on to a Vertex (#118; R5, U5, W3, N4).
// green fails its Check in the recovery pass, so its rescue is an Action of recovery 1.
const rescueMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'green', 1, 'rescue', 1, 1);
const greenResetMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'green', 1, 'reset', 1, 1);
const greenRescueRef = (fixture: golden.GoldenFixture) => rescue.rescueRef(rescueMarker(fixture));
const inWorktree = (fixture: golden.GoldenFixture, path: string) => existsSync(join(fixture.worktree, path));
const failedThenRight = () => ({ ...rescueFlow.failingGreen(), ...rescueFlow.rightSenior() });

// The resets a Run makes, across every run of the case.
function countResets(fixture: golden.GoldenFixture) {
  const { git } = fixture.options.deps;
  const counted = { resets: 0 };
  fixture.options.deps.git = {
    ...git,
    resetTo: async (...args) => {
      counted.resets += 1;
      return git.resetTo(...args);
    },
  };
  return counted;
}

test('a failure routed to a Vertex is rescued and reset', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  const ref = greenRescueRef(fixture);
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what green tried');
  assert.equal(rescueFlow.inRef(fixture, ref, 'lib/add.mjs'), 'export const add = () => 0;');
  assert.equal(inWorktree(fixture, 'notes.txt'), false, 'the failed work left the worktree');
  const rescued = fixture.executionRecord.history.filter((item) => String(item.text).includes(ref));
  assert.equal(rescued.length, 1, 'one History item names the failure and the ref');
  assert.match(String(rescued[0]!.text), /test .*failed/);
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1, 'senior-green': 1, publish: 1 });
});

test('a failure routed to an end is left in place', async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: rescueFlow.failingGreen(),
    integrity: 'real',
    git: 'real',
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'needs-human');
  assert.deepEqual(rescueFlow.rescueRefs(fixture), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(readFileSync(join(fixture.worktree, 'notes.txt'), 'utf8'), 'what green tried\n');
});

test('the next Vertex reads the rescue output', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, {
    ...rescueFlow.failingGreen(),
    [rescueFlow.SENIOR_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'stuck' },
    },
  });
  await interpreter.runExecution(fixture.options);
  assert.deepEqual(fixture.executionRecord.configurationSnapshot!.inputs.previous, {
    value: {
      ref: greenRescueRef(fixture),
      diffStat: { files: 2, insertions: 2, deletions: 0, testFiles: 0, testInsertions: 0 },
      output: golden.GREEN_FAIL_OUTPUT,
    },
    vertex: 'green',
    visit: 1,
    action: 'rescue',
    absent: false,
  });
});

test('an existing rescue ref is never overwritten', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const ref = greenRescueRef(fixture);
  gitShell.sh(fixture.worktree, 'update-ref', ref, fixture.base);
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', ref), fixture.base, 'the ref keeps what it held');
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'nothing was reset');
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.ok(terminalReasonOf(fixture).text.includes(ref), 'the hold names the Rescue Ref');
});

test('ignored test files are kept in the rescue', async (t) => {
  const RED_CALL = keys.responseKey('red', 1, 'red', 1);
  const RED_RECOVERY = keys.responseKey('red', 1, 'recover', 1);
  // The tests pass before any implementation, so the Red Check fails both times.
  const passing = {
    files: { 'lib/add.mjs': goldenRun.RIGHT_ADD, 'test/generated/ignored.test.mjs': 'an ignored test\n' },
    response: golden.redResponse,
  };
  const fixture = await goldenRun.greenFixture(t, {
    responses: {
      [RED_CALL]: passing,
      [RED_RECOVERY]: passing,
      [keys.responseKey('senior-red', 1, 'red', 1)]: {
        files: {},
        response: { ...golden.redResponse, claim: 'blocked', diagnosis: 'stuck' },
      },
    },
    integrity: 'real',
    git: 'real',
  });
  writeFileSync(join(fixture.commonDir, 'info', 'exclude'), 'test/generated/\n');
  golden.configure(fixture, (configured) => {
    const { vertices } = configured.flows.golden!.ticket;
    vertices.red!.route = { ok: 'green', failed: 'senior-red' };
    vertices['senior-red'] = { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } };
    vertices.green!.inputs = {
      testFiles: { from: ['red.commit.files', 'senior-red.commit.files'] },
      red: { from: ['red.red-check.evidence', 'senior-red.red-check.evidence'] },
    };
    vertices.publish!.inputs = {
      report: { from: 'green.green.response' },
      red: { from: ['red.red-check.evidence', 'senior-red.red-check.evidence'] },
      green: { from: 'green.test.evidence' },
    };
  });
  await interpreter.runExecution(fixture.options);
  const ref = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'red', 1, 'rescue', 1, 1));
  assert.equal(rescueFlow.inRef(fixture, ref, 'test/generated/ignored.test.mjs'), 'an ignored test');
  assert.equal(inWorktree(fixture, 'test/generated/ignored.test.mjs'), false, 'the reset removed it');
});

test('a reset that leaves the worktree unlike the baseline holds', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    resetTo: async (...args) => {
      await git.resetTo(...args);
      writeFileSync(join(fixture.worktree, 'stray.txt'), 'a writer nobody knew of\n');
    },
  };
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.ok(terminalReasonOf(fixture).text.includes(greenRescueRef(fixture)), 'the hold names the Rescue Ref');
  assert.deepEqual(
    fixture.harness.calls.map((call) => call.marker).filter((call) => call?.includes('senior-green')),
    [],
  );
});

const RESCUE_CRASHES: Record<
  string,
  (fixture: golden.GoldenFixture) => NonNullable<interpreter.ExecutionOptions['crashAt']>
> = {
  'before its ref is made': (fixture) => ({ marker: rescueMarker(fixture), point: 'before-effect' }),
  'after its ref is made': (fixture) => ({ marker: rescueMarker(fixture), point: 'after-effect' }),
  'before the reset is intended': (fixture) => ({ marker: greenResetMarker(fixture), point: 'before-intent' }),
  'before the reset': (fixture) => ({ marker: greenResetMarker(fixture), point: 'before-effect' }),
  'after the reset': (fixture) => ({ marker: greenResetMarker(fixture), point: 'after-effect' }),
  'after the rescue completes': (fixture) => ({ marker: rescueMarker(fixture), point: 'after-completion' }),
};
for (const [place, crashAt] of Object.entries(RESCUE_CRASHES)) {
  test(`a crash during the rescue or the reset resumes at the next step: ${place}`, async (t) => {
    const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
    const counted = countResets(fixture);
    await assert.rejects(
      interpreter.runExecution({ ...fixture.options, crashAt: crashAt(fixture) }),
      (err) => err instanceof interpreter.CrashError,
    );
    const loaded = await loadTicket(fixture);
    const dirty = await reconcile.dirtyState(loaded, {
      git: fixture.options.deps.git,
      worktree: fixture.worktree,
    });
    assert.equal(dirty, null, "admission reads the rescue's own state as proven");
    const { outcome } = await interpreter.runExecution({ ...fixture.options, record: loaded });
    assert.equal(outcome, 'ready-for-qa');
    assert.deepEqual(rescueFlow.rescueRefs(fixture), [greenRescueRef(fixture)], 'no second ref');
    assert.ok(counted.resets <= 2, `at most the one reset and its finish: ${counted.resets}`);
    const saved = await loadTicket(fixture);
    assert.equal(saved.history.filter((item) => item.kind === 'rescued').length, 1, 'one History item');
    assert.equal(inWorktree(fixture, 'notes.txt'), false);
  });
}

test('a reset that cannot remove a locked file holds with the state rescued', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    resetTo: async () => {
      throw new exec.CommandError('git reset failed', {
        code: 1,
        stdout: '',
        stderr: "error: unable to unlink old 'lib/add.mjs': Permission denied",
      });
    },
  };
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  const ref = greenRescueRef(fixture);
  assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what green tried', 'the work is in the ref');
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'and still in the worktree');
  assert.ok(terminalReasonOf(fixture).text.includes(ref), 'the hold names the Rescue Ref');
});

test('a clean worktree is not rescued or reset', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, {
    [rescueFlow.GREEN_CALL]: goldenRun.greenWrites({}),
    [rescueFlow.GREEN_RECOVERY]: goldenRun.greenWrites({}),
    ...rescueFlow.rightSenior(),
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1, 'senior-green': 1, publish: 1 });
  assert.deepEqual(rescueFlow.rescueRefs(fixture), []);
  assert.deepEqual(intents(fixture.executionRecord, 'rescue'), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.deepEqual(
    fixture.executionRecord.outputs.filter((output) => output.action === 'rescue'),
    [],
  );
});

test("a rescue holds when the branch moved since the Visit began, so its work is not proven the agent's", async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, {
    [rescueFlow.GREEN_CALL]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
    [rescueFlow.GREEN_RECOVERY]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
    ...rescueFlow.rightSenior(),
  });
  // Someone commits by hand while the last Check runs, after the Attempts' Integrity Assertions.
  suiteRuns.editRuns(fixture, (run) => {
    if (fixture.executionRecord.cursor.recovery === 1)
      gitShell.sh(fixture.worktree, 'commit', '-q', '--allow-empty', '-m', 'by hand');
    return run;
  });
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.deepEqual(rescueFlow.rescueRefs(fixture), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
});

test('a background writer left by a returned call is killed before the rescue', async (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-writer-');
  const pidFile = join(directory, 'writer.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  // green's first Check runs a real command, which exits 1 and leaves a writer running in the worktree.
  const suite = fixture.options.deps.exec;
  const real = exec.createExec();
  let first = true;
  fixture.options.deps.exec = {
    runShell: (command, options) => {
      if (!existsSync(join(fixture.worktree, 'lib', 'add.mjs')) || !first) return suite.runShell(command, options);
      first = false;
      const writes = childScripts.nodeCommand(
        t,
        childScripts.BACKGROUND_STARTER,
        'ignore',
        '1',
        pidFile,
        childScripts.BACKGROUND_WRITER,
        join(fixture.worktree, 'writer.log'),
      );
      return real.runShell(writes, options);
    },
  };
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.equal(processProbe.alive(processProbe.pidIn(pidFile)), false, 'the writer is gone');
  assert.equal(inWorktree(fixture, 'writer.log'), false, 'nothing wrote after the reset');
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [greenRescueRef(fixture)]);
});

// The golden traces of a failed fix: escalated with its work rescued, and left in place once the escalation is spent.
const reviewCall = (visitNumber: number) => keys.responseKey('reviewer', visitNumber, 'review', 1);
const fixCall = (vertex: string, visitNumber = 1) => keys.responseKey(vertex, visitNumber, 'fix', 1);
const fixRecovery = (visitNumber = 1) => keys.responseKey('implementer-fix', visitNumber, 'recover', 1);
const wrongFix = () => reviewFlow.fixed({ 'lib/add.mjs': goldenRun.WRONG_ADD });

// A failed implementer-fix escalates to senior-dev, which reads the failed work as `previous`, once; then it ends.
async function escalatingFix(t: TestContext, responses: fakeHarness.ScriptedResponses) {
  const fixture = await reviewFlow.reviewFixture(t, responses, {
    integrity: 'real',
    git: 'real',
    configure: (configured) => {
      const { vertices } = configured.flows.golden!.ticket;
      vertices['implementer-fix']!.route = {
        ok: 'reviewer',
        failed: { to: 'senior-dev', max: 1, exhausted: { end: 'needs-human' } },
      };
      vertices['senior-dev']!.inputs = {
        ...reviewFlow.FIX_INPUTS,
        previous: { from: 'implementer-fix.rescue', optional: true },
      };
    },
  });
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true });
  return goldenRun.ranToEnd(fixture);
}
const fixTrace = (fixture: goldenRun.GoldenRun) =>
  golden
    .trace(fixture.events)
    .filter((event) => ['implementer-fix', 'senior-dev'].includes(event.vertex))
    .map((event) => `${event.vertex}/${event.action}/${event.recovery}`);

test('golden: a failed fix is rescued into an escalation Vertex', async (t) => {
  const fixture = await escalatingFix(t, {
    [reviewCall(1)]: reviewFlow.reviewed(reviewFlow.review('changes', [reviewFlow.MAJOR])),
    [fixCall('implementer-fix')]: wrongFix(),
    [fixRecovery()]: wrongFix(),
    [fixCall('senior-dev')]: reviewFlow.fixed({
      'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b); // a + b\n',
    }),
    [reviewCall(2)]: reviewFlow.reviewed(reviewFlow.review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(fixTrace(fixture), [
    'implementer-fix/fix/0',
    'implementer-fix/test/0',
    'implementer-fix/fix/1',
    'implementer-fix/test/1',
    'implementer-fix/rescue/1',
    'senior-dev/fix/0',
    'senior-dev/test/0',
    'senior-dev/commit/0',
    'senior-dev/push/0',
    'senior-dev/pr/0',
  ]);
  const ref = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'rescue', 1, 1));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  assert.equal(rescueFlow.inRef(fixture, ref, 'lib/add.mjs'), 'export const add = () => 0;');
});

test('golden: the same failure is left in place once the escalation is exhausted', async (t) => {
  const fixture = await escalatingFix(t, {
    [reviewCall(1)]: reviewFlow.reviewed(reviewFlow.review('changes', [reviewFlow.MAJOR])),
    [fixCall('implementer-fix')]: wrongFix(),
    [fixRecovery()]: wrongFix(),
    [fixCall('senior-dev')]: reviewFlow.fixed({
      'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b); // a + b\n',
    }),
    [reviewCall(2)]: reviewFlow.reviewed(
      reviewFlow.review('changes', [reviewFlow.finding('major', 'lib/add.mjs', 'another problem')]),
    ),
    [fixCall('implementer-fix', 2)]: wrongFix(),
    [fixRecovery(2)]: wrongFix(),
  });
  assert.equal(fixture.result.outcome, 'needs-human');
  assert.deepEqual(fixTrace(fixture).slice(-3), [
    'implementer-fix/test/0',
    'implementer-fix/fix/1',
    'implementer-fix/test/1',
  ]);
  const first = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'rescue', 1, 1));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [first], 'only the failure that escalated was rescued');
  assert.equal(readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8'), goldenRun.WRONG_ADD);
  assert.match(fixture.executionRecord.terminalReason!.text, /had used its Bound/);
});
