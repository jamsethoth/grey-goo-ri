import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type * as effectActions from '../../lib/effect-actions.ts';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import {
  actionEvent,
  actionMarker,
  branchMessages,
  headSha,
  intents,
  loadTicket,
  subjects,
  writeAheadSteps,
} from '../support/execution-reads.ts';
import {
  WRONG_ADD,
  greenFixture,
  greenWrites,
  runFirstVisit,
  terminalReasonOf,
  type GoldenRun,
} from '../support/golden-run.ts';
import * as actionSignals from '../support/action-signals.ts';
import * as firstVisit from '../support/first-visit.ts';
import * as keys from '../support/keys.ts';
import * as suiteRuns from '../support/suite-runs.ts';

const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const RED_RECOVERY = keys.responseKey('red', 1, 'recover', 1);
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);

// A write-ahead intent with the payload its effect saves.
type Intent<Payload> = writeAhead.WriteAheadEntry & { payload: Payload };
type PrPayload = { branch: string; base: string; title: string; body: string; bodyHash: string };

const DONE = ['intent', 'evidence', 'complete'];

// Each agent Attempt is write-ahead too, its intent carrying the baseline the Integrity Assertion compares against,
// which a resume reads back from the State Database.
async function assertCallIntents(fixture: GoldenRun) {
  const calls = intents(fixture.executionRecord, 'call') as Intent<{ baseline: { head: string } }>[];
  assert.deepEqual(
    calls.map((call) => call.actionMarker),
    [actionMarker(fixture, 'red', 'red'), actionMarker(fixture, 'green', 'green')],
  );
  const saved = intents(loadTicket(fixture), 'call') as Intent<{ baseline: { head: string } }>[];
  assert.deepEqual(
    saved.map((call) => call.payload.baseline),
    calls.map((call) => call.payload.baseline),
    'each baseline reads back as it was taken',
  );
  assert.equal(saved[0].payload.baseline.head, fixture.base, 'red compares against the base');
}

// The commit, push and pr-upsert intents carry their full payloads, and their evidence what landed.
async function assertEffectIntents(fixture: GoldenRun) {
  const commits = intents(fixture.executionRecord, 'commit') as Intent<effectActions.CommitPayload>[];
  assert.equal(commits.length, 2);
  assert.deepEqual(Object.keys(commits[0].payload).sort(), ['message', 'parent', 'tree']);
  assert.ok(commits[0].payload.message.includes(`Gg-Action: ${commits[0].actionMarker}`), commits[0].payload.message);
  assert.deepEqual(Object.keys(commits[1].payload).sort(), ['message', 'parent', 'tree']);
  assert.ok(commits[1].payload.message.includes(`Gg-Action: ${commits[1].actionMarker}`), commits[1].payload.message);
  const head = await headSha(fixture);
  const evidenceOf = (actionMarker: string) =>
    fixture.executionRecord.writeAheadLog.find(
      (entry) => entry.actionMarker === actionMarker && entry.step === 'evidence',
    )!.evidence!;
  assert.equal(evidenceOf(commits[1].actionMarker).sha, head);

  const [push] = intents(fixture.executionRecord, 'push');
  assert.deepEqual(push.payload, { branch: golden.BRANCH, sha: head });
  assert.equal(evidenceOf(push.actionMarker).remoteSha, head);

  // publish's re-render is the PR body GitHub shows.
  const pr = intents(fixture.executionRecord, 'pr-upsert').at(-1) as Intent<PrPayload>;
  assert.equal(pr.payload.branch, golden.BRANCH);
  assert.equal(pr.payload.base, 'main');
  assert.equal(pr.payload.title, 'Add two numbers');
  assert.equal(pr.payload.body, fixture.gh.pr()!.body, 'the PR intent holds the body itself');
  assert.equal(typeof pr.payload.bodyHash, 'string');
  assert.deepEqual(evidenceOf(pr.actionMarker), { number: 7, url: 'https://github.com/o/r/pull/7' });
  return head;
}

