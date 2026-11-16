import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as effects from '../../lib/effects/index.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as labels from '../../lib/labels.ts';
import * as locks from '../../lib/locks.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as work from '../../lib/work.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as addSuite from '../support/add-suite.ts';
import * as approvalFlow from '../support/approval-flow.ts';
import * as epicRun from '../support/epic-run.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const TICKET = 7;
const IN_PROGRESS = 'gg:state:in-progress';

// A repository's common dir holding Ticket 7's Execution Record, one Event and its worktree, with the Ticket labelled
// in progress on the fake gh.
function abandoning(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-work-');
  const worktree = join(commonDir, 'wt', 'ticket-7');
  mkdirSync(worktree, { recursive: true });
  record.save(
    record.createExecutionRecord({
      commonDir,
      repository: 'o/r',
      ticket: TICKET,
      epic: null,
      flow: { name: 'gone', entry: 'red' },
      configHash: 'x',
      run: '20261016T000000Z-seed00',
      worktree,
      branch: 'ticket/7-add',
      base: 'main',
    }),
  );
  events.eventLog(commonDir)('run_start', { run: '20261016T000000Z-seed00' });
  const fake = fakeGh.fakeGh({ branch: 'ticket/7-add', ticket: TICKET });
  fake.labels.add(IN_PROGRESS);
  const options = { ticket: TICKET, commonDir, cwd: commonDir, labelPrefix: 'gg', gh: github.createGh(fake.gh), locks };
  return { commonDir, worktree, fake, options };
}

test('gg work abandon deletes the Execution Record row and keeps its Events and worktree', async (t) => {
  const { commonDir, worktree, fake, options } = abandoning(t);
  const text = await work.abandon(options);
  assert.equal(record.load(commonDir, 'ticket', TICKET), null, 'the row is deleted');
  assert.deepEqual(
    eventRead.readEvents(commonDir).map((event) => event.type),
    ['run_start'],
    'the Events are kept',
  );
  assert.ok(existsSync(worktree), 'the worktree is kept');
  assert.ok(!fake.labels.has(IN_PROGRESS), 'the Ticket is no longer labelled in progress');
  assert.equal(
    text,
    'gg work abandon deleted Execution Record ticket-7 of Flow gone and removed the gg:state:in-progress label; its ' +
      `Events, its worktree ${worktree} and its branch ticket/7-add are kept. gg run 7 --flow <name> starts a new ` +
      'Execution on that branch.\n',
  );
});

// Readiness refuses a Ticket with any State Label, so abandoning a held Ticket clears its needs-human too.
test('gg work abandon removes every State Label the Ticket carries, so the next Run can admit it', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  fake.labels.add('gg:state:needs-human');
  fake.labels.add('gg:await:approve');
  const text = await work.abandon(options);
  assert.equal(record.load(commonDir, 'ticket', TICKET), null, 'the row is deleted');
  assert.deepEqual([...fake.labels].sort(), ['gg:await:approve'], 'only the State Labels go');
  assert.match(text, / and removed the gg:state:in-progress, gg:state:needs-human labels; /);
});

test('gg work abandon refuses while the ticket lock is held', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  const held = await locks.tryAcquire(commonDir, `ticket-${TICKET}`);
  assert.ok(held, 'the case holds the ticket lock');
  try {
    await assert.rejects(work.abandon(options), {
      message: 'another process holds the ticket-7 lock, so Ticket 7 may be running; abandon it once that process ends',
    });
  } finally {
    // Before the temp directory goes: Windows will not remove an open lock file.
    await locks.release(held);
  }
  assert.ok(record.load(commonDir, 'ticket', TICKET), 'the record is kept');
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

test('gg work abandon of a Ticket with no Execution Record says so and changes nothing', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  assert.ok(record.removeRecord(commonDir, 'ticket', TICKET), 'removeRecord says it deleted a row');
  await assert.rejects(work.abandon(options), { message: 'Ticket 7 has no Execution Record to abandon' });
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

// A record deleted while the label stays would read as stuck, so a failed label update keeps the record.
test('gg work abandon keeps the record when its in-progress label cannot be removed', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  fake.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'edit', status: 502 });
  await assert.rejects(work.abandon(options), /label update .* failed: .*; Execution Record ticket-7 is kept$/);
  assert.ok(record.load(commonDir, 'ticket', TICKET), 'the record is kept');
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

// gg work done is handed a database, so its check that the State Database is there, before the ticket lock, goes
// through it like every read it makes (#367).
test('gg work done checks the State Database through the database it is handed, before it starts', async (t) => {
  const fixture = await faulted(t);
  const before = loaded(fixture).state;
  const options = doneOptions(fixture, true);
  options.deps = {
    ...options.deps,
    database: {
      ...options.deps.database!,
      open: () => {
        throw new Error('the handed database refused');
      },
    },
  };
  await assert.rejects(work.done(options), { message: 'the handed database refused' });
  assert.equal(loaded(fixture).state, before, 'nothing resolved');
});

// Only gg init creates the State Database (#150), so abandon refuses a repository without one before it takes the
// ticket lock, which would leave a lock file behind.
test('gg work abandon refuses a missing State Database before it takes the ticket lock', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-work-');
  const fake = fakeGh.fakeGh({ branch: 'ticket/7-add', ticket: TICKET });
  const options = { ticket: TICKET, commonDir, cwd: commonDir, labelPrefix: 'gg', gh: github.createGh(fake.gh), locks };
  await assert.rejects(work.abandon(options), {
    message: `no State Database at ${join(commonDir, 'gg', 'gg.db')}: run gg init`,
  });
  assert.equal(existsSync(join(commonDir, 'gg')), false, 'no gg directory: no lock file and no database');
  assert.deepEqual(fake.calls, [], 'no gh call');
});

