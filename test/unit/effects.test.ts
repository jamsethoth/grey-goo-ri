import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effects from '../../lib/effects.mjs';
import * as github from '../../lib/github.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as support from '../support/execution-context.ts';

type Context = Awaited<ReturnType<typeof support.executionContext>>['context'];
type CommentPayload = { target: { number: number }; body: string };

const commentOf = (actionMarker: string) => ({
  target: { kind: 'issue', number: support.TICKET },
  body: `A comment.\n${marker.markerComment(actionMarker)}`,
  bodyHash: 'hash',
});
const postComment = (context: Context) => async (payload: CommentPayload) => ({
  id: github.commentId(await context.gh.comment(payload.target.number, payload.body, context.cwd)),
});
const stepsOf = (executionRecord: record.ExecutionRecord, actionMarker: string) =>
  executionRecord.writeAheadLog.filter((entry) => entry.actionMarker === actionMarker).map((entry) => entry.step);
const thrown = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
};

test('a crash or a failed save is fatal, and any other error is not', () => {
  assert.equal(effects.fatal(new effects.CrashError('crash')), true);
  assert.equal(effects.fatal(new record.RecordSaveError(new Error('disk full'))), true);
  assert.equal(effects.fatal(new Error('gh failed')), false);
});

test('a crash point throws a CrashError only at its own point of its own marker', () => {
  const context = { crashAt: { marker: 'gg:m', point: 'after-effect' } };
  assert.throws(() => effects.crashPoint(context, 'gg:m', 'after-effect'), effects.CrashError);
  assert.equal(effects.crashPoint(context, 'gg:m', 'before-effect'), undefined);
  assert.equal(effects.crashPoint(context, 'gg:other', 'after-effect'), undefined);
  assert.equal(effects.crashPoint({}, 'gg:m', 'after-effect'), undefined);
});

test('the activity bracket marks the worktree busy while its function runs and idle after', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const during = await effects.bracket(context, async () => ({ ...executionRecord.activity }));
  assert.deepEqual(during, { busy: true, generation: 1 });
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
});

test('the activity bracket marks the worktree idle after a failure, but leaves it busy after a crash', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await assert.rejects(
    effects.bracket(context, async () => {
      throw new Error('gh failed');
    }),
    /gh failed/,
  );
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
  await assert.rejects(
    effects.bracket(context, async () => {
      throw new effects.CrashError('crash');
    }),
    effects.CrashError,
  );
  assert.deepEqual(executionRecord.activity, { busy: true, generation: 3 });
});

test("logged finds a marker's write-ahead entry by its step", async (t) => {
  const { executionRecord } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'push', { branch: 'b', sha: 'abc' });
  assert.deepEqual(effects.logged(executionRecord, 'gg:m', 'intent')?.payload, { branch: 'b', sha: 'abc' });
  assert.equal(effects.logged(executionRecord, 'gg:m', 'complete'), undefined);
  assert.equal(effects.logged(executionRecord, 'gg:other', 'intent'), undefined);
});

test('the remote Actions are the comment, PR upsert, push and PR ready', () => {
  assert.deepEqual(effects.REMOTE, ['comment', 'pr-upsert', 'push', 'pr-ready']);
});