test('every side-effect action leaves intent, evidence and completion with the full payload', async (t) => {
  const fixture = await runFirstVisit(t);
  assert.deepEqual(
    fixture.executionRecord.writeAheadLog
      .filter((entry) => entry.step === 'intent')
      .map((intent) => [intent.effect, writeAheadSteps(fixture.executionRecord, intent.actionMarker)]),
    [
      ['call', DONE],
      ['commit', DONE],
      ['call', DONE],
      ['commit', DONE],
      ['push', DONE],
      ['pr-upsert', DONE],
      ['pr-upsert', DONE],
      ['pr-ready', DONE],
      ['comment', DONE],
      ['label', DONE],
    ],
  );
  assert.deepEqual(writeAhead.openIntents(fixture.executionRecord), []);
  await assertCallIntents(fixture);
  const head = await assertEffectIntents(fixture);

  // pr-ready's saved target: the pushed commit and the tree publish's Check passed on.
  assert.deepEqual(
    intents(fixture.executionRecord, 'pr-ready').map((intent) => intent.payload),
    [{ number: 7, sha: head, tree: await fixture.options.deps.git.treeOf(fixture.worktree, head) }],
  );

  assert.deepEqual(
    intents(fixture.executionRecord, 'label').map((intent) => intent.payload),
    [{ ticket: golden.TICKET, add: ['gg:state:ready-for-qa'], remove: ['gg:state:in-progress'] }],
    'the ready-for-qa label write goes through the log',
  );
});

// The fields of a harness call the case keeps of each phase.
type Seen = { agent: { model: string; effort: string }; access: string; persona: { bytes: string } };

// green's agent changes everything it can reach mid-Visit: the Flow's Vertex, the commands, the testPaths, its own
// call and the Persona file. Returns what each phase's call carried.
function changeMidVisit(fixture: golden.GoldenFixture): Record<string, Seen> {
  const vertex = fixture.flow.ticket.vertices.get('green') as unknown as Record<string, unknown> & {
    agent: { model: string };
  };
  const run = fixture.harness.run;
  const seen: Record<string, Seen> = {};
  fixture.harness.run = async (call) => {
    const { phase, agent, access, persona } = call as unknown as Seen & { phase: string };
    seen[phase] = structuredClone({ agent, access, persona });
    if (phase === 'green') {
      vertex.agent.model = 'model-y';
      vertex.access = 'read-only';
      // Routing, Procedure and Declared Commands are pinned too: none of these may reach the rest of the Visit.
      vertex.procedure = 'fix';
      vertex.route = { ok: { end: 'needs-human' } };
      fixture.options.commands.test = 'npm run other';
      fixture.options.testPaths.push('lib/**');
      agent.effort = 'low';
      fixture.files['implementer.md'] = golden.layerFile('# changed\n');
    }
    return run(call);
  };
  return seen;
}

// green's Visit has two calls when the first fails the Green Check: green, then its recovery pass.
test('the visit keeps the configuration pinned at entry when the agent changes mid-visit', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
    },
  });
  fixture.options.testPaths = ['test/**'];
  const commands: string[] = [];
  // green's own snapshot, as its last Check saw it: publish pins its own after.
  let pinned = null as visit.ConfigurationSnapshot | null;
  suiteRuns.editRuns(fixture, (result, command) => {
    commands.push(command);
    if (fixture.executionRecord.cursor.vertex === 'green')
      pinned = structuredClone(fixture.executionRecord.configurationSnapshot);
    return result;
  });
  const seen = changeMidVisit(fixture);
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.deepEqual(seen.recover, seen.green);
  assert.equal(seen.recover!.agent.model, 'model-x');
  assert.equal(seen.recover!.access, 'workspace-write');
  assert.equal(seen.recover!.persona.bytes, golden.PERSONA);
  assert.equal(pinned!.agent!.effort, 'high', 'a harness mutating its call does not reach the snapshot');
  assert.equal(pinned!.access, 'workspace-write');
  assert.match((await branchMessages(fixture)).at(-1)!, /Gg-Vertex: green fake\/model-x\/high/);
  assert.equal(outcome, 'ready-for-qa', 'routing follows the entry snapshot');
  assert.deepEqual(
    [
      ...new Set(
        fixture
          .readEvents()
          .filter((event): event is events.ActionEvent => event.type === 'action' && event.vertex === 'green')
          .map((event) => event.procedure),
      ),
    ],
    ['implement'],
  );
  assert.deepEqual(
    commands,
    ['npm test', 'npm test', 'npm test', 'npm run other'],
    "green's Checks ran its pinned command; publish pins the edited one",
  );
  assert.deepEqual(pinned!.route, { ok: 'publish' });
  assert.equal(pinned!.commands.test, 'npm test');
  assert.deepEqual(pinned!.testPaths, ['test/**']);
});

test('the red commit records a non-ASCII test path unquoted', async (t) => {
  const responses = firstVisit.firstVisitWith();
  const red = responses[RED_CALL];
  red.files = { 'test/añadir.test.mjs': red.files!['test/add.test.mjs'] };
  const fixture = await golden.fixture(t, { responses });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(
    fixture.executionRecord.outputs.find((output) => output.vertex === 'red' && output.action === 'commit')!.value
      .files,
    ['test/añadir.test.mjs'],
  );
});