// Ticket 15 run once by gg run over a suite that checks the sum: its green writes a wrong add and finds no recovery, so
// the Execution ends at fault with red's commit and green's outputs saved and an agent call left open. `onRun` sees
// each suite run of every later Run.
// `configure` edits the fixture before its Run, and `fixtureOptions` go to the run fixture.
interface Faulting {
  responses?: Record<string, unknown>;
  onRun?: () => void;
  configure?: (fixture: runFixture.RunFixture) => void;
  fixtureOptions?: runFixture.RunFixtureOptions;
}
async function faulted(
  t: TestContext,
  { responses = {}, onRun = () => {}, configure = () => {}, fixtureOptions = {} }: Faulting = {},
) {
  const scripted = {
    ...structuredClone(golden.firstVisitResponses),
    [keys.responseKey('green', 1, 'green', 1)]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
    ...responses,
  };
  const fixture = runFixture.fixture(t, {
    responses: scripted as golden.GoldenOptions['responses'],
    ...fixtureOptions,
  });
  configure(fixture);
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true, onRun });
  await run.runTarget(fixture.options);
  return fixture;
}

const loaded = (fixture: runFixture.RunFixture) => record.load(fixture.commonDir, 'ticket', runFixture.TICKET)!;
const stateLabelsOf = (fixture: runFixture.RunFixture) =>
  [...fixture.gh.labels].filter((name) => labels.labelsFor('gg').parse(name)?.family === 'state');

function doneOptions(fixture: runFixture.RunFixture, close = false): work.DoneOptions {
  return {
    ticket: runFixture.TICKET,
    commonDir: fixture.commonDir,
    cwd: fixture.mainRoot,
    labelPrefix: 'gg',
    deps: { ...fixture.options.deps, locks },
    close,
    log: (line) => fixture.logs.push(line),
  };
}

// The Ticket's record moved to `state`, as an earlier Run or a person left it.
function landedIn(fixture: runFixture.RunFixture, state: string) {
  const executionRecord = loaded(fixture);
  executionRecord.state = state;
  record.save(executionRecord);
}

// The pull request a person left on the Ticket's branch, in `state`, named by the record.
function prIn(fixture: runFixture.RunFixture, state: string) {
  fixture.gh.prs.set(runFixture.BRANCH, {
    number: 9,
    state,
    isDraft: false,
    url: 'https://github.com/o/r/pull/9',
    body: 'Closes #15',
    headRefName: runFixture.BRANCH,
  });
  const executionRecord = loaded(fixture);
  executionRecord.pr = 9;
  record.save(executionRecord);
}

test('gg work done records the human end and swaps the label', async (t) => {
  const fixture = await faulted(t);
  fixture.gh.repoLabels.delete('gg:state:done');
  const text = await work.done(doneOptions(fixture, true));
  const executionRecord = loaded(fixture);
  assert.equal(executionRecord.state, 'done');
  assert.deepEqual(executionRecord.terminalReason?.decidedBy, { human: fakeGh.HUMAN_LOGIN });
  assert.ok(fixture.gh.repoLabels.has('gg:state:done'), 'gg:state:done is created as a Run creates its State Labels');
  assert.deepEqual(stateLabelsOf(fixture), ['gg:state:done'], 'done replaces needs-human');
  const resolved = fixture.readEvents().filter((event) => event.type === 'ticket_resolved');
  assert.deepEqual(
    resolved.map(({ execution, ticket, owner, human }) => ({ execution, ticket, owner, human })),
    [{ execution: executionRecord.execution, ticket: 15, owner: { kind: 'ticket', number: 15 }, human: 'octo-human' }],
  );
  const comments = fixture.comments().filter((body) => body.includes('resolve-comment'));
  assert.equal(comments.length, 1, 'one comment');
  assert.match(comments[0]!, /octo-human/, 'naming who resolved it');
  // Each report Action is write-ahead with its Action Event, under the report name resolve.
  const actions = fixture.readEvents().flatMap((event) => (event.type === 'action' ? [event.action] : []));
  assert.deepEqual(actions.filter((action) => action.startsWith('resolve-')).sort(), [
    'resolve-close',
    'resolve-comment',
    'resolve-label',
  ]);
  assert.ok(fixture.gh.closed.has(runFixture.TICKET), '--close closes the issue');
  assert.equal(text, 'gg work done resolved Ticket 15 as done, decided by octo-human, and closed issue #15.\n');
});

