import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as marker from '../../lib/marker.ts';
import * as remoteEffects from '../../lib/remote-effects.ts';
import * as support from '../support/execution-context.ts';

const pushKey = marker.actionKeyOf(support.PUSH_ACTION_IDENTITY);

test('a remote effect that fails transiently is retried after its backoff, once its effect is not found', async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  assert.deepEqual(await support.remoteCommentLaunch(context), { id: 1000 });
  assert.equal(fakeGh.comments.length, 1, 'posted once');
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(executionRecord.retries[pushKey], {
    remote: { count: 1, failureClass: 'transient', nextEligibleAt: Date.parse('2026-10-15T00:01:00Z'), started: true },
  });
});

test('a remote effect that keeps failing transiently is rethrown once its two retries are spent', async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const err = await support.rejection(support.remoteCommentLaunch(context));
  assert.ok(err instanceof effectErrors.RetriesExhaustedError, 'a typed error says the budget ran out');
  assert.match(err.message, /HTTP 502/);
  assert.deepEqual(err.spent, { failureClass: 'transient', status: 502, count: 2, effect: 'comment' });
  assert.equal(executionRecord.retries[pushKey]?.remote?.count, 2);
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => [event.outcome, event.failureClass]),
    [['fault', 'transient']],
    'one Action Event, for the final failure',
  );
});

test('a remote failure whose class reaches the run latches the run stop and is decided as a run stop', async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.fail({ matches: support.commentPost, status: 401 });
  const err = await support.rejection(support.remoteCommentLaunch(context));
  assert.ok(err instanceof effectErrors.EarlyTerminalError && err.ending.next === 'run-stop');
  const { detail, ...ending } = err.ending;
  assert.deepEqual(ending, {
    next: 'run-stop',
    failureClass: 'auth',
    source: 'comment',
    reason: 'The comment failed with class auth.',
  });
  assert.match(detail, /HTTP 401/, "the failure's error is its detail");
  assert.deepEqual(context.runState.stop, { failureClass: 'auth', ticket: support.TICKET, source: 'comment' });
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => [event.outcome, event.failureClass]),
    [['run-stop', 'auth']],
  );
});

test("a run stop latched before a remote Action's backoff ends it as run-stopped, its retry kept", async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  fakeGh.fail({ matches: support.commentPost, status: 502 });
  const err = await support.rejection(support.remoteCommentLaunch(context));
  assert.ok(err instanceof effectErrors.EarlyTerminalError);
  assert.deepEqual(err.ending, {
    next: 'run-stopped',
    retrying: true,
    reason: 'Ticket #21 stopped the run with class auth during a backoff.',
  });
  assert.deepEqual(sleeps, [], 'no backoff slept');
  assert.equal(executionRecord.retries[pushKey]?.remote?.count, 1);
});

test('a saved retry deadline further away than 31 days holds the Ticket', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  executionRecord.retries[pushKey] = {
    remote: { count: 1, failureClass: 'transient', nextEligibleAt: Number.MAX_SAFE_INTEGER, started: false },
  };
  const err = await support.rejection(support.remoteCommentLaunch(context));
  assert.ok(err instanceof effectErrors.EarlyTerminalError);
  assert.deepEqual(err.ending, {
    next: 'hold',
    reason:
      'The retry of green/1/push/0 has a deadline gg will not wait for, so the Ticket is held with its retry as saved.',
  });
});

test("a failed lookup of a remote effect is retried on the Action's budget until it finds the effect", async (t) => {
  const { context, executionRecord, fakeGh, sleeps } = await support.executionContext(t);
  await support.remoteComment(context);
  fakeGh.fail({ matches: (args: string[]) => args[0] === 'api' && !args.includes('POST'), status: 502 });
  const [intent] = executionRecord.writeAheadLog;
  const found = await remoteEffects.findEffectRetrying(context, intent, {
    executionRecord,
    gh: context.gh,
    cwd: context.cwd,
    issueLabels: [],
  });
  assert.deepEqual(found, { status: 'found', evidence: { id: 1000 } });
  assert.deepEqual(sleeps, [60_000]);
});

const unread = { remoteSha: async () => assert.fail('a commit reads no remote sha') };

test('a git write queued for the repo lock is ended as run-stopped when the run stopped meanwhile', async (t) => {
  const { context } = await support.executionContext(t);
  context.runState.stop = { failureClass: 'auth', ticket: 21, source: 'push' };
  const err = await support.rejection(remoteEffects.lockGuard(context, 'commit', [], unread));
  assert.ok(err instanceof effectErrors.EarlyTerminalError);
  assert.deepEqual(err.ending, {
    next: 'run-stopped',
    retrying: false,
    reason: 'Ticket #21 stopped the run with class auth during a repo-lock wait.',
  });
});

test("a git write queued for the repo lock abandons the Ticket when a human's needs-human label is set", async (t) => {
  const { context, executionRecord, fakeGh } = await support.executionContext(t);
  fakeGh.labels.add(support.NEEDS_HUMAN_LABEL);
  fakeGh.labels.add(support.IN_PROGRESS_LABEL);
  const err = await support.rejection(remoteEffects.lockGuard(context, 'commit', [], unread));
  assert.ok(err instanceof effectErrors.EarlyTerminalError);
  assert.deepEqual(err.ending, {
    next: 'abandon',
    cursor: executionRecord.cursor,
    reason: `#${support.TICKET} carries gg:state:needs-human on GitHub, which overrides the record.`,
    inProgress: true,
  });
});

test('a push queued for the repo lock is skipped when origin already has its commit', async (t) => {
  const { context } = await support.executionContext(t);
  const git = { remoteSha: async () => 'abc' };
  assert.deepEqual(await remoteEffects.lockGuard(context, 'push', ['worktree', 'branch', 'abc'], git), { skip: true });
  assert.deepEqual(await remoteEffects.lockGuard(context, 'push', ['worktree', 'branch', 'def'], git), {
    skip: false,
  });
  assert.equal(await remoteEffects.lockGuard(context, 'commit', [], git), undefined);
});
