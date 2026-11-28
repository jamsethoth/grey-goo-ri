import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shipped from '../../lib/harnesses/shipped.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as codexOverFakeCli from '../support/codex-over-fake-cli.ts';
import * as exampleOnClaude from '../support/example-on-claude.ts';
import * as exampleOnCodex from '../support/example-on-codex.ts';
import * as exampleRun from '../support/example-run.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';

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

// #485: past its contextBudget a Codex agent hands off, and the next Attempt of its Action starts a fresh thread with
// the note. A stand-in, not a recording (Q2 A): green's first call replays example-green with its final message changed
// to a handed-off answer, its second the recording with an empty note; the hook's firing is recorded (`hooks-on`). A
// Codex successor gets the note only, no gg ask-session line: inside MXC the nested codex fork it would start cannot
// write gg's Codex home (Q1 B, probes/485/record-1 `fork-in-mxc-read-only`, `fork-in-mxc-workspace`).
const NOTE = 'index.js is written; run the test command and report what it says.';
const GREEN_CALLS = { handedOff: 1, finishing: 2 };

test('the Attempt after a hand-off starts a fresh thread carrying the note', async (t) => {
  const fake = codexOverFakeCli.codexOverFakeCli(t, {
    scenario: ['example-red', 'example-green', 'example-green', 'example-review'],
    spaced: false,
    lastMessage: (recorded, call) => {
      const response = JSON.parse(recorded) as Record<string, unknown>;
      if (call === GREEN_CALLS.handedOff) return JSON.stringify({ ...response, claim: 'handed-off', handoff: NOTE });
      return call === GREEN_CALLS.finishing ? JSON.stringify({ ...response, handoff: '' }) : recorded;
    },
  });
  const fixture = await exampleOnCodex.codexFixture(t, fake.harness as unknown as runContext.Harness);
  // The validator admits a Codex Agent with a contextBudget, which the hand-off hook enforces
  assert.doesNotThrow(() =>
    golden.configure(fixture, (configured) => {
      configured.agents.budgeted = Object.assign({ ...configured.agents.implementer! }, { contextBudget: 150000 });
      configured.flows.default!.ticket.vertices.green!.use = 'budgeted';
    }),
  );
  const ran = await goldenRun.ranToEnd(fixture);
  const calls = fake.calls();

  assert.equal(ran.result.outcome, 'ready-for-qa', JSON.stringify(ran.result));
  assert.deepEqual(
    calls.map((call) => call.recording),
    ['example-red', 'example-green', 'example-green', 'example-review'],
  );
  const [, first, next] = calls;
  assert.ok(!next!.argv.includes('resume'), `the next Attempt starts a fresh thread: ${JSON.stringify(next!.argv)}`);
  assert.ok(next!.stdin.includes(NOTE), 'its prompt carries the note');
  assert.ok(!first!.stdin.includes(NOTE));
  assert.ok(!next!.stdin.includes('gg ask-session'), 'a Codex successor is given no gg ask-session line (Q1 B)');
  const saved = executionReads.loadTicket(ran);
  const green = saved.sessions['green/1/green'];
  assert.deepEqual(
    green?.handedOff?.map(({ attempt }) => attempt),
    [1],
    'the handed-off thread stays on the record',
  );
});