test('gg work done closes the issue only when its PR is merged or --close is given', async (t) => {
  const noMergedPr = /Ticket 15 has no merged PR; pass --close when no change was needed/;
  const open = /PR #9 of Ticket 15 is open; merge or close it first/;
  const cases: { pr: string | null; close: boolean; refused?: RegExp; closed?: boolean }[] = [
    { pr: null, close: false, refused: noMergedPr },
    { pr: 'OPEN', close: false, refused: open },
    { pr: 'OPEN', close: true, refused: open },
    { pr: 'CLOSED', close: false, refused: noMergedPr },
    { pr: 'CLOSED', close: true, closed: true },
    { pr: 'MERGED', close: false, closed: true },
    { pr: null, close: true, closed: true },
  ];
  for (const given of cases) {
    const fixture = await faulted(t);
    if (given.pr) prIn(fixture, given.pr);
    const name = `PR ${given.pr ?? 'none'}, --close ${given.close}`;
    if (given.refused) {
      await assert.rejects(work.done(doneOptions(fixture, given.close)), given.refused, name);
      assert.equal(loaded(fixture).state, 'fault', `${name}: the record is kept`);
      assert.ok(!fixture.gh.closed.has(runFixture.TICKET), `${name}: the issue stays open`);
    } else {
      await work.done(doneOptions(fixture, given.close));
      assert.equal(loaded(fixture).state, 'done', name);
      assert.equal(fixture.gh.closed.has(runFixture.TICKET), given.closed, `${name}: the issue is closed`);
    }
  }
});

// Every record state an Execution lands in, and the ones each verb takes (owner, 2026-11-06).
const RECORD_STATES = ['active', ...labels.END_STATES, 'held', 'fault', 'abandoned', 'done'];
const STOPPED = ['needs-human', 'needs-replan', 'held', 'fault', 'abandoned'];

test('gg work done and gg work resume take a Ticket in each stopped state and refuse every other state', async (t) => {
  assert.deepEqual(
    RECORD_STATES.filter((state) => !STOPPED.includes(state)),
    ['active', 'ready-for-qa', 'done'],
    'the states both verbs refuse',
  );
  for (const state of RECORD_STATES) {
    const resolving = await faulted(t);
    landedIn(resolving, state);
    const resolved = work.done(doneOptions(resolving, true));
    if (STOPPED.includes(state)) {
      await resolved;
      assert.equal(loaded(resolving).state, 'done', `done takes ${state}`);
    } else {
      await assert.rejects(resolved, new RegExp(`Ticket 15 is ${state}; gg work done takes`), `done refuses ${state}`);
    }
    const resuming = await faulted(t);
    landedIn(resuming, state);
    const [result] = await run.runTarget({ ...resuming.options, resume: { vertex: 'green' } });
    const resumed = resuming.readEvents().filter((event) => event.type === 'ticket_resumed');
    if (STOPPED.includes(state)) assert.equal(resumed.length, 1, `resume takes ${state}`);
    else {
      const refusal = new RegExp(`Ticket 15 is ${state}; gg work resume takes`);
      assert.match(String(result?.error), refusal, `resume refuses ${state}`);
      assert.equal(resumed.length, 0, `resume refuses ${state}`);
    }
  }
});

// Ticket 15 run once by gg run with red and green passing and the suite failing from publish on, as a broken
// environment would, so the Execution stops at publish with every input it reads saved. `fixed()` mends the suite.
async function stoppedAtPublish(t: TestContext, onRun: () => void) {
  const fixture = runFixture.fixture(t);
  const suite = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true, onRun });
  const environment = { runs: 0, broken: true };
  fixture.options.deps.exec = {
    ...suite,
    runShell: async (command: string, options?: { cwd?: string }) => {
      environment.runs += 1;
      if (environment.broken && environment.runs > 2)
        return { code: 1, output: 'the suite could not start', timedOut: false, cleanup: addSuite.CONFIRMED };
      return suite.runShell(command, options);
    },
  } as typeof suite;
  const [first] = await run.runTarget(fixture.options);
  assert.ok(STOPPED.includes(loaded(fixture).state), `the first Run stops at publish (${first?.outcome})`);
  return { fixture, fixed: () => (environment.broken = false) };
}

