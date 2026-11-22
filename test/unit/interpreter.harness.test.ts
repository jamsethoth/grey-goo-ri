import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as interpreter from '../../lib/interpreter.ts';
import { actionEvent, attemptsOf, loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { runFirstVisit } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';

// What an agent Action's Harness call carries beside its Brief, and what gg keeps of what the Harness reports (#422).
const RED_CALL = keys.responseKey({ vertex: 'red', visit: 1, action: 'red' });
const RED_RETRY = keys.responseKey({ vertex: 'red', visit: 1, action: 'red', attempt: 2 });
const TRANSIENT = { files: {}, response: null, failure: { failureClass: 'transient', retryAfterMs: 0 } };

test("a resumed Attempt's call carries the Session's earlier cumulative Usage", async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [RED_CALL]: { ...TRANSIENT, result: { usage: { delta: { inputTokens: 40, outputTokens: 7 } } } },
      [RED_RETRY]: golden.firstVisitResponses[RED_CALL]!,
    }),
  });
  await interpreter.runExecution(fixture.options);
  const [first, resumed] = fixture.harness.calls;
  assert.equal(first!.previousUsage, null, 'a fresh Session has no earlier Usage');
  assert.equal(resumed!.resume, 'fake-session-1');
  assert.deepEqual(resumed!.previousUsage, {
    inputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 7,
    reasoningTokens: null,
    costUsd: null,
    peakContextTokens: 0,
    turns: 0,
    toolCalls: 0,
    compactions: 0,
  });
});

const RED_THIRD = keys.responseKey({ vertex: 'red', visit: 1, action: 'red', attempt: 3 });
// What a Claude call stopped before its result line reports (#487 Q3 A): no token totals, cost, turns or cost basis.
const UNREPORTED = {
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  costUsd: null,
  turns: null,
  costBasis: null,
};
// The Session's total after the first call, the last one reported.
const FIRST_TOTAL = {
  inputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 7,
  reasoningTokens: null,
  costUsd: 0.5,
  peakContextTokens: 0,
  turns: 3,
  toolCalls: 0,
  compactions: 0,
};

// The Session keeps its last reported total as the baseline a resumed call is given (#487 Q1 A), saved and read back,
// while the call that reported none keeps its null Usage on its Action Event.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("a resumed call after a timed-out one computes its delta from the last reported total, across a reload, while the timed-out call's Event carries null Usage", async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [RED_CALL]: { ...TRANSIENT, result: { usage: { delta: { inputTokens: 40, outputTokens: 7, turns: 3 } } } },
      [RED_RETRY]: { files: {}, response: null, result: { status: 'timed-out' } },
      [RED_THIRD]: golden.firstVisitResponses[RED_CALL]!,
    }),
  });
  // The fake reads a scripted null count as 0, so the timed-out call's Usage is set here, as Claude's Harness gives it.
  const run = fixture.harness.run;
  fixture.harness.run = async (call, hooks) => {
    const answer = await run(call, hooks);
    // The golden fake reports no cost; Claude's Harness gives a reported total its cost and basis.
    if (call.attempt === 1)
      for (const half of ['cumulative', 'delta'] as const)
        answer.result.usage[half] = { ...answer.result.usage[half], costUsd: 0.5, costBasis: 'reported' };
    if (call.attempt === 2)
      for (const half of ['cumulative', 'delta'] as const)
        answer.result.usage[half] = { ...answer.result.usage[half], ...UNREPORTED };
    return answer;
  };
  const timedOut = golden.markerOf(fixture.executionRecord, 'red', 1, 'red', 0, 2);
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: timedOut, point: 'after-completion' } }),
    (err: unknown) => err instanceof interpreter.CrashError,
  );
  const reloaded = loadTicket(fixture);
  const saved = reloaded.sessions[keys.sessionKey({ vertex: 'red', visit: 1, action: 'red' })]!.cumulativeUsage;
  await interpreter.runExecution({ ...fixture.options, record: reloaded });
  const stopped = attemptsOf(fixture, 'red', 'red')[1] as events.AgentActionEvent;
  const fieldsOf = (fields: readonly string[], usage: unknown) =>
    Object.fromEntries(fields.map((field) => [field, (usage as Record<string, unknown>)[field]]));
  // The baseline is the counts: a Harness reads no cost basis from the earlier total.
  const countsOf = (usage: unknown) => fieldsOf(contract.USAGE_FIELDS, usage);
  const unreportedOf = (usage: unknown) => fieldsOf(Object.keys(UNREPORTED), usage);
  assert.deepEqual(
    {
      stoppedStatus: stopped.signals.harnessResult?.status,
      stoppedEvent: { cumulative: unreportedOf(stopped.usage.cumulative), delta: unreportedOf(stopped.usage.delta) },
      savedAfterTheStop: { ...countsOf(saved), costBasis: saved.costBasis },
      thirdCall: {
        resume: fixture.harness.calls[2]?.resume,
        previousUsage: countsOf(fixture.harness.calls[2]?.previousUsage),
      },
    },
    {
      stoppedStatus: 'timed-out',
      stoppedEvent: { cumulative: UNREPORTED, delta: UNREPORTED },
      savedAfterTheStop: { ...FIRST_TOTAL, costBasis: 'reported' },
      thirdCall: { resume: 'fake-session-1', previousUsage: FIRST_TOTAL },
    },
  );
});

