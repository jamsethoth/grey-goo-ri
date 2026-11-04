import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effects from '../../lib/effects.mjs';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as marker from '../../lib/marker.ts';
import * as terminal from '../../lib/terminal.mjs';
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

test("an Execution's run stop is its first Action Event whose class reaches the run", () => {
  const event = (action: string, failureClass: string | null, agent = false) => ({
    type: 'action',
    action,
    agent,
    failureClass,
  });
  const harnessAuth = event('red', 'auth', true);
  const remoteAuth = event('push', 'auth');
  const permission = event('push', 'permission');
  assert.equal(
    terminal.runStopEvent([event('red-check', null), harnessAuth, remoteAuth]),
    harnessAuth,
    'a Harness auth',
  );
  assert.equal(terminal.runStopEvent([permission, remoteAuth, { type: 'ticket_end' }]), remoteAuth, 'a remote auth');
  assert.equal(terminal.runStopEvent([permission]), null, 'a permission failure faults only its Ticket');
  assert.equal(terminal.runStopEvent([]), null, 'none');
});

type Context = Awaited<ReturnType<typeof support.executionContext>>['context'];
const commentOf = (actionMarker: string) => ({
  target: { kind: 'issue', number: support.TICKET },
  body: `A comment.\n${marker.markerComment(actionMarker)}`,
  bodyHash: 'hash',
});
const postComment = (context: Context) => async (payload: { target: { number: number }; body: string }) => ({
  id: github.commentId(await context.gh.comment(payload.target.number, payload.body, context.cwd)),
});
// The error a remote comment at the green Vertex's push Action ends with, once the fake gh has failed it as queued.
async function remoteError(context: Context) {
  const actionMarker = context.markerOf(support.PUSH_REF);
  context.record.cursor = { ...support.PUSH_REF, attempt: 1 };
  try {
    await effects.sideEffect(context, actionMarker, 'comment', commentOf(actionMarker), postComment(context));
  } catch (err) {
    return err;
  }
  assert.fail('the remote comment succeeded');
}
const ticketEnds = (commonDir: string, execution: string) =>
  events.executionEvents(commonDir, execution).filter((event) => event.type === 'ticket_end');

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
  executionRecord.cursor = { ...support.PUSH_REF, recovery: 1, attempt: 1 };
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

test('a declared stop holds every field, the flags false and the rest null', () => {
  assert.deepEqual(terminal.declaredStop({ outcome: 'fault', error: 'boom' }), {
    outcome: 'fault',
    response: null,
    actionRef: null,
    held: false,
    abandoned: false,
    inProgress: false,
    fresh: false,
    stopped: false,
    commentTemplate: null,
    advice: null,
    detail: null,
    error: 'boom',
    failureClass: null,
    interrupted: null,
  });
});

test("an Execution's run stop is read from its Action Events in the State Database", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  assert.equal(terminal.runStopOf(executionRecord), null);
  context.events('action', {
    flow: 'default',
    configHash: 'abc123',
    launchProfile: null,
    confinement: null,
    ticket: support.TICKET,
    run: 'run-1',
    execution: executionRecord.execution,
    vertex: 'green',
    visit: 1,
    procedure: 'implement',
    action: 'push',
    recovery: 0,
    attempt: 1,
    durationMs: 0,
    outcome: 'run-stop',
    direction: 'stop',
    signals: {},
    rule: { table: 'fixed', row: 'run-stop' },
    agent: false,
    failureClass: 'auth',
  });
  assert.deepEqual(terminal.runStopOf(executionRecord), { failureClass: 'auth' });
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
  assert.equal(terminal.whereOf({ action: 'green', recovery: 0 }), 'green');
  assert.equal(terminal.whereOf({ action: 'green', recovery: 2 }), 'green (recovery 2)');
});

test("a Terminal's Actions are named for its report: end, fault, hold or abandon", () => {
  assert.deepEqual(terminal.terminalAt('ready-for-qa', null)('comment'), {
    vertex: 'ready-for-qa',
    visit: 1,
    procedure: null,
    action: 'end-comment',
    recovery: 0,
  });
  assert.equal(terminal.terminalAt('needs-human', { error: 'boom', held: true })('label').action, 'fault-label');
  assert.equal(terminal.terminalAt('needs-human', { held: true })('label').action, 'hold-label');
  assert.deepEqual(terminal.terminalAt('abandoned', { abandoned: true })('label'), {
    vertex: 'needs-human',
    visit: 1,
    procedure: null,
    action: 'abandon-label',
    recovery: 0,
  });
});

test('a run stop found during a backoff ends the Execution at needs-human, naming the Action it stopped', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  executionRecord.cursor = { ...support.PUSH_REF, attempt: 1 };
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  const result = await terminal.decide(context, { next: 'run-stopped', retrying: true, reason: 'Stopped.' });
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
  executionRecord.cursor = { ...support.PUSH_REF, attempt: 1 };
  await terminal.decide(context, {
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
  assert.deepEqual(await terminal.decide(held.context, { next: 'hold', name: 'conflict', reason: 'It conflicts.' }), {
    outcome: 'needs-human',
    held: true,
  });
  assert.deepEqual(held.executionRecord.terminalReason?.decidedBy, { hold: 'conflict' });
  const abandoned = await support.executionContext(t);
  assert.deepEqual(
    await terminal.decide(abandoned.context, { next: 'abandon', reason: 'A human took it.', inProgress: false }),
    { outcome: 'abandoned' },
  );
});

test("a decision found by a Terminal's own retry is taken by the Terminal", async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  executionRecord.terminalReason = { decidedBy: {}, outcome: 'needs-human', rule: null, text: 'Stopped.' };
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const result = await terminal.terminal(context, 'needs-human', { outcome: 'needs-human' });
  assert.deepEqual(result, { outcome: 'abandoned' }, "the human's label found before the retry abandons it");
  assert.deepEqual(fakeGh.comments, []);
});

test('a Terminal posts its reason, sets its end label and lands that state with ticket_end', async (t) => {
  const { context, executionRecord, fakeGh, commonDir } = await support.executionContext(t);
  executionRecord.terminalReason = { decidedBy: {}, outcome: 'replan', rule: null, text: 'Replan it.' };
  const result = await terminal.terminal(context, 'needs-replan', { outcome: 'replan' });
  assert.deepEqual(result, { outcome: 'needs-replan' });
  assert.equal(executionRecord.state, 'needs-replan');
  assert.ok(fakeGh.comments[0].body.startsWith('### gg: needs-replan\n\n**Terminal Reason:** Replan it.'));
  assert.deepEqual([...fakeGh.labels], ['gg:state:needs-replan']);
  assert.deepEqual(
    ticketEnds(commonDir, executionRecord.execution).map((event) => event.outcome),
    ['needs-replan'],
  );
});