test('gg work resume --at publish runs the suite and reaches ready-for-qa', async (t) => {
  let suiteRuns = 0;
  const { fixture, fixed } = await stoppedAtPublish(t, () => (suiteRuns += 1));
  fixed();
  // The person's fix, committed and pushed on the branch: the resume takes it as the baseline (Q2 A).
  writeFileSync(join(fixture.worktree, 'NOTES.md'), 'The suite needed a mended environment.\n');
  fixture.fakeGit!.commit(fixture.worktree, 'Note the fix by hand');
  const head = await fixture.options.deps.git.headSha(fixture.worktree);
  await fixture.options.deps.git.push(fixture.worktree, runFixture.BRANCH, head);
  const runsBefore = suiteRuns;
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'publish' } });
  assert.equal(result?.outcome, 'ready-for-qa', String(result?.error));
  assert.ok(suiteRuns > runsBefore, 'publish ran the suite on the fix');
  assert.equal(loaded(fixture).state, 'ready-for-qa');
  assert.equal(fixture.gh.pr()?.isDraft, false, 'the PR is marked ready');
  const resumed = fixture.readEvents().filter((event) => event.type === 'ticket_resumed');
  assert.deepEqual(
    resumed.map(({ run: resumedIn, ticket, human, vertex, head: tip }) => ({
      resumedIn,
      ticket,
      human,
      vertex,
      head: tip,
    })),
    [{ resumedIn: runFixture.lastRun(fixture), ticket: 15, human: 'octo-human', vertex: 'publish', head }],
  );
});

test('gg work resume refuses a Vertex the pinned Flow lacks', async (t) => {
  const fixture = await faulted(t);
  const before = loaded(fixture);
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'deploy' } });
  assert.equal(result?.outcome, 'fault');
  assert.match(String(result?.error), /Flow default has no Vertex deploy; its Vertices are red, green, publish/);
  assert.deepEqual(loaded(fixture), before, 'the record is kept');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_resumed').length, 0);
});

test('gg work resume refuses a Vertex whose required inputs were never produced, naming them', async (t) => {
  // red has no scripted response, so the Execution stops at its first Visit with no output saved.
  const fixture = await faulted(t, { responses: { [keys.responseKey('red', 1, 'red', 1)]: undefined } });
  const before = loaded(fixture);
  assert.deepEqual(before.outputs, [], 'no Visit produced an output');
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'publish' } });
  assert.match(
    String(result?.error),
    /Vertex publish needs the inputs report, red, green, which no Visit in the record/,
  );
  assert.deepEqual(loaded(fixture), before, 'the record is kept');
});

test('resume keeps the Visit and Action Cap counts', async (t) => {
  const green2 = goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.RIGHT_ADD });
  const fixture = await faulted(t, {
    responses: { [keys.responseKey('green', 2, 'green', 1)]: green2 },
    // red's route to green is a bounded Edge, so the first Run counts one traversal the resume must keep.
    configure: ({ options }) => {
      const flow = options.config.repository.flows.default as golden.ConfiguredFlow;
      flow.ticket.vertices.red!.route = { ok: { to: 'green', max: 2, exhausted: { end: 'needs-human' } } };
    },
  });
  const before = loaded(fixture);
  assert.ok(before.traversals.size > 0, 'the first Run counted an Edge');
  assert.deepEqual(Object.fromEntries(before.visits), { red: 1, green: 1 });
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.equal(result?.outcome, 'ready-for-qa', String(result?.error));
  const after = loaded(fixture);
  assert.deepEqual(Object.fromEntries(after.visits), { red: 1, green: 2, publish: 1 }, 'green is entered again');
  // Every Attempt of the resumed Run that counts toward the Action Cap (one with a Procedure) adds to the count kept.
  const resumedRun = runFixture.lastRun(fixture);
  const resumedAttempts = fixture
    .readEvents()
    .filter((event) => event.type === 'action' && event.run === resumedRun && event.procedure !== null).length;
  assert.equal(
    after.attempts,
    before.attempts + resumedAttempts,
    `the Action Cap count goes on from ${before.attempts}`,
  );
  assert.deepEqual(
    [...after.traversals].filter(([edge]) => before.traversals.has(edge)),
    [...before.traversals],
    'no Edge count is reset',
  );
});

