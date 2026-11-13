import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type * as effectErrors from '../../lib/effect-errors.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as terminal from '../../lib/terminal.ts';
import * as support from '../support/execution-context.ts';

const push = { vertex: 'green', visit: 1, action: 'push', recovery: 0 };
const runStop = { row: 'run-stop', rule: { table: 'fixed', row: 'run-stop' }, failureClass: 'auth' };

test('a run stop from a remote Action names the Action, not a harness call', () => {
  assert.equal(
    terminal.stopText(push, 'run-stop', { ...runStop, source: 'push' }),
    'The push at push failed with class auth, which stops the whole run.',
  );
  assert.equal(
    terminal.stopText({ ...push, action: 'review' }, 'needs-human', {
      row: 'run-stopped',
      rule: { table: 'fixed', row: 'run-stopped' },
      failureClass: 'auth',
      source: 'push',
      runStopTicket: 21,
    }),
    'The push of Ticket #21 failed with class auth, which stops the whole run, so this Execution stopped ' +
      'before review.',
  );
  assert.equal(
    terminal.stopText({ ...push, action: 'red' }, 'run-stop', runStop),
    'The harness call at red failed with class auth, which stops the whole run.',
    "a Harness's run stop still names the harness call",
  );
});

// The error a remote comment at the green Vertex's push Action ends with, once the fake gh has failed it as queued.
function remoteError(context: support.ExecutionContext) {
  context.record.cursor = { ...support.PUSH_ACTION_IDENTITY, attempt: 1 };
  return support.rejection(support.remoteComment(context));
}
const ticketEnds = (commonDir: string, execution: string) =>
  eventRead.executionEvents(commonDir, execution).filter((event) => event.type === 'ticket_end');

test('a hold posts its reason with its advice, labels needs-human and lands held with ticket_end', async (t) => {
  const { context, executionRecord, fakeGh, commonDir } = await support.executionContext(t);
  fakeGh.labels.add(support.IN_PROGRESS_LABEL);
  const result = await terminal.hold(context, {
    name: 'dirty-state',
    terminalReasonText: 'The worktree has changes no Action made.',
    advice: 'Commit or discard them.',
  });
  assert.deepEqual(result, { outcome: 'needs-human', held: true });
  assert.equal(executionRecord.state, 'held');
  assert.deepEqual(executionRecord.terminalReason, {
    decidedBy: { hold: 'dirty-state' },
    outcome: null,
    rule: null,
    text: 'The worktree has changes no Action made.',
  });
  assert.equal(fakeGh.comments.length, 1);
  assert.ok(
    fakeGh.comments[0].body.includes(
      '**Terminal Reason:** The worktree has changes no Action made.\n\nCommit or discard them.',
    ),
    fakeGh.comments[0].body,
  );
  assert.deepEqual([...fakeGh.labels], [support.NEEDS_HUMAN_LABEL]);
  assert.deepEqual(
    ticketEnds(commonDir, executionRecord.execution).map((event) => event.outcome),
    ['needs-human'],
  );
});

test("an abandonment posts nothing, removes in-progress, and lands abandoned under the human's label", async (t) => {
  const { context, executionRecord, fakeGh, commonDir } = await support.executionContext(t);
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.labels.add(support.IN_PROGRESS_LABEL);
  const result = await terminal.abandon(context, { terminalReasonText: 'A human took it.', inProgress: true });
  assert.deepEqual(result, { outcome: 'abandoned' });
  assert.equal(executionRecord.state, 'abandoned');
  assert.deepEqual(executionRecord.terminalReason?.decidedBy, { human: support.NEEDS_HUMAN_LABEL });
  assert.deepEqual(fakeGh.comments, []);
  assert.deepEqual([...fakeGh.labels], [support.NEEDS_HUMAN_LABEL]);
  assert.deepEqual(
    ticketEnds(commonDir, executionRecord.execution).map((event) => event.outcome),
    ['abandoned'],
  );
});

test('an unexpected fault names the Action it stopped at and posts its error', async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  executionRecord.cursor = { ...support.PUSH_ACTION_IDENTITY, recovery: 1, attempt: 1 };
  const result = await terminal.fault(context, new Error('git exploded'));
  assert.deepEqual(result, { outcome: 'needs-human', fault: true });
  assert.equal(executionRecord.state, 'fault');
  assert.deepEqual(executionRecord.terminalReason, {
    decidedBy: { vertex: 'green', visit: 1, action: 'push', recovery: 1 },
    outcome: null,
    rule: null,
    text:
      'An unexpected fault stopped the Execution at push (recovery 1); the error is in this comment and on ' +
      'ticket_end.',
  });
  assert.ok(fakeGh.comments[0].body.includes('git exploded'), fakeGh.comments[0].body);
});

