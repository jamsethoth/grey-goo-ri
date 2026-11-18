import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fakeHarnessModule from '../support/fake-harness.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((directory) => rm(directory, { recursive: true, force: true }))));

const setup = async (options: fakeHarnessModule.FakeHarnessOptions = {}) => {
  const transcriptDir = await mkdtemp(join(tmpdir(), 'gg-fake-transcripts-'));
  const cwd = await mkdtemp(join(tmpdir(), 'gg-fake-cwd-'));
  dirs.push(transcriptDir, cwd);
  return { harness: fakeHarnessModule.fakeHarness({ transcriptDir, ...options }), cwd };
};

// The call's Action Marker names its own place, the Phase as its Action, unless a case gives one.
const call = (cwd: string, overrides: Partial<fakeHarnessModule.HarnessCall> = {}) => {
  const { vertex = 'implement', visit = 1, phase = 'red', attempt = 1 } = overrides;
  return {
    marker: `gg:e1:${vertex}:${visit}:${phase}:0:r1:${attempt}`,
    vertex,
    visit,
    phase,
    attempt,
    ...callBody(cwd),
    ...overrides,
  };
};
const callBody = (cwd: string) => ({
  agent: { harness: 'fake' },
  persona: { bytes: '# implementer\n', hash: 'sha256:persona' },
  brief: 'write the failing tests',
  schema: { type: 'object' },
  cwd,
  resume: null,
  access: 'workspace-write',
  network: false,
  tools: { plugins: ['tdd'] },
  timeouts: { stallMs: 1000, wallMs: 5000 },
  env: {},
});

const pendingAfterTurn = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setImmediate(() => resolve('pending'))),
  ]);

type HarnessCallResult = Awaited<ReturnType<fakeHarnessModule.FakeHarness['run']>>;
const cumulative = (outcome: HarnessCallResult) => outcome.result.usage.cumulative;
const usage = (outcome: HarnessCallResult) => outcome.result.usage;

test('a scripted response is returned and files are written into cwd', async () => {
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/0/1': { response: { claim: 'red', tests: ['t'] }, files: { 'test/a.test.mjs': 'x\n' } },
    },
  });
  const { response, result, failure } = await harness.run(call(cwd));
  assert.deepEqual(response, { claim: 'red', tests: ['t'] });
  assert.equal(result.status, 'completed');
  assert.equal(failure, null);
  assert.equal(await readFile(join(cwd, 'test', 'a.test.mjs'), 'utf8'), 'x\n');
});

test('calls record brief, resume, tools and persona bytes', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/0/1': { response: {} } } });
  const harnessCall = call(cwd);
  await harness.run(harnessCall);
  assert.equal(harness.calls.length, 1);
  const [recorded] = harness.calls;
  assert.equal(recorded.marker, harnessCall.marker);
  assert.equal(recorded.brief, harnessCall.brief);
  assert.equal(recorded.resume, null);
  assert.deepEqual(recorded.tools, harnessCall.tools);
  assert.equal(recorded.cwd, cwd);
  assert.equal(recorded.access, 'workspace-write');
  assert.equal(recorded.network, false);
  assert.equal(recorded.personaBytes, '# implementer\n');
  assert.equal(recorded.personaHash, 'sha256:persona');
  assert.deepEqual(recorded.schema, harnessCall.schema);
});

test('a new session has a transcript file and resume keeps it', async () => {
  const usage = {
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
    costUsd: 0.01,
    peakContextTokens: 10,
    turns: 1,
    toolCalls: 1,
    compactions: 0,
  };
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/0/1': { response: {}, result: { usage: { delta: usage } } },
      'implement/1/green/0/1': { response: {}, result: { usage: { delta: usage } } },
    },
  });
  const first = await harness.run(call(cwd));
  assert.match(first.result.sessionId ?? '', /^fake-session-\d+$/);
  assert.ok((await stat(first.result.transcriptPath ?? '')).isFile());
  const second = await harness.run(call(cwd, { phase: 'green', resume: first.result.sessionId }));
  assert.equal(second.result.sessionId, first.result.sessionId);
  assert.equal(second.result.transcriptPath, first.result.transcriptPath);
  assert.ok((cumulative(second).inputTokens ?? 0) >= (cumulative(first).inputTokens ?? 0));
  assert.ok((cumulative(second).outputTokens ?? 0) > (cumulative(first).outputTokens ?? 0));
  assert.equal(harness.calls[1].resume, first.result.sessionId);
});