test('gg work done resolves a Pending Ticket and takes down its Await Label', async (t) => {
  const asked = await approvalFlow.approvalFixture(t);
  await interpreter.runExecution(asked.options);
  assert.equal(asked.executionRecord.state, 'active', 'the Run left the Ticket Pending');
  assert.ok(asked.gh.labels.has(approvalFlow.AWAIT_LABEL), 'waiting on its Approval Request');
  // The person merged the Ticket's PR by hand.
  asked.gh.prs.get(golden.BRANCH)!.state = 'MERGED';
  await work.done({
    ticket: golden.TICKET,
    commonDir: asked.commonDir,
    cwd: asked.mainRoot,
    labelPrefix: 'gg',
    deps: { ...asked.options.deps, locks },
    close: false,
    log: () => {},
  });
  assert.equal(record.load(asked.commonDir, 'ticket', golden.TICKET)?.state, 'done');
  assert.ok(asked.gh.closed.has(golden.TICKET), 'the merged PR closes the issue');
  assert.ok(!asked.gh.labels.has(approvalFlow.AWAIT_LABEL), 'the Await Label comes down');
  assert.ok(asked.gh.labels.has('gg:state:done'));
});

const green2 = goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.RIGHT_ADD });
const openIntentMarkers = (fixture: runFixture.RunFixture) =>
  writeAhead.openIntents(loaded(fixture)).map((entry) => entry.actionMarker);

// A person's needs-human label abandons the Execution; gg work resume takes that label down, so the Run that resumes it
// must read the issue as it is after, not the read from before the resume.
test('gg work resume of a Ticket a person abandoned runs it, not abandons it again', async (t) => {
  const fixture = await faulted(t, { responses: { [keys.responseKey('green', 2, 'green', 1)]: green2 } });
  const executionRecord = loaded(fixture);
  // An active record with no label intent of gg's own, so the needs-human label reads as the person's.
  executionRecord.writeAheadLog = executionRecord.writeAheadLog.filter((entry) => entry.effect !== 'label');
  Object.assign(executionRecord, { state: 'active', terminalReason: null, terminalStop: null });
  record.save(executionRecord);
  fixture.gh.humanAddsLabel('gg:state:needs-human', 'the-owner');
  const [abandoned] = await run.runTarget(fixture.options);
  assert.equal(loaded(fixture).state, 'abandoned', `the person's label abandons it (${abandoned?.outcome})`);
  const calls = fixture.harness.calls.length;
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.equal(result?.outcome, 'ready-for-qa', String(result?.error));
  assert.ok(fixture.harness.calls.length > calls, 'the resumed green Visit ran');
});

// A Vertex's Visit Bound holds on a resume as it does on a route (L12: the bounds still hold).
test('gg work resume refuses a Vertex that has used its Visit Bound', async (t) => {
  const fixture = await faulted(t, {
    responses: { [keys.responseKey('green', 2, 'green', 1)]: green2 },
    configure: ({ options }) => {
      const flow = options.config.repository.flows.default as golden.ConfiguredFlow;
      Object.assign(flow.ticket.vertices.green!, { max: 1, exhausted: { end: 'needs-human' } });
    },
  });
  const before = loaded(fixture);
  const calls = fixture.harness.calls.length;
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.match(String(result?.error), /Vertex green has used its Bound of 1 Visit/);
  assert.deepEqual(loaded(fixture), before, 'the record is kept');
  assert.equal(fixture.harness.calls.length, calls, 'no agent ran');
});

// Each gg work done may deliver its report once more (#60), so a comment whose retries ran out is posted once GitHub
// recovers, not refused for good.
test('gg work done delivers a resolve comment whose retries ran out, once GitHub recovers', async (t) => {
  const fixture = await faulted(t);
  const github = { broken: true };
  for (let failure = 0; failure < 20; failure += 1)
    fixture.gh.fail({ matches: (args) => github.broken && fakeGh.isCommentPost(args), status: 502 });
  await assert.rejects(work.done(doneOptions(fixture, true)));
  assert.equal(loaded(fixture).state, 'fault', 'the record is kept');
  github.broken = false;
  await work.done(doneOptions(fixture, true));
  assert.equal(loaded(fixture).state, 'done');
  assert.equal(fixture.comments().filter((body) => body.includes('resolve-comment')).length, 1, 'one resolve comment');
});

// The close is repeatable: a rerun finishes a close whose call landed but whose evidence was never saved.
test('gg work done finishes a close that landed before its evidence', async (t) => {
  const views: Record<string, Record<string, unknown>> = {};
  const fixture = await faulted(t, { fixtureOptions: { issues: views } });
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'close', status: 404, afterEffect: true });
  await assert.rejects(work.done(doneOptions(fixture, true)));
  assert.ok(fixture.gh.closed.has(runFixture.TICKET), 'the close landed');
  views[String(runFixture.TICKET)] = { state: 'CLOSED' };
  await work.done(doneOptions(fixture, true));
  assert.equal(loaded(fixture).state, 'done');
  const closeIntents = writeAhead.openIntents(loaded(fixture)).filter((entry) => entry.effect === 'close');
  assert.deepEqual(closeIntents, [], 'no close intent is left open');
});

