import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import { actionEvent, attemptsOf } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { runFirstVisit } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';

// What an agent Action's Harness call carries beside its Brief, and what gg keeps of what the Harness reports (#422).
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const RED_RETRY = keys.responseKey('red', 1, 'red', 2);
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
  await interpreter.runExecution({ ...fixture.options, signal: controller.signal });
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