test('ready-for-qa removes in-progress and adds its label', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.labels.add('gg:state:in-progress');
  await interpreter.runExecution(fixture.options);

  assert.equal(fixture.gh.pr()!.number, 7);
  assert.equal(fixture.gh.pr()!.isDraft, false, 'PR 7 is ready');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:ready-for-qa']);
  const end = fixture.readEvents().find((event): event is events.TicketEndEvent => event.type === 'ticket_end')!;
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.execution, fixture.executionRecord.execution);
  assert.equal(end.run, fixture.executionRecord.run);
  assert.ok(end.diffStats, 'ticket_end carries diff stats');
  assert.equal(end.diffStats!.testFiles, 1);
});

test('ready-for-qa counts the files under the pinned testPaths as tests in its diff stats', async (t) => {
  const responses = firstVisit.firstVisitWith();
  responses[RED_CALL].files!['checks/add.mjs'] = "import { add } from '../lib/add.mjs';\n";
  const fixture = await golden.fixture(t, { responses });
  fixture.options.testPaths = ['test/**', 'checks/**'];
  await interpreter.runExecution(fixture.options);

  const end = fixture.readEvents().find((event): event is events.TicketEndEvent => event.type === 'ticket_end')!;
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.diffStats!.files, 3);
  assert.equal(
    end.diffStats!.testFiles,
    2,
    'checks/add.mjs counts as a test because the pinned testPaths name checks/',
  );
});

test('golden: a blocked claim with passing tests stops at needs-human', async (t) => {
  const responses = firstVisit.firstVisitWith();
  responses[GREEN_CALL].response = {
    ...golden.greenResponse,
    claim: 'blocked',
    diagnosis: 'The ticket contradicts itself.',
  };
  const fixture = await golden.fixture(t, { responses });
  fixture.gh.labels.add('gg:state:in-progress');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.gh.comments.length, 1, 'exactly one blocked comment');
  const [comment] = fixture.gh.comments;
  assert.equal(comment!.target, 'issue');
  assert.equal(comment!.number, golden.TICKET);
  assert.match(comment!.body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.equal(intents(fixture.executionRecord, 'comment').length, 1, 'the comment goes through the write-ahead log');
  assert.deepEqual(await subjects(fixture), ['test: Add two numbers (#15)'], 'no feat commit');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human'], 'needs-human replaces in-progress');

  const check = actionEvent(fixture, 'green', 'test');
  assert.ok(check, 'the Green Check runs and is recorded');
  assert.equal(actionSignals.signalsOf(check!).claim.token, 'blocked');
  assert.deepEqual(
    actionSignals.signalsOf(check!).checks.map((signal) => [signal.id, signal.state]),
    [['test', 'passed']],
  );
  assert.deepEqual(check!.rule, { table: 'stopped', row: null });
  assert.equal(check!.outcome, 'blocked');

  // The blocked comment carries the Terminal Reason, so there is still exactly one comment.
  const reason = terminalReasonOf(fixture, { comment: false });
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 0 });
  assert.equal(reason.outcome, 'blocked');
  assert.deepEqual(reason.rule, { table: 'stopped', row: null });
  assert.equal(reason.text, 'The agent made a blocked Claim at green; its diagnosis in the blocked comment says why.');
  assert.ok(!reason.text.includes('contradicts'), 'unfenced agent text stays out of the Terminal Reason');
  assert.ok(comment!.body.includes(`**Terminal Reason:** ${reason.text}`), comment!.body);
});

