import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as exampleOnClaude from '../support/example-on-claude.ts';
import * as exampleOnCodex from '../support/example-on-codex.ts';
import * as exampleRun from '../support/example-run.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';

// The example Flow's first-visit pass through the Codex Harness (#482 Q1 A), over recordings of real Codex calls that
// scripts/record-codex.ts made by running that pass through gg, every example Agent on Codex (#481 declared
// workspace-write supported on win32); the fake CLI replays them, and the example's test command runs for real over
// the changes they recorded. The Claude sibling is interpreter.claude.test.ts.
const advanced = (vertex: string, action: string) => ({ vertex, action, recovery: 0, attempt: 1, outcome: 'ok' });
const { launchProfile } = shipped.HARNESSES.codex;
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

test("golden: the example's first-visit pass runs through the Codex Harness over the recorded CLI", async (t) => {
  // Each stream it replays was recorded by scripts/record-codex.ts under the current launch profile
  assert.deepEqual(exampleOnCodex.RECORDINGS.map(exampleOnCodex.recordedUnder), [
    { scenario: 'example-red', launchProfile },
    { scenario: 'example-green', launchProfile },
    { scenario: 'example-review', launchProfile },
  ]);
  const ran = await exampleOnCodex.runOverRecordings(t);
  const saved = executionReads.loadTicket(ran);
  assert.deepEqual(golden.trace(ran.events), FIRST_VISIT_PASS);
  // Every agent Action ran on the Codex Harness, none on the fake one
  const agentEvents = exampleOnClaude.agentEvents(ran.events);
  assert.deepEqual(
    agentEvents.map(({ vertex, action, harness }) => ({ vertex, action, harness })),
    [
      { vertex: 'red', action: 'red', harness: 'codex' },
      { vertex: 'green', action: 'green', harness: 'codex' },
      { vertex: 'reviewer', action: 'review', harness: 'codex' },
    ],
  );
  // Every launch reached the fake CLI, which replayed the recordings in turn: no real codex ran
  assert.deepEqual(
    ran.calls.map((call) => call.recording),
    ['example-red', 'example-green', 'example-review'],
  );
  const [red, green, review] = exampleOnCodex.RECORDINGS.map(exampleOnCodex.recordedCall);
  // gg sent each call the schema it was recorded with; the Brief is not compared, so a Brief edit needs no new
  // recording
  assert.deepEqual(
    ran.calls.map((call) => exampleOnCodex.schemaOf(call.argv)),
    [red!.schema, green!.schema, review!.schema],
  );
  // The Red Evidence is the real test command's, run over the test the red call wrote
  assert.match(exampleRun.outputOf(saved, 'red', 'red-check')?.evidence?.output ?? '', /^ℹ duration_ms /m);
  // The Claims gg read back from each call's final message (-o)
  const responses = [
    exampleRun.outputOf(saved, 'red', 'red')?.response,
    exampleRun.outputOf(saved, 'green', 'green')?.response,
    exampleRun.outputOf(saved, 'reviewer', 'review')?.response,
  ];
  assert.deepEqual(responses, [red!.response, green!.response, review!.response]);
  // The Sessions saved, each its thread with the rollout Codex wrote as its transcript
  assert.deepEqual(exampleOnClaude.savedSessions(saved), [
    { key: 'red/1/red', harness: 'codex', sessionId: red!.sessionId, transcript: red!.rollout },
    { key: 'green/1/green', harness: 'codex', sessionId: green!.sessionId, transcript: green!.rollout },
    { key: 'reviewer/1/review', harness: 'codex', sessionId: review!.sessionId, transcript: review!.rollout },
  ]);
  // Usage on the Action Events, as each call's last turn.completed reported it, with no cost (decision 3)
  assert.deepEqual(
    agentEvents.map((event) => exampleOnClaude.countsOf(event.usage.delta)),
    [red!.usage, green!.usage, review!.usage],
  );
});