test('a fault whose transient retries ran out says the budget ran out, with its HTTP status', async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  await terminal.fault(context, await remoteError(context));
  assert.equal(
    executionRecord.terminalReason?.text,
    'A transient GitHub failure (HTTP 502) at push persisted after 2 retries; the error is in this comment and on ' +
      'ticket_end.',
  );
});

test('a fault from a remote failure that reaches only its Ticket names the effect, class and status', async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.fail({ matches: support.commentPost, status: 403 });
  await terminal.fault(context, await remoteError(context));
  assert.equal(
    executionRecord.terminalReason?.text,
    'The comment at push failed with class permission (HTTP 403), which faults only this Ticket; the error is in ' +
      'this comment and on ticket_end.',
  );
});

test("another Execution's run stop is a needs-human resolution naming its class, Ticket and source", async (t) => {
  const { context } = await support.executionContext(t);
  assert.equal(terminal.runStopped(context), null);
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  assert.deepEqual(terminal.runStopped(context), {
    outcome: 'needs-human',
    direction: 'stop',
    row: 'run-stopped',
    rule: { table: 'fixed', row: 'run-stopped' },
    failureClass: 'auth',
    runStopTicket: 21,
    source: 'push',
  });
});

test('a Terminal Reason names the deciding Action, its Outcome and its rule', () => {
  const decidingRef = { ...push, procedure: 'implement' };
  assert.deepEqual(terminal.terminalReason(decidingRef, 'failed', { rule: { table: 'failed', row: 1 } }, 'Why.'), {
    decidedBy: { vertex: 'green', visit: 1, action: 'push', recovery: 0 },
    outcome: 'failed',
    rule: { table: 'failed', row: 1 },
    text: 'Why.',
  });
});

test('a Terminal Reason names an Action by its id, and its recovery pass when it has one', () => {
  assert.equal(terminal.actionText({ action: 'green', recovery: 0 }), 'green');
  assert.equal(terminal.actionText({ action: 'green', recovery: 2 }), 'green (recovery 2)');
});

test('a run stop found during a backoff ends the Execution at needs-human, naming the Action it stopped', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  executionRecord.cursor = { ...support.PUSH_ACTION_IDENTITY, attempt: 1 };
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  const result = await terminal.endEarly(context, { next: 'run-stopped', retrying: true, reason: 'Stopped.' });
  assert.deepEqual(result, { outcome: 'needs-human' });
  assert.deepEqual(executionRecord.terminalReason, {
    decidedBy: { vertex: 'green', visit: 1, action: 'push', recovery: 0 },
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'run-stopped' },
    text:
      'The push of Ticket #21 failed with class auth, which stops the whole run, so this Execution stopped while ' +
      'waiting to retry push; its retry is kept as saved.',
  });
});

test("a remote Action's run stop is decided as a run-stop Terminal with its class and detail", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  executionRecord.cursor = { ...support.PUSH_ACTION_IDENTITY, attempt: 1 };
  await terminal.endEarly(context, {
    next: 'run-stop',
    failureClass: 'auth',
    source: 'push',
    detail: 'HTTP 401',
    reason: 'The push failed with class auth.',
  });
  assert.equal(
    executionRecord.terminalReason?.text,
    'The push at push failed with class auth, which stops the whole run.',
  );
  assert.equal(executionRecord.terminalStop?.outcome, 'run-stop');
  assert.equal(executionRecord.terminalStop?.failureClass, 'auth');
  assert.equal(executionRecord.terminalStop?.detail, 'HTTP 401');
});

test('a hold or an abandonment is decided as its own Terminal', async (t) => {
  const held = await support.executionContext(t);
  assert.deepEqual(await terminal.endEarly(held.context, { next: 'hold', name: 'conflict', reason: 'It conflicts.' }), {
    outcome: 'needs-human',
    held: true,
  });
  assert.deepEqual(held.executionRecord.terminalReason?.decidedBy, { hold: 'conflict' });
  const abandoned = await support.executionContext(t);
  assert.deepEqual(
    await terminal.endEarly(abandoned.context, {
      next: 'abandon',
      cursor: abandoned.executionRecord.cursor,
      reason: 'A human took it.',
      inProgress: false,
    }),
    { outcome: 'abandoned' },
  );
});