// The overridden intents are completed in the save that writes ticket_resumed, so a resume that fails before it keeps
// them open, and the next resume names them.
test('a resume that fails to take its labels down keeps the open intents for the next resume', async (t) => {
  const fixture = await faulted(t, { responses: { [keys.responseKey('green', 2, 'green', 1)]: green2 } });
  const open = openIntentMarkers(fixture);
  assert.equal(open.length, 1, 'the interrupted agent call');
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'edit', status: 502 });
  const [failed] = await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.match(String(failed?.error), /is not resumed/);
  assert.deepEqual(openIntentMarkers(fixture), open, 'the intent stays open');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_resumed').length, 0);
  await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  const resumed = fixture.readEvents().flatMap((event) => (event.type === 'ticket_resumed' ? [event.superseded] : []));
  assert.deepEqual(resumed, [open]);
});

test('gg work resume refuses a target with sub-issues', async (t) => {
  const fixture = runFixture.fixture(t, {
    responses: structuredClone(golden.firstVisitResponses),
    issues: epicRun.epicOf([runFixture.TICKET]),
  });
  await assert.rejects(
    run.runTarget({ ...fixture.options, target: epicRun.EPIC, resume: { vertex: 'publish' } }),
    /#20 has sub-issues; gg work resume takes one Ticket/,
  );
  assert.equal(fixture.harness.calls.length, 0, 'no agent ran');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_resumed').length, 0);
});

// The Effects no faulted Execution here lands with a finder, each with why: a resume overrides an Effect it cannot find
// (Q1 A), and these the test cannot land.
const UNLANDED: Record<string, string> = {
  push: 'the faulted Execution pushes nothing',
  'pr-upsert': 'the faulted Execution opens no PR',
  'pr-ready': 'no finder: safe to repeat, so a resume overrides it',
  close: 'no finder: safe to repeat, so a resume overrides it',
  rescue: 'the faulted Execution rescues nothing',
  reset: 'no finder: finished from the worktree, which a resume requires clean',
};

// Each Effect a stopped Execution landed but whose evidence was never saved is found again by resume, from GitHub and
// git as the stop left them, before the resume changes either.
test('resume finds every landed Effect whose evidence was never saved, and overrides none of them', async (t) => {
  const probe = loaded(await faulted(t));
  const landed = [
    ...new Set(
      probe.writeAheadLog
        .filter((entry) => entry.step === 'complete' && effects.lookup(entry.effect)?.find)
        .map((entry) => entry.effect!),
    ),
  ];
  assert.deepEqual(
    [...landed, ...Object.keys(UNLANDED)].sort(),
    effects
      .all()
      .map(({ name }) => name)
      .sort(),
    'every Effect is landed by the test or named with why it is not',
  );
  for (const effect of landed) {
    const fixture = await faulted(t);
    const executionRecord = loaded(fixture);
    const { actionMarker } = executionRecord.writeAheadLog.findLast(
      (entry) => entry.step === 'intent' && entry.effect === effect,
    )!;
    executionRecord.writeAheadLog = executionRecord.writeAheadLog.filter(
      (entry) => entry.actionMarker !== actionMarker || entry.step === 'intent',
    );
    record.save(executionRecord);
    await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
    const superseded = fixture
      .readEvents()
      .flatMap((event) => (event.type === 'ticket_resumed' ? event.superseded : []));
    assert.ok(!superseded.includes(actionMarker), `${effect}: not overridden`);
    assert.ok(writeAhead.evidenceOf(loaded(fixture), actionMarker), `${effect}: found again`);
  }
});

// A Ticket a person abandoned with a needs-human label: an active record with no label intent of gg's own, run once.
async function abandonedByPerson(t: TestContext, options: Faulting = {}) {
  const fixture = await faulted(t, options);
  const executionRecord = loaded(fixture);
  executionRecord.writeAheadLog = executionRecord.writeAheadLog.filter((entry) => entry.effect !== 'label');
  Object.assign(executionRecord, { state: 'active', terminalReason: null, terminalStop: null });
  record.save(executionRecord);
  fixture.gh.humanAddsLabel('gg:state:needs-human', 'the-owner');
  await run.runTarget(fixture.options);
  assert.equal(loaded(fixture).state, 'abandoned', "the person's label abandons it");
  return fixture;
}