test('a side effect is logged as intent, evidence and completion, and returns its evidence', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const evidence = await effects.sideEffect(context, 'gg:m', 'reset', { baseline: 'abc' }, async () => ({
    head: 'abc',
  }));
  assert.deepEqual(evidence, { head: 'abc' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a proven side effect is not made again: its saved evidence is returned and the Action completed', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'reset', { baseline: 'abc' });
  await record.evidence(executionRecord, 'gg:m', { head: 'saved' });
  const evidence = await effects.sideEffect(context, 'gg:m', 'reset', { baseline: 'abc' }, async () =>
    assert.fail('a proven effect is made again'),
  );
  assert.deepEqual(evidence, { head: 'saved' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a deferred side effect is left for finish to complete', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const perform = async () => ({ head: 'abc' });
  assert.deepEqual(await effects.sideEffect(context, 'gg:m', 'reset', {}, perform, true), { head: 'abc' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence']);
});

test('an open intent is redone with its intended payload, not the one given now', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'reset', { baseline: 'intended' });
  const evidence = await effects.sideEffect(
    context,
    'gg:m',
    'reset',
    { baseline: 'now' },
    async (payload: { baseline: string }) => ({ head: payload.baseline }),
  );
  assert.deepEqual(evidence, { head: 'intended' });
  assert.equal(executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent').length, 1);
});

test('a remote effect that fails transiently is retried after its backoff, once its effect is not found', async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const evidence = await effects.sideEffect(
    context,
    actionMarker,
    'comment',
    commentOf(actionMarker),
    postComment(context),
  );
  assert.deepEqual(evidence, { id: 1000 });
  assert.equal(fakeGh.comments.length, 1, 'posted once');
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(executionRecord.retries[marker.actionKeyOf(support.PUSH_REF)], {
    remote: { count: 1, failureClass: 'transient', nextEligibleAt: Date.parse('2026-10-15T00:01:00Z'), started: true },
  });
});

test('a remote effect that keeps failing transiently is rethrown once its two retries are spent', async (t) => {
  const { context, executionRecord, fakeGh, emitted } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const err = await thrown(
    effects.sideEffect(context, actionMarker, 'comment', commentOf(actionMarker), postComment(context)),
  );
  assert.match(String((err as Error).message), /HTTP 502/);
  assert.equal(executionRecord.retries[marker.actionKeyOf(support.PUSH_REF)].remote.count, 2);
  assert.deepEqual(
    emitted.map((event) => [event.outcome, event.failureClass]),
    [['fault', 'transient']],
    'one Action Event, for the final failure',
  );
});

test('a remote failure whose class reaches the run latches the run stop and is decided as a run stop', async (t) => {
  const { context, fakeGh, emitted } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  fakeGh.fail({ matches: support.commentPost, status: 401 });
  const err = await thrown(
    effects.sideEffect(context, actionMarker, 'comment', commentOf(actionMarker), postComment(context)),
  );
  assert.ok(err instanceof effects.Decided);
  const { detail, ...decided } = err.decided;
  assert.deepEqual(decided, {
    next: 'run-stop',
    failureClass: 'auth',
    source: 'comment',
    reason: 'The comment failed with class auth.',
  });
  assert.match(detail, /HTTP 401/, "the failure's error is its detail");
  assert.deepEqual(context.runState.stop, { failureClass: 'auth', ticket: support.TICKET, source: 'comment' });
  assert.deepEqual(
    emitted.map((event) => [event.outcome, event.failureClass]),
    [['run-stop', 'auth']],
  );
});

test("a run stop latched before a remote Action's backoff ends it as run-stopped, its retry kept", async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const err = await thrown(
    effects.sideEffect(context, actionMarker, 'comment', commentOf(actionMarker), postComment(context)),
  );
  assert.ok(err instanceof effects.Decided);
  assert.deepEqual(err.decided, {
    next: 'run-stopped',
    retrying: true,
    reason: 'Ticket #21 stopped the run with class auth during a backoff.',
  });
  assert.deepEqual(sleeps, [], 'no backoff slept');
  assert.equal(executionRecord.retries[marker.actionKeyOf(support.PUSH_REF)].remote.count, 1);
});

test('a saved retry deadline further away than 31 days holds the Ticket', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  executionRecord.retries[marker.actionKeyOf(support.PUSH_REF)] = {
    remote: { count: 1, failureClass: 'transient', nextEligibleAt: Number.MAX_SAFE_INTEGER, started: false },
  };
  const err = await thrown(
    effects.sideEffect(context, actionMarker, 'comment', commentOf(actionMarker), postComment(context)),
  );
  assert.ok(err instanceof effects.Decided);
  assert.deepEqual(err.decided, {
    next: 'hold',
    reason:
      'The retry of green/1/push/0 has a deadline gg will not wait for, so the Ticket is held with its retry as saved.',
  });
});

test("a failed lookup of a remote effect is retried on the Action's budget until it finds the effect", async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  const actionMarker = context.markerOf(support.PUSH_REF);
  await record.intent(executionRecord, actionMarker, 'comment', commentOf(actionMarker));
  await postComment(context)(commentOf(actionMarker));
  fakeGh.fail({ matches: (args: string[]) => args[0] === 'api' && !args.includes('POST'), status: 502 });
  const [entry] = executionRecord.writeAheadLog;
  const found = await effects.lookup(context, entry, {
    executionRecord,
    gh: context.gh,
    cwd: context.cwd,
    issueLabels: [],
  });
  assert.deepEqual(found, { status: 'found', evidence: { id: 1000 } });
  assert.deepEqual(sleeps, [60_000]);
});