// A resumed call may report another id; the Session entry keeps the one its fresh call reported (#422, Q3 B).
test("a resumed call's session id is never stored", async (t) => {
  const red = golden.firstVisitResponses[RED_CALL]!;
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [RED_CALL]: TRANSIENT,
      [RED_RETRY]: { ...red, result: { ...red.result, sessionId: 'reported-on-resume' } },
    }),
  });
  await interpreter.runExecution(fixture.options);
  assert.equal(fixture.harness.calls[1]!.resume, 'fake-session-1');
  const session = fixture.executionRecord.sessions[keys.sessionKey({ vertex: 'red', visit: 1, action: 'red' })];
  assert.equal(session!.sessionId, 'fake-session-1');
});

test("the agent Action Event carries the Harness's repository digest and CLI version", async (t) => {
  const red = golden.firstVisitResponses[RED_CALL]!;
  const reported = {
    repositoryDigest: 'sha256:5e1f0c',
    agentCliVersion: '2.1.3',
    effectiveModel: 'claude-opus-4-1',
    effectiveEffort: 'high',
  };
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({ [RED_CALL]: { ...red, result: { ...red.result, ...reported } } }),
  });
  await interpreter.runExecution(fixture.options);
  const event = actionEvent(fixture, 'red', 'red') as unknown as Record<string, unknown>;
  assert.deepEqual(
    {
      repositoryDigest: event.repositoryDigest,
      agentCliVersion: event.agentCliVersion,
      effectiveModel: event.effectiveModel,
      effectiveEffort: event.effectiveEffort,
    },
    reported,
  );
});

test("the fake's agent Action Event holds null for the digest, CLI version, model and effort", async (t) => {
  const fixture = await runFirstVisit(t);
  const event = actionEvent(fixture, 'red', 'red') as unknown as Record<string, unknown>;
  assert.deepEqual(
    {
      repositoryDigest: event.repositoryDigest,
      agentCliVersion: event.agentCliVersion,
      effectiveModel: event.effectiveModel,
      effectiveEffort: event.effectiveEffort,
    },
    { repositoryDigest: null, agentCliVersion: null, effectiveModel: null, effectiveEffort: null },
  );
});

// The Run's signal is aborted once the hung call has started. A call given no signal is released by cancel() instead,
// so the case fails on its assertion, never hangs; a fake that ignored the signal would hang to the case timeout.
test('an aborted signal resolves a hung call as killed', { timeout: 60_000 }, async (t) => {
  const red = golden.firstVisitResponses[RED_CALL]!;
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({ [RED_CALL]: { ...red, hang: true }, [RED_RETRY]: red }),
  });
  const controller = new AbortController();
  const given: unknown[] = [];
  const run = fixture.harness.run;
  fixture.harness.run = (call, hooks) => {
    const result = run(call, hooks);
    if (call.vertex === 'red' && call.attempt === 1) {
      given.push(hooks?.signal);
      if (hooks?.signal === controller.signal) controller.abort();
      else fixture.harness.cancel();
    }
    return result;
  };
  const runState = { stop: null, remoteNotBefore: 0, signal: controller.signal };
  await interpreter.runExecution({ ...fixture.options, runState });
  assert.deepEqual(given, [controller.signal], "the hung call was given the Run's signal");
  const [hung] = attemptsOf(fixture, 'red', 'red');
  assert.equal(hung!.signals.harnessResult?.status, 'killed');
});

test("an Attempt's call names the Run's directory", async (t) => {
  const fixture = await runFirstVisit(t);
  assert.equal(
    fixture.harness.calls[0]!.runDirectory,
    join(fixture.commonDir, 'gg', 'runs', '20261015T000000Z-abc123'),
  );
});

test("an agent Action resolves its tools with the Visit's pinned commands and the platform", async (t) => {
  const fixture = await golden.fixture(t);
  const contexts: unknown[] = [];
  Object.assign(fixture.harness, {
    resolveTools: (_agent: unknown, context: unknown) => {
      contexts.push(context);
      return {};
    },
  });
  await interpreter.runExecution(fixture.options);
  assert.deepEqual(contexts[0], { commands: { test: 'npm test' }, platform: process.platform });
});