// What gg work done is run on: a Ticket's repository, its fake gh and its deps.
// `run` is a later Run over the Ticket, as gg run would make it.
interface Resolvable {
  commonDir: string;
  mainRoot: string;
  gh: fakeGh.FakeGh;
  deps: runFixture.RunFixture['options']['deps'];
  run: () => Promise<unknown>;
}

// Every place a Ticket gg work done takes can come from, by the name its refusal gives it.
const ORIGINS: Record<string, (t: TestContext) => Promise<Resolvable>> = {
  ...Object.fromEntries(
    ['needs-human', 'needs-replan', 'held', 'fault'].map((state) => [
      state,
      async (t: TestContext) => {
        const fixture = await faulted(t);
        landedIn(fixture, state);
        return { ...fixture, deps: fixture.options.deps, run: () => run.runTarget(fixture.options) };
      },
    ]),
  ),
  abandoned: async (t) => {
    const fixture = await abandonedByPerson(t);
    return { ...fixture, deps: fixture.options.deps, run: () => run.runTarget(fixture.options) };
  },
  Pending: async (t) => {
    const asked = await approvalFlow.approvalFixture(t);
    await interpreter.runExecution(asked.options);
    asked.gh.prs.get(golden.BRANCH)!.state = 'MERGED';
    return { ...asked, deps: asked.options.deps, run: () => approvalFlow.laterRun(asked) };
  },
};

// Each resolve Action's gh write.
const RESOLVE_WRITES: Record<string, (args: string[]) => boolean> = {
  'resolve-comment': (args) => fakeGh.isCommentPost(args),
  'resolve-label': (args) => args[0] === 'issue' && args[1] === 'edit',
  'resolve-close': (args) => args[0] === 'issue' && args[1] === 'close',
};

const resolving = (source: Resolvable): work.DoneOptions => ({
  ticket: golden.TICKET,
  commonDir: source.commonDir,
  cwd: source.mainRoot,
  labelPrefix: 'gg',
  deps: { ...source.deps, locks },
  close: true,
  log: () => {},
});

// Each person's gg work done may deliver its report once more (#60): whatever the Ticket's origin, a resolve Action
// that failed until a done gave up is delivered by the next done once GitHub recovers.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('gg work done delivers each resolve Action of every origin once GitHub recovers, a Run between changing nothing', async (t) => {
  const active = await faulted(t);
  landedIn(active, 'active');
  const refusal = await work.done(doneOptions(active, true)).then(
    () => '',
    (err: Error) => err.message,
  );
  const taken = /takes a Ticket that is (.*), or (\w+)$/.exec(refusal)!;
  const origins = [...taken[1]!.split(/, | or /), taken[2]!];
  assert.deepEqual(origins.sort(), Object.keys(ORIGINS).sort(), 'every origin done takes has a case');
  for (const [origin, build] of Object.entries(ORIGINS))
    for (const [action, writes] of Object.entries(RESOLVE_WRITES)) {
      const source = await build(t);
      const github = { broken: true };
      for (let failure = 0; failure < 20; failure += 1)
        source.gh.fail({ matches: (args) => github.broken && writes(args), status: 502 });
      await assert.rejects(work.done(resolving(source)), `${origin} ${action}: the first done gives up`);
      github.broken = false;
      // A Run between the two leaves the Ticket as the failed done left it: no hold, no comment of its own.
      const state = record.load(source.commonDir, 'ticket', golden.TICKET)!.state;
      const posted = source.gh.comments.length;
      await source.run();
      assert.equal(
        record.load(source.commonDir, 'ticket', golden.TICKET)!.state,
        state,
        `${origin} ${action}: the Run`,
      );
      assert.equal(source.gh.comments.length, posted, `${origin} ${action}: the Run posts nothing`);
      await work.done(resolving(source));
      const executionRecord = record.load(source.commonDir, 'ticket', golden.TICKET)!;
      assert.equal(executionRecord.state, 'done', `${origin} ${action}`);
      const resolveComments = source.gh.comments.filter(({ body }) => body.includes(':resolve-comment:'));
      assert.equal(resolveComments.length, 1, `${origin} ${action}: one done comment`);
      const open = writeAhead
        .openIntents(executionRecord)
        .filter(({ actionMarker }) => actionMarker.includes(':done:'));
      assert.deepEqual(open, [], `${origin} ${action}: every resolve Action is complete`);
    }
});

