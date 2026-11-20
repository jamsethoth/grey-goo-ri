import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import type * as referencePaths from '../../lib/reference-paths.ts';
import { attemptsOf, loadTicket } from '../support/execution-reads.ts';
import type * as fakeHarness from '../support/fake-harness.ts';
import * as golden from '../support/golden.ts';
import { RIGHT_ADD, WRONG_ADD, greenFixture, stopReason } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';

// Past its contextBudget an agent ends its Attempt handed off, with a note of what remains; the next Attempt of the
// same Action starts a fresh Session with that note, and the handed-off Session stays on the record (#430).

const GREEN = { vertex: 'green', visit: 1, action: 'green' };
const greenAt = (attempt: number, recovery = 0) => keys.responseKey({ ...GREEN, attempt, recovery });
const GREEN_RETRIES = keys.retryKey({ ...GREEN, recovery: 0 });
const GREEN_SESSION = keys.sessionKey(GREEN);
const NOTE = 'lib/add.mjs is written; run the suite and report what it says.';

// A budgeted Agent's answer carries the hand-off note, empty unless it hands off.
const handOff = (note: string): fakeHarness.ScriptedResponse => ({
  files: {},
  response: { ...golden.greenResponse, claim: 'handed-off', handoff: note },
});
const finishing = (add: string): fakeHarness.ScriptedResponse => ({
  files: { 'lib/add.mjs': add },
  response: { ...golden.greenResponse, handoff: '' },
});

// The golden Execution with green on an Agent of its own whose contextBudget is set; red keeps the implementer, which
// has none.
async function budgetedFixture(t: TestContext, responses: fakeHarness.ScriptedResponses) {
  const fixture = await greenFixture(t, { responses });
  golden.configure(fixture, (configured) => {
    const budgeted = { ...configured.agents.implementer!, contextBudget: 150000 };
    configured.agents.budgeted = budgeted;
    configured.flows.golden!.ticket.vertices.green!.use = 'budgeted';
  });
  return fixture;
}

// green's agent Attempts, each with its Session.
const greenCalls = (fixture: golden.GoldenFixture) =>
  attemptsOf(fixture, 'green', 'green').filter((event): event is events.AgentActionEvent => 'sessionId' in event);
const rowsOf = (fixture: golden.GoldenFixture) =>
  attemptsOf(fixture, 'green', 'green').map((event) => [event.attempt, event.rule.row]);

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('an agent past its context budget hands off and the next Attempt starts a fresh Session with the note', async (t) => {
  const fixture = await budgetedFixture(t, { [greenAt(1)]: handOff(NOTE), [greenAt(2)]: finishing(RIGHT_ADD) });
  const result = await interpreter.runExecution(fixture.options);

  assert.deepEqual(rowsOf(fixture)[0], [1, 'handed-off'], 'the first Attempt hands off');
  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.equal(fixture.harness.calls.length, 3, 'red, then green twice');
  const [, first, next] = fixture.harness.calls;
  assert.equal(next!.resume, null, 'the next Attempt starts a fresh Session');
  assert.ok(next!.brief!.startsWith('GREEN PHASE'), "it gets the Action's own Brief");
  assert.ok(next!.brief!.includes(NOTE), 'with the note');
  assert.ok(!first!.brief!.includes(NOTE));
  assert.deepEqual(fixture.executionRecord.retries[GREEN_RETRIES], { handoff: 1 }, 'the hand-off spends its budget');
});

test('the handed-off Session stays on the record', async (t) => {
  const fixture = await budgetedFixture(t, {
    [greenAt(1)]: handOff('the test file is read; write lib/add.mjs.'),
    [greenAt(2)]: handOff(NOTE),
    [greenAt(3)]: finishing(RIGHT_ADD),
  });
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(rowsOf(fixture).slice(0, 2), [
    [1, 'handed-off'],
    [2, 'handed-off'],
  ]);
  const attempts = greenCalls(fixture);
  assert.deepEqual(
    attempts.map((event) => [event.sessionId, event.sessionLineage]),
    [
      ['fake-session-2', null],
      ['fake-session-3', 'fake-session-2'],
      ['fake-session-4', 'fake-session-3'],
    ],
    'each Attempt after a hand-off runs a fresh Session, naming the one it took over from',
  );
  const saved = loadTicket(fixture).sessions[GREEN_SESSION]!;
  assert.deepEqual(
    saved.handedOff,
    attempts.slice(0, 2).map((event) => ({
      sessionId: event.sessionId,
      transcriptPath: event.transcriptPath,
      cumulativeUsage: event.usage.cumulative,
      attempt: event.attempt,
    })),
    'every handed-off Session, oldest first',
  );
  assert.equal(saved.sessionId, 'fake-session-4', 'a recovery pass resumes the fresh Session');
});

