import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as exampleOnClaude from '../support/example-on-claude.ts';
import * as exampleRun from '../support/example-run.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';

// The example Flow's first-visit pass through the Claude Harness (#486), over recordings of real Claude calls that
// scripts/record-claude.ts made by running that pass through gg; the fake CLI replays them, and the example's test
// command runs for real over the changes they recorded (Q2 A). The over-the-fakes trace is
// test/unit/interpreter.example.test.ts's.
const advanced = (vertex: string, action: string) => ({ vertex, action, recovery: 0, attempt: 1, outcome: 'ok' });
const { launchProfile } = shipped.HARNESSES.claude;
// Its Actions and Visit ends, each Claim token ok, as the example's first-visit pass over the fakes takes them.
const FIRST_VISIT_PASS = [
  advanced('baseline', 'test'),
  golden.visitEnded('baseline', 'red'),
  advanced('red', 'red'),
  advanced('red', 'red-check'),
  advanced('red', 'commit'),
  golden.visitEnded('red', 'green'),
  advanced('green', 'green'),
  advanced('green', 'test'),
  advanced('green', 'commit'),
  advanced('green', 'push'),
  advanced('green', 'pr'),
  golden.visitEnded('green', 'reviewer'),
  advanced('reviewer', 'review'),
  advanced('reviewer', 'review-pass'),
  advanced('reviewer', 'repeat'),
  advanced('reviewer', 'comment'),
  advanced('reviewer', 'pr'),
  golden.visitEnded('reviewer', 'publish', { rule: { table: 'passed', row: 0 } }),
  advanced('publish', 'test'),
  advanced('publish', 'pr'),
  advanced('publish', 'pr-ready'),
  golden.visitEnded('publish', 'ready-for-qa'),
  advanced('ready-for-qa', 'end-comment'),
  advanced('ready-for-qa', 'end-label'),
];

test("golden: the example's first-visit pass runs through the Claude Harness over the recorded CLI", async (t) => {
  // Each stream it replays was recorded by scripts/record-claude.ts under the current launch profile
  assert.deepEqual(exampleOnClaude.RECORDINGS.map(exampleOnClaude.recordedUnder), [
    { scenario: 'example-red', launchProfile },
    { scenario: 'example-green', launchProfile },
    { scenario: 'example-review', launchProfile },
  ]);
  const ran = await exampleOnClaude.runOverRecordings(t);
  const saved = executionReads.loadTicket(ran);
  assert.deepEqual(golden.trace(ran.events), FIRST_VISIT_PASS);
  // Every agent Action ran on the Claude Harness, none on the fake one
  const agentEvents = exampleOnClaude.agentEvents(ran.events);
  assert.deepEqual(
    agentEvents.map(({ vertex, action, harness }) => ({ vertex, action, harness })),
    [
      { vertex: 'red', action: 'red', harness: 'claude' },
      { vertex: 'green', action: 'green', harness: 'claude' },
      { vertex: 'reviewer', action: 'review', harness: 'claude' },
    ],
  );
  // Every launch reached the fake CLI, which replayed the recordings in turn: no real claude ran
  assert.deepEqual(
    ran.calls.map((call) => call.recording),
    ['example-red', 'example-green', 'example-review'],
  );
  const [red, green, review] = exampleOnClaude.RECORDINGS.map(exampleOnClaude.recordedCall);
  // gg sent each call the schema it was recorded with; the Brief is not compared, so a Brief edit needs no new
  // recording (Q1 A)
  assert.deepEqual(
    ran.calls.map((call) => exampleOnClaude.schemaOf(call.argv)),
    [red!.schema, green!.schema, review!.schema],
  );
  // The Red Evidence is the real test command's, run over the test the red call wrote (Q2 A)
  assert.match(exampleRun.outputOf(saved, 'red', 'red-check')?.evidence?.output ?? '', /^ℹ duration_ms /m);
  // The Claims gg read back from Claude's structured output
  const responses = [
    exampleRun.outputOf(saved, 'red', 'red')?.response,
    exampleRun.outputOf(saved, 'green', 'green')?.response,
    exampleRun.outputOf(saved, 'reviewer', 'review')?.response,
  ];
  assert.deepEqual(responses, [red!.response, green!.response, review!.response]);
  // The Sessions saved, each with the transcript the CLI wrote
  assert.deepEqual(exampleOnClaude.savedSessions(saved), [
    { key: 'red/1/red', harness: 'claude', sessionId: red!.sessionId, transcript: red!.lines },
    { key: 'green/1/green', harness: 'claude', sessionId: green!.sessionId, transcript: green!.lines },
    { key: 'reviewer/1/review', harness: 'claude', sessionId: review!.sessionId, transcript: review!.lines },
  ]);
  // Usage on the Action Events, as each call's result line reported it
  assert.deepEqual(
    agentEvents.map((event) => exampleOnClaude.countsOf(event.usage.delta)),
    [red!.usage, green!.usage, review!.usage],
  );
});