test('concurrent new sessions get distinct ids, transcripts and usage', async () => {
  const delta = (input: number) => ({ result: { usage: { delta: { inputTokens: input } } }, response: {} });
  const { harness, cwd } = await setup({
    responses: {
      'a/1/red/0/1': delta(1),
      'b/1/red/0/1': delta(100),
      'a/1/green/0/1': delta(1),
    },
  });
  const [first, second] = await Promise.all([
    harness.run(call(cwd, { vertex: 'a' })),
    harness.run(call(cwd, { vertex: 'b' })),
  ]);
  assert.notEqual(first.result.sessionId, second.result.sessionId);
  assert.notEqual(first.result.transcriptPath, second.result.transcriptPath);
  const resumed = await harness.run(call(cwd, { vertex: 'a', phase: 'green', resume: first.result.sessionId }));
  assert.equal(cumulative(resumed).inputTokens, 2);
});

test('a scripted failure is a failed result, not a rejection', async () => {
  const { harness, cwd } = await setup({
    responses: { 'implement/1/red/0/1': { failure: { failureClass: 'transient', retryAfterMs: 5 } } },
  });
  const { result, failure } = await harness.run(call(cwd));
  assert.equal(result.status, 'failed');
  assert.equal(failure?.failureClass, 'transient');
  assert.equal(failure?.retryAfterMs, 5);
});

test('hang stays pending until cancel', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/0/1': { hang: true } } });
  const running = harness.run(call(cwd));
  assert.equal(await pendingAfterTurn(running), 'pending');
  harness.cancel();
  const { result } = await running;
  assert.equal(result.status, 'killed');
});

// A cancel that was lost leaves the call hung, which fails at the case timeout.
test('cancel immediately after run still kills a hung call', { timeout: 120_000 }, async () => {
  const { harness, cwd } = await setup({
    responses: { 'implement/1/red/0/1': { hang: true, files: { 'a.txt': 'a' } } },
  });
  const running = harness.run(call(cwd));
  harness.cancel();
  const { result } = await running;
  assert.equal(result.status, 'killed');
});

test('throw rejects as an unexpected fault', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/0/1': { throw: new Error('boom') } } });
  await assert.rejects(harness.run(call(cwd)), /boom/);
});

test('a null response is a completed result without a structured response', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/0/1': { response: null } } });
  const { response, result, failure } = await harness.run(call(cwd));
  assert.equal(response, null);
  assert.equal(result.status, 'completed');
  assert.equal(failure, null);
});

test('usage is null where the cost capability is absent', async () => {
  const { harness, cwd } = await setup({
    capabilities: { costReporting: false },
    responses: { 'implement/1/red/0/1': { response: {} } },
  });
  const outcome = await harness.run(call(cwd));
  assert.equal(usage(outcome).delta.costUsd, null);
  assert.equal(usage(outcome).cumulative.costUsd, null);
});

test('an unscripted key throws naming it', async () => {
  const { harness, cwd } = await setup({ responses: {} });
  await assert.rejects(
    async () => harness.run(call(cwd, { vertex: 'review', phase: 'review' })),
    /review\/1\/review\/0\/1/,
  );
});

test("a scripted costBasis comes back on the call's Usage delta", async () => {
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/0/1': { response: {}, result: { usage: { delta: { inputTokens: 1, costBasis: 'reported' } } } },
    },
  });
  const outcome = await harness.run(call(cwd));
  assert.equal(usage(outcome).delta.costBasis, 'reported');
});

// A recovery pass's Phase is recover whatever its number, so the key takes the Action and the Recovery Number from the
// call's Action Marker (#422, Q2 A).
test('two recovery passes of one Attempt take different scripted responses', async () => {
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/1/1': { response: { pass: 1 } },
      'implement/1/red/2/1': { response: { pass: 2 } },
    },
  });
  // A key the fake does not find throws, which reads here as its message, so the case fails on its assertion.
  const responseOf = (actionMarker: string) =>
    harness.run(call(cwd, { phase: 'recover', marker: actionMarker })).then(
      ({ response }) => response,
      (err: unknown) => (err as Error).message,
    );
  assert.deepEqual(
    [await responseOf('gg:e1:implement:1:red:1:r1:1'), await responseOf('gg:e1:implement:1:red:2:r1:1')],
    [{ pass: 1 }, { pass: 2 }],
  );
});