test('a git write queued for the repo lock is ended as run-stopped when the run stopped meanwhile', async (t) => {
  const { context } = await support.executionContext(t);
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  const err = await thrown(effects.lockGuard(context, 'commit', [], {}));
  assert.ok(err instanceof effects.Decided);
  assert.deepEqual(err.decided, {
    next: 'run-stopped',
    retrying: false,
    reason: 'Ticket #21 stopped the run with class auth during a repo-lock wait.',
  });
});

test("a git write queued for the repo lock abandons the Ticket when a human's needs-human label is set", async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.labels.add(support.IN_PROGRESS_LABEL);
  const err = await thrown(effects.lockGuard(context, 'commit', [], {}));
  assert.ok(err instanceof effects.Decided);
  assert.deepEqual(err.decided, {
    next: 'abandon',
    cursor: executionRecord.cursor,
    reason: `#${support.TICKET} carries gg:state:needs-human on GitHub, which overrides the record.`,
    inProgress: true,
  });
});

test('a push queued for the repo lock is skipped when origin already has its commit', async (t) => {
  const { context } = await support.executionContext(t);
  const git = { remoteSha: async () => 'abc' };
  assert.deepEqual(await effects.lockGuard(context, 'push', ['worktree', 'branch', 'abc'], git), { skip: true });
  assert.deepEqual(await effects.lockGuard(context, 'push', ['worktree', 'branch', 'def'], git), { skip: false });
  assert.equal(await effects.lockGuard(context, 'commit', [], git), undefined);
});

test("finish saves a Flow Action's settled resolution with its Action Event", async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  executionRecord.visitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: {},
    checks: {},
    checkFollows: false,
    settled: null,
  };
  const resolution = { outcome: 'ok', direction: 'advance', rule: { table: 'passed', row: 0 } };
  const actionRef = { ...support.PUSH_REF, action: 'test' };
  assert.equal(await effects.finish(context, actionRef, 5, resolution, { check: 'test' }), resolution);
  assert.deepEqual(executionRecord.visitState.settled, { action: 'test', recovery: 0, resolution });
  assert.deepEqual(emitted, [
    {
      ...actionRef,
      startedAt: 5,
      outcome: 'ok',
      direction: 'advance',
      rule: { table: 'passed', row: 0 },
      signals: {},
      check: 'test',
    },
  ]);
  const saved = await record.load(executionRecord.commonDir, 'ticket', support.TICKET);
  assert.deepEqual(saved?.visitState?.settled, { action: 'test', recovery: 0, resolution });
});

test('finish completes a marked Action with its evidence once, and returns a completed one unsaved', async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'push', {});
  const resolution = { outcome: 'ok', direction: 'retry', rule: { table: 'fixed', row: 'transient-retry' } };
  const actionRef = { ...support.PUSH_REF, procedure: null };
  await effects.finish(context, actionRef, 5, resolution, {}, 'gg:m', { remoteSha: 'abc' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
  assert.equal(executionRecord.visitState, null, 'a Terminal Action or a retry settles nothing');
  assert.equal(await effects.finish(context, actionRef, 5, resolution, {}, 'gg:m'), resolution);
  assert.equal(emitted.length, 1, 'a completed Action records no second Event');
});

test('a completed side effect finishes as effect-completed', async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'push', {});
  const actionRef = { ...support.PUSH_REF, procedure: null };
  assert.deepEqual(await effects.effectDone(context, actionRef, 5, 'gg:m'), {
    outcome: 'ok',
    direction: 'advance',
    row: 'effect-completed',
    rule: { table: 'fixed', row: 'effect-completed' },
  });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'complete']);
  assert.deepEqual(
    emitted.map((event) => [event.action, event.outcome, event.rule]),
    [['push', 'ok', { table: 'fixed', row: 'effect-completed' }]],
  );
});