test('a hand-off counts against the Action Cap', async (t) => {
  const fixture = await budgetedFixture(t, { [greenAt(1)]: handOff(NOTE), [greenAt(2)]: finishing(RIGHT_ADD) });
  // red's three Actions and green's first Attempt are the four Attempts of a cap of 4.
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.actionCap = 4;
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.deepEqual(rowsOf(fixture), [[1, 'handed-off']], 'the Attempt after the hand-off never runs');
  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(fixture.harness.calls.length, 2);
  const reason = stopReason(fixture, {
    vertex: 'green',
    action: 'green',
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'action-cap' },
  });
  assert.equal(reason.text, 'The Execution reached its Action Cap of 4 Attempts, so green at green did not run.');
});

test('a fourth hand-off of one Action spends its budget of 3 and ends at harness-handoff', async (t) => {
  const fixture = await budgetedFixture(
    t,
    Object.fromEntries([1, 2, 3, 4].map((attempt) => [greenAt(attempt), handOff(`note ${attempt}`)])),
  );
  const result = await interpreter.runExecution(fixture.options);

  assert.deepEqual(rowsOf(fixture), [
    [1, 'handed-off'],
    [2, 'handed-off'],
    [3, 'handed-off'],
    [4, 'handoff-exhausted'],
  ]);
  assert.equal(result.outcome, 'needs-human', 'unrouted, it ends at needs-human');
  stopReason(fixture, {
    vertex: 'green',
    action: 'green',
    outcome: 'harness-handoff',
    rule: { table: 'fixed', row: 'handoff-exhausted' },
  });
  assert.deepEqual(fixture.executionRecord.retries[GREEN_RETRIES], { handoff: 3 });
});

// Every call is checked, whichever kind of Attempt made it: the first, a retry and a recovery pass of the budgeted
// green, and red's, whose Agent has no contextBudget.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('every call of an Agent with a contextBudget is sent the hand-off Claim, and no other Agent call is', async (t) => {
  const fixture = await budgetedFixture(t, {
    [greenAt(1)]: { files: {}, response: null },
    [greenAt(2)]: finishing(WRONG_ADD),
    [greenAt(1, 1)]: finishing(RIGHT_ADD),
  });
  await interpreter.runExecution(fixture.options);

  const calls = fixture.harness.calls.map((call) => ({ ...marker.partsOf(call.marker), call }));
  for (const { vertex, attempt, recovery, call } of calls) {
    const schema = call.schema as referencePaths.SchemaNode;
    const site = `${vertex} attempt ${attempt} recovery ${recovery}`;
    const budgeted = vertex === 'green';
    assert.equal(schema.properties?.claim?.enum?.includes('handed-off'), budgeted, `${site}: the handed-off token`);
    assert.equal(Object.hasOwn(schema.properties ?? {}, 'handoff'), budgeted, `${site}: the handoff note`);
  }
  assert.deepEqual(
    calls.map(({ vertex, attempt, recovery }) => `${vertex}/${recovery}/${attempt}`),
    ['red/0/1', 'green/0/1', 'green/0/2', 'green/1/1'],
    "red's call, then green's first Attempt, its parse retry and its recovery pass",
  );
});

// Q1 A: the new agent asks the handed-off Session through gg ask-session, which its Brief names with the Session and
// its permission rules allow only once there is a handed-off Session to ask; the Claude Harness resolves the rules.
test('the Attempt after a hand-off may ask the handed-off Session through gg ask-session', async (t) => {
  const fixture = await budgetedFixture(t, { [greenAt(1)]: handOff(NOTE), [greenAt(2)]: finishing(RIGHT_ADD) });
  const { resolveTools } = claude.createClaude({ configDirectory: join('no-claude-home') });
  fixture.harness.resolveTools = (agent, context) =>
    resolveTools(agent, context ?? { commands: {}, platform: process.platform });
  await interpreter.runExecution(fixture.options);

  const [, first, next] = fixture.harness.calls;
  const asks = (tools: unknown) =>
    (tools as claude.ClaudeTools).allow.filter((rule) => rule.endsWith('(gg ask-session:*)'));
  assert.deepEqual(asks(first!.tools), [], 'before a hand-off there is no Session to ask');
  assert.equal(asks(next!.tools).length, 1, JSON.stringify(next!.tools));
  assert.ok(next!.brief!.includes('gg ask-session fake-session-2'), 'the Brief names the command and the Session');
});