test(
  "agent-reported test names stay out of a failed red's Terminal Reason " + 'and are fenced in its comment',
  async (t) => {
    const responses = firstVisit.firstVisitWith();
    const injected = 'missing\n\n## injected heading';
    responses[RED_CALL] = { ...responses[RED_CALL], response: { ...golden.redResponse, tests: [injected] } };
    responses[RED_RECOVERY] = { files: {}, response: { ...golden.redResponse, tests: [injected] } };
    const fixture = await golden.fixture(t, { responses });
    await interpreter.runExecution(fixture.options);

    const reason = terminalReasonOf(fixture);
    assert.equal(reason.outcome, 'failed');
    assert.ok(!reason.text.includes('injected'), reason.text);
    const [comment] = fixture.gh.comments;
    assert.ok(!/^## injected heading$/m.test(comment!.body), 'the diagnosis cannot render as markdown');
    assert.ok(comment!.body.includes('injected heading'), 'the diagnosis is still posted, fenced');
  },
);

test(
  'the Terminal Reason is saved before any Terminal side effect, ' + 'so a crash posting the end comment keeps it',
  async (t) => {
    const fixture = await golden.fixture(t);
    // A CrashError, since any other throw is now an unexpected fault handled inside runExecution.
    fixture.options.deps.gh = {
      ...fixture.options.deps.gh,
      comment: async () => {
        throw new interpreter.CrashError('crash');
      },
    };
    await assert.rejects(
      interpreter.runExecution(fixture.options),
      (err: unknown) => err instanceof interpreter.CrashError,
    );

    const saved = record.load(fixture.commonDir, 'ticket', golden.TICKET)!;
    assert.equal(saved.cursor.vertex, 'ready-for-qa');
    assert.equal(saved.terminalReason?.outcome, 'ok');
    assert.match(saved.terminalReason!.text, new RegExp(`PR #${saved.pr} is ready for review\\.$`));
  },
);

test('ready-for-qa carries a Terminal Reason naming the passed Checks and the ready PR', async (t) => {
  const fixture = await runFirstVisit(t);
  const reason = terminalReasonOf(fixture);
  assert.deepEqual(reason.decidedBy, { vertex: 'publish', visit: 1, action: 'pr-ready', recovery: 0 });
  assert.equal(reason.outcome, 'ok');
  assert.deepEqual(reason.rule, { table: 'passed', row: null }, 'no passed row matched, so the token ok');
  assert.equal(
    reason.text,
    'publish visit 1 completed every publish Action: test passed. ' +
      `PR #${fixture.executionRecord.pr} is ready for review.`,
  );
});

// ff's red-gate e2e cases on the fake harness: red writes test/fail.test.mjs, the runner answers with `run`,
// and green writes lib/add.mjs, after which the suite passes. A recoverable failure's recovery pass changes nothing.
async function redGate(t: TestContext, { tests, run }: { tests: string[]; run: { code: number; output: string } }) {
  const responses = firstVisit.firstVisitWith({
    [RED_CALL]: {
      files: { 'test/fail.test.mjs': "import assert from 'node:assert';\nassert.fail('rejects bad input');\n" },
      response: { ...golden.redResponse, tests },
    },
    [RED_RECOVERY]: { files: {}, response: { ...golden.redResponse, tests } },
  });
  const fixture = await golden.fixture(t, { responses });
  suiteRuns.answerAll(fixture, (_command, options) =>
    existsSync(join(options?.cwd ?? fixture.worktree, 'lib', 'add.mjs'))
      ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false }
      : { timedOut: false, ...run },
  );
  return { ...fixture, result: await interpreter.runExecution(fixture.options) };
}

const FAIL_OUTPUT = 'not ok 1 - rejects bad input\n# fail 1';

test('a red run whose runner cannot start is not committed and fails with the reason', async (t) => {
  const fixture = await redGate(t, {
    tests: ['rejects bad input'],
    run: { code: 127, output: 'ff-no-such-runner-xyz: command not found' },
  });
  assert.deepEqual(await subjects(fixture), [], 'no test: commit');
  const check = actionEvent(fixture, 'red', 'red-check');
  assert.equal(check!.outcome, 'failed');
  assert.deepEqual(check!.rule, { table: 'failed', row: null }, 'a runner that cannot start is not recovered');
  assert.match(fixture.gh.comments[0].body, /```\nThe test runner could not start/, 'the reason is posted fenced');
});

test('a red run whose output names none of the reported tests is not committed', async (t) => {
  const fixture = await redGate(t, { tests: ['some other test'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.deepEqual(await subjects(fixture), [], 'no test: commit');
  assert.equal(actionEvent(fixture, 'red', 'red-check')!.outcome, 'recover', 'missing names are recoverable (N5)');
  assert.equal(actionEvent(fixture, 'red', 'red-check', 1)!.outcome, 'failed');
  assert.match(fixture.gh.comments[0].body, /does not mention any reported failing test/);
});

test('a red run with a nonzero exit naming a reported test is committed as test:', async (t) => {
  const fixture = await redGate(t, { tests: ['rejects bad input'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.deepEqual(await subjects(fixture), ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)']);
  assert.ok(
    !fixture
      .readEvents()
      .some((event) => event.type === 'action' && (event as events.ActionEvent).outcome === 'failed'),
  );
  assert.deepEqual(fixture.executionRecord.history, []);
});