test("a decision found by a Terminal's own retry is taken by the Terminal", async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  executionRecord.terminalReason = { decidedBy: { hold: null }, outcome: 'needs-human', rule: null, text: 'Stopped.' };
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const result = await terminal.terminal(context, 'needs-human', { outcome: 'needs-human' });
  assert.deepEqual(result, { outcome: 'abandoned' }, "the human's label found before the retry abandons it");
  assert.deepEqual(fakeGh.comments, []);
  assert.deepEqual(executionRecord.terminalReason.decidedBy, { human: support.NEEDS_HUMAN_LABEL });
});

// Each hold and abandonment an Action can end its Execution with (effectErrors.Ending), as endEarly decides it.
const HOLD_AND_ABANDON: { kind: string; ending: (cursor: record.Cursor) => effectErrors.Ending; key: object }[] = [
  {
    kind: 'a hold',
    ending: () => ({ next: 'hold', name: 'conflict', reason: 'It conflicts.' }),
    key: { hold: 'conflict' },
  },
  {
    kind: 'an abandonment',
    ending: (cursor) => ({ next: 'abandon', cursor, reason: 'A human took it.', inProgress: false }),
    key: { human: support.NEEDS_HUMAN_LABEL },
  },
];
const GREEN_VISIT = { vertex: 'green', visit: 1, action: null, recovery: 0, attempt: 1 };

for (const { kind, ending, key } of HOLD_AND_ABANDON) {
  test(`${kind} inside a Visit names it, and the Action and Recovery Number the cursor is at (#341)`, async (t) => {
    const atAction = await support.executionContext(t);
    atAction.executionRecord.visits.set('green', 1);
    atAction.executionRecord.cursor = { ...support.PUSH_ACTION_IDENTITY, recovery: 1, attempt: 1 };
    await terminal.endEarly(atAction.context, ending(atAction.executionRecord.cursor));
    assert.deepEqual(atAction.executionRecord.terminalReason?.decidedBy, {
      ...key,
      vertex: 'green',
      visit: 1,
      action: 'push',
      recovery: 1,
    });
    const atNoAction = await support.executionContext(t);
    atNoAction.executionRecord.visits.set('green', 1);
    atNoAction.executionRecord.cursor = { ...GREEN_VISIT };
    await terminal.endEarly(atNoAction.context, ending(atNoAction.executionRecord.cursor));
    assert.deepEqual(atNoAction.executionRecord.terminalReason?.decidedBy, {
      ...key,
      vertex: 'green',
      visit: 1,
      action: null,
      recovery: 0,
    });
  });

  test(`${kind} outside every Visit names none (#341)`, async (t) => {
    const cases: [string, (executionRecord: record.ExecutionRecord) => void][] = [
      ['a fresh Execution', () => {}],
      [
        "the next Vertex's cursor, saved before its entry",
        (executionRecord) => {
          executionRecord.visits.set('red', 1);
          executionRecord.cursor = { ...GREEN_VISIT };
        },
      ],
      [
        'a Terminal cursor',
        (executionRecord) => {
          executionRecord.visits.set('green', 1);
          executionRecord.cursor = record.terminalCursor('needs-human');
        },
      ],
    ];
    for (const [name, place] of cases) {
      const { context, executionRecord } = await support.executionContext(t);
      place(executionRecord);
      await terminal.endEarly(context, ending(executionRecord.cursor));
      assert.deepEqual(executionRecord.terminalReason?.decidedBy, key, name);
    }
  });
}

test("an abandonment found by a hold's own report keeps the Visit the hold named (#341)", async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  executionRecord.visits.set('green', 1);
  executionRecord.cursor = { ...GREEN_VISIT };
  // The hold's comment fails, and its retry finds the human's label.
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const result = await terminal.hold(context, { name: 'dirty-worktree', terminalReasonText: 'It is dirty.' });
  assert.deepEqual(result, { outcome: 'abandoned' });
  assert.deepEqual(executionRecord.terminalReason?.decidedBy, {
    human: support.NEEDS_HUMAN_LABEL,
    vertex: 'green',
    visit: 1,
    action: null,
    recovery: 0,
  });
});

// Every hold and abandonment reason is built in this module, where it reads the Visit the cursor is in (#341).
test('no lib module but lib/terminal.ts writes a Terminal Reason decidedBy (#341)', () => {
  const writers = readdirSync('lib', { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path !== 'terminal.ts' && /\bdecidedBy\s*:/.test(readFileSync(join('lib', path), 'utf8')));
  assert.deepEqual(writers, []);
});