// A Run over a Pending Ticket whose gg work done did not finish reads it as a decided report: a person's needs-human
// label still abandons it (request 3.5), and without one it stays Pending until done is run again.
for (const labelled of [false, true])
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`a Run over an unfinished gg work done ${labelled ? 'lets a needs-human label abandon it' : 'leaves it Pending'}`, async (t) => {
    const asked = await approvalFlow.approvalFixture(t);
    await interpreter.runExecution(asked.options);
    asked.gh.prs.get(golden.BRANCH)!.state = 'MERGED';
    const github = { broken: true };
    for (let failure = 0; failure < 20; failure += 1)
      asked.gh.fail({ matches: (args) => github.broken && fakeGh.isCommentPost(args), status: 502 });
    const source = { ...asked, deps: asked.options.deps, run: async () => {} };
    await assert.rejects(work.done(resolving(source)));
    github.broken = false;
    if (labelled) asked.gh.humanAddsLabel('gg:state:needs-human', 'the-owner');
    const posted = asked.gh.comments.length;
    await approvalFlow.laterRun(asked);
    const executionRecord = record.load(asked.commonDir, 'ticket', golden.TICKET)!;
    assert.equal(executionRecord.state, labelled ? 'abandoned' : 'active');
    assert.equal(asked.gh.comments.length, posted, 'no hold comment');
  });

// A comment that GitHub posted while the call reported a failure is found by the next gg work done, not posted again.
test('gg work done does not post a resolve comment twice when the first landed before its call failed', async (t) => {
  const fixture = await faulted(t);
  fixture.gh.fail({ matches: (args) => fakeGh.isCommentPost(args), status: 422, afterEffect: true });
  await assert.rejects(work.done(doneOptions(fixture, true)));
  await work.done(doneOptions(fixture, true));
  assert.equal(loaded(fixture).state, 'done');
  assert.equal(fixture.comments().filter((body) => body.includes(':resolve-comment:')).length, 1);
});

// A done that landed is not a decided report: later Runs leave it alone, labelled or not.
test('a Run leaves a Ticket gg work done resolved alone, even under a needs-human label', async (t) => {
  const fixture = await faulted(t);
  await work.done(doneOptions(fixture, true));
  fixture.gh.humanAddsLabel('gg:state:needs-human', 'the-owner');
  const posted = fixture.gh.comments.length;
  await run.runTarget(fixture.options);
  assert.equal(loaded(fixture).state, 'done');
  assert.equal(fixture.gh.comments.length, posted);
  assert.ok(!fixture.logs.some((line) => line.includes('did not finish')), fixture.logs.join('\n'));
});

// An unfinished gg work done has no saved stop, so a GitHub read that fails while a Run finishes it is that Run's
// fault for the Ticket, which stays as the done left it.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a Run that cannot read GitHub over an unfinished gg work done keeps the Ticket Pending, with no fault', async (t) => {
  const asked = await approvalFlow.approvalFixture(t);
  await interpreter.runExecution(asked.options);
  asked.gh.prs.get(golden.BRANCH)!.state = 'MERGED';
  const github = { broken: true };
  for (let failure = 0; failure < 20; failure += 1)
    asked.gh.fail({ matches: (args) => github.broken && fakeGh.isCommentPost(args), status: 502 });
  await assert.rejects(work.done(resolving({ ...asked, deps: asked.options.deps, run: async () => {} })));
  github.broken = false;
  asked.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'view', status: 502 });
  const result = await approvalFlow.laterRun(asked);
  assert.equal(result.outcome, 'pending');
  assert.equal(result.fault, undefined, 'a passing GitHub error is no fault');
  assert.equal(record.load(asked.commonDir, 'ticket', golden.TICKET)!.state, 'active');
});

// The person chose to override an interrupted agent Attempt, so resume says what to check first (Q1 A, ADR 0011).
test('gg work resume of an interrupted agent Attempt prints the advice to check its files first', async (t) => {
  const fixture = await faulted(t, { responses: { [keys.responseKey('green', 2, 'green', 1)]: green2 } });
  assert.equal(openIntentMarkers(fixture).length, 1, 'an interrupted agent call');
  await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.equal(fixture.logs.filter((line) => line.includes(reconcile.INTERRUPTED_ADVICE)).length, 1);
});

// A merged PR whose issue GitHub already closed needs no close: done records its end and closes nothing.
test('gg work done closes nothing when the issue is already closed', async (t) => {
  const views: Record<string, Record<string, unknown>> = {};
  const fixture = await faulted(t, { fixtureOptions: { issues: views } });
  prIn(fixture, 'MERGED');
  views[String(runFixture.TICKET)] = { state: 'CLOSED' };
  const text = await work.done(doneOptions(fixture));
  assert.equal(loaded(fixture).state, 'done');
  assert.ok(!fixture.gh.calls.some(({ args }) => args[0] === 'issue' && args[1] === 'close'), 'no close call');
  assert.equal(text, 'gg work done resolved Ticket 15 as done, decided by octo-human.\n');
});
