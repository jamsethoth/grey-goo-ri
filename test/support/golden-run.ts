// The golden Execution run through the interpreter, and how it ended. `runFirstVisit` runs it; `greenFixture` builds a
// golden fixture whose suite checks the sum and runs nothing.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as executionReads from './execution-reads.ts';
import type * as fakeHarness from './fake-harness.ts';
import * as addSuite from './add-suite.ts';
import * as golden from './golden.ts';

type GoldenFixture = golden.GoldenFixture;

export const TDD_VERTICES = ['red', 'green'];

export const FIRST_VISIT = [
  ['red', 'red'],
  ['red', 'red-check'],
  ['red', 'commit'],
  ['green', 'green'],
  ['green', 'test'],
  ['green', 'commit'],
  ['green', 'push'],
  ['green', 'pr'],
].map(([vertex, action]) => ({ vertex, action, recovery: 0, attempt: 1, outcome: 'ok' }));

// The golden fixture once its Execution has run: what runExecution returned, and the Events it left.
export type GoldenRun = GoldenFixture & {
  result: Awaited<ReturnType<typeof interpreter.runExecution>>;
  events: ReturnType<GoldenFixture['readEvents']>;
};

// Runs the fixture's Execution to its Terminal.
export async function ranToEnd(fixture: GoldenFixture): Promise<GoldenRun> {
  const result = await interpreter.runExecution(fixture.options);
  return { ...fixture, result, events: fixture.readEvents() };
}

// Builds the golden fixture and runs its Execution.
export async function runFirstVisit(t: TestContext, options?: golden.GoldenOptions): Promise<GoldenRun> {
  return ranToEnd(await golden.fixture(t, options));
}

// The Terminal Reason must agree in the record and on ticket_end, and (unless the caller checks its own comment) be
// posted once on the ticket, write-ahead, with the comment's Action Marker.
export function terminalReasonOf(fixture: GoldenFixture, { comment = true } = {}) {
  const reason = fixture.executionRecord.terminalReason;
  assert.ok(reason, 'the record holds a Terminal Reason');
  const ticketEnd = fixture.readEvents().at(-1) as { terminalReason?: unknown };
  assert.deepEqual(ticketEnd.terminalReason, reason, 'ticket_end carries the same Terminal Reason');
  assert.equal(typeof reason.text, 'string');
  if (comment) {
    const posted = fixture.gh.comments.filter((posts) => posts.body.includes(`**Terminal Reason:** ${reason.text}`));
    assert.equal(posted.length, 1, 'the Terminal Reason is posted once');
    assert.match(posted[0]?.body ?? '', /^<!-- gg-action gg:\S+ -->$/m);
    assert.equal(executionReads.intents(fixture.executionRecord, 'comment').length, 1, 'through the write-ahead log');
  }
  return reason;
}

// A stop's Terminal Reason names the deciding Action, that Action's Outcome and rule, and a sentence of its own.
export function stopReason(
  fixture: GoldenFixture,
  {
    vertex,
    action,
    recovery = 0,
    outcome,
    rule,
    comment,
  }: { vertex: string; action: string; recovery?: number; outcome: string; rule: unknown; comment?: boolean },
) {
  const reason = terminalReasonOf(fixture, { comment });
  assert.deepEqual(reason.decidedBy, { vertex, visit: 1, action, recovery });
  assert.equal(reason.outcome, outcome);
  assert.deepEqual(reason.rule, rule);
  assert.doesNotMatch(reason.text, /ended with|cannot run yet/, `a sentence naming the failure: ${reason.text}`);
  return reason;
}

export const tddTrace = (fixture: Pick<GoldenFixture, 'readEvents'>) =>
  golden.trace(fixture.readEvents()).filter((event) => TDD_VERTICES.includes(event.vertex));

// T17's error paths: every non-advance row of the transition table, reached through the interpreter.
export const WRONG_ADD = 'export const add = () => 0;\n';

// A green Attempt's script: it writes `files` and reports the golden green response.
export const greenWrites = (files: Record<string, string>): fakeHarness.ScriptedResponse => ({
  files,
  response: golden.greenResponse,
});

// The golden fixture over the first Visit's responses and `responses`, whose suite passes only once lib/add.mjs really
// adds, so a wrong green fails the Green Check. It runs nothing.
export async function greenFixture(
  t: TestContext,
  { responses = {}, integrity, git }: golden.GoldenOptions = {},
): Promise<GoldenFixture> {
  const fixture = await golden.fixture(t, {
    responses: { ...structuredClone(golden.firstVisitResponses), ...responses },
    integrity,
    git,
  });
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true });
  return fixture;
}
