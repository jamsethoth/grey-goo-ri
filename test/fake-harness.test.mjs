import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const setup = async (opts = {}) => {
  const fake = await import('./support/fake-harness.mjs');
  const transcriptDir = await mkdtemp(join(tmpdir(), 'gg-fake-transcripts-'));
  const cwd = await mkdtemp(join(tmpdir(), 'gg-fake-cwd-'));
  return { harness: fake.fakeHarness({ transcriptDir, ...opts }), cwd };
};

const call = (cwd, overrides = {}) => ({
  marker: 'gg:1:implement/1/red/1',
  vertex: 'implement',
  visit: 1,
  phase: 'red',
  attempt: 1,
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
  ...overrides,
});

const pendingAfter = (promise, ms) => Promise.race([
  promise.then(() => 'settled', () => 'settled'),
  new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
]);

test('a scripted response is returned and files are written into cwd', async () => {
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/1': { response: { claim: 'red', tests: ['t'] }, files: { 'test/a.test.mjs': 'x\n' } },
    },
  });
  const { response, result, failure } = await harness.run(call(cwd));
  assert.deepEqual(response, { claim: 'red', tests: ['t'] });
  assert.equal(result.status, 'completed');
  assert.equal(failure, null);
  assert.equal(await readFile(join(cwd, 'test', 'a.test.mjs'), 'utf8'), 'x\n');
});

test('calls record brief, resume, tools and persona bytes', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/1': { response: {} } } });
  const c = call(cwd);
  await harness.run(c);
  assert.equal(harness.calls.length, 1);
  const [recorded] = harness.calls;
  assert.equal(recorded.marker, c.marker);
  assert.equal(recorded.brief, c.brief);
  assert.equal(recorded.resume, null);
  assert.deepEqual(recorded.tools, c.tools);
  assert.equal(recorded.cwd, cwd);
  assert.equal(recorded.access, 'workspace-write');
  assert.equal(recorded.network, false);
  assert.equal(recorded.personaBytes, '# implementer\n');
  assert.equal(recorded.personaHash, 'sha256:persona');
  assert.deepEqual(recorded.schema, c.schema);
});

test('a new session has a transcript file and resume keeps it', async () => {
  const usage = { input: 10, cached: 0, cacheWrite: 0, output: 5, reasoning: 0, costUsd: 0.01, peakContext: 10, turns: 1, toolCalls: 1, compactions: 0 };
  const { harness, cwd } = await setup({
    responses: {
      'implement/1/red/1': { response: {}, result: { usage: { delta: usage } } },
      'implement/1/green/1': { response: {}, result: { usage: { delta: usage } } },
    },
  });
  const first = await harness.run(call(cwd));
  assert.match(first.result.sessionId, /^fake-session-\d+$/);
  assert.ok((await stat(first.result.transcriptPath)).isFile());
  const second = await harness.run(call(cwd, { phase: 'green', marker: 'gg:1:implement/1/green/1', resume: first.result.sessionId }));
  assert.equal(second.result.sessionId, first.result.sessionId);
  assert.equal(second.result.transcriptPath, first.result.transcriptPath);
  assert.ok(second.result.usage.cumulative.input >= first.result.usage.cumulative.input);
  assert.ok(second.result.usage.cumulative.output > first.result.usage.cumulative.output);
  assert.equal(harness.calls[1].resume, first.result.sessionId);
});

test('concurrent new sessions get distinct ids, transcripts and usage', async () => {
  const delta = (input) => ({ result: { usage: { delta: { input } } }, response: {} });
  const { harness, cwd } = await setup({
    responses: {
      'a/1/red/1': delta(1), 'b/1/red/1': delta(100),
      'a/1/green/1': delta(1),
    },
  });
  const [a, b] = await Promise.all([
    harness.run(call(cwd, { vertex: 'a' })),
    harness.run(call(cwd, { vertex: 'b' })),
  ]);
  assert.notEqual(a.result.sessionId, b.result.sessionId);
  assert.notEqual(a.result.transcriptPath, b.result.transcriptPath);
  const resumed = await harness.run(call(cwd, { vertex: 'a', phase: 'green', resume: a.result.sessionId }));
  assert.equal(resumed.result.usage.cumulative.input, 2);
});

test('a scripted failure is a failed result, not a rejection', async () => {
  const { harness, cwd } = await setup({
    responses: { 'implement/1/red/1': { failure: { class: 'transient', retryAfterMs: 5 } } },
  });
  const { result, failure } = await harness.run(call(cwd));
  assert.equal(result.status, 'failed');
  assert.equal(failure.class, 'transient');
  assert.equal(failure.retryAfterMs, 5);
});

test('hang stays pending until cancel', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/1': { hang: true } } });
  const running = harness.run(call(cwd));
  assert.equal(await pendingAfter(running, 50), 'pending');
  harness.cancel();
  const { result } = await running;
  assert.equal(result.status, 'killed');
});

test('cancel immediately after run still kills a hung call', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/1': { hang: true, files: { 'a.txt': 'a' } } } });
  const running = harness.run(call(cwd));
  harness.cancel();
  assert.equal(await pendingAfter(running, 100), 'settled');
  const { result } = await running;
  assert.equal(result.status, 'killed');
});

test('throw rejects as an unexpected fault', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/1': { throw: new Error('boom') } } });
  await assert.rejects(harness.run(call(cwd)), /boom/);
});

test('a null response is a completed result without a structured response', async () => {
  const { harness, cwd } = await setup({ responses: { 'implement/1/red/1': { response: null } } });
  const { response, result, failure } = await harness.run(call(cwd));
  assert.equal(response, null);
  assert.equal(result.status, 'completed');
  assert.equal(failure, null);
});

test('usage is null where the cost capability is absent', async () => {
  const { harness, cwd } = await setup({
    capabilities: { cost: false },
    responses: { 'implement/1/red/1': { response: {} } },
  });
  const { result } = await harness.run(call(cwd));
  assert.equal(result.usage.delta.costUsd, null);
  assert.equal(result.usage.cumulative.costUsd, null);
});

test('an unscripted key throws naming it', async () => {
  const { harness, cwd } = await setup({ responses: {} });
  await assert.rejects(async () => harness.run(call(cwd, { vertex: 'review', phase: 'review' })), /review\/1\/review\/1/);
});
