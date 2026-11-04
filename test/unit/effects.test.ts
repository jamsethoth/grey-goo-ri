import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as effects from '../../lib/effects.ts';
import * as record from '../../lib/record.ts';
import * as visit from '../../lib/visit.ts';
import * as support from '../support/execution-context.ts';

const stepsOf = (executionRecord: record.ExecutionRecord, actionMarker: string) =>
  executionRecord.writeAheadLog.filter((entry) => entry.actionMarker === actionMarker).map((entry) => entry.step);

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
      throw new effectErrors.CrashError('crash');
    }),
    effectErrors.CrashError,
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

test('a side effect is logged as intent, evidence and completion, and returns its evidence', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const evidence = await effects.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: 'reset',
    payload: { baseline: 'abc' },
    perform: async () => ({ head: 'abc' }),
  });
  assert.deepEqual(evidence, { head: 'abc' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a proven side effect is not made again: its saved evidence is returned and the Action completed', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'reset', { baseline: 'abc' });
  await record.evidence(executionRecord, 'gg:m', { head: 'saved' });
  const evidence = await effects.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: 'reset',
    payload: { baseline: 'abc' },
    perform: async () => assert.fail('a proven effect is made again'),
  });
  assert.deepEqual(evidence, { head: 'saved' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a deferred side effect is left for finish to complete', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const perform = async () => ({ head: 'abc' });
  const evidence = await effects.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: 'reset',
    payload: {},
    perform,
    deferred: true,
  });
  assert.deepEqual(evidence, { head: 'abc' });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence']);
});

test('an open intent is redone with its intended payload, not the one given now', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await record.intent(executionRecord, 'gg:m', 'reset', { baseline: 'intended' });
  const evidence = await effects.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: 'reset',
    payload: { baseline: 'now' },
    perform: async (payload) => ({ head: payload.baseline }),
  });
  assert.deepEqual(evidence, { head: 'intended' });
  assert.equal(executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent').length, 1);
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
  const resolution: visit.TableResolution = {
    outcome: 'ok',
    direction: 'advance',
    rule: { table: 'passed', row: 0 },
    row: null,
    check: null,
    retryAfterMs: null,
    retryKind: null,
    failureClass: null,
  };
  const actionRef = { ...support.PUSH_REF, action: 'test' };
  const finished = await effects.finish(context, {
    actionRef,
    startedAt: 5,
    resolution,
    fields: { check: 'test' },
  });
  assert.equal(finished, resolution);
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
  const resolution: visit.TableResolution = {
    outcome: 'ok',
    direction: 'retry',
    rule: { table: 'fixed', row: 'transient-retry' },
    row: null,
    check: null,
    retryAfterMs: null,
    retryKind: null,
    failureClass: null,
  };
  const actionRef = { ...support.PUSH_REF, procedure: null };
  await effects.finish(context, {
    actionRef,
    startedAt: 5,
    resolution,
    actionMarker: 'gg:m',
    evidence: { remoteSha: 'abc' },
  });
  assert.deepEqual(stepsOf(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
  assert.equal(executionRecord.visitState, null, 'a Terminal Action or a retry settles nothing');
  assert.equal(
    await effects.finish(context, { actionRef, startedAt: 5, resolution, actionMarker: 'gg:m' }),
    resolution,
  );
  assert.equal(emitted.length, 1, 'a completed Action records no second Event');
});

test("a Flow Action's retry is not settled, so a resumed Visit runs the Action again", async (t) => {
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
  const resolution: visit.TableResolution = {
    outcome: 'failed',
    direction: 'retry',
    rule: { table: 'fixed', row: 'transient-retry' },
    row: 'transient-retry',
    check: null,
    retryAfterMs: 60_000,
    retryKind: 'transient',
    failureClass: 'transient',
  };
  const actionRef = { ...support.PUSH_REF, action: 'green' };
  await effects.finish(context, { actionRef, startedAt: 5, resolution });
  assert.equal(executionRecord.visitState.settled, null);
  assert.deepEqual(
    emitted.map((event) => [event.action, event.direction]),
    [['green', 'retry']],
    'its Action Event is still recorded',
  );
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
