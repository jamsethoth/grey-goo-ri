import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../../../lib/harnesses/contract.mjs';

const fakeHarness = async (opts = {}) => {
  const fake = await import('../../support/fake-harness.mjs');
  return fake.fakeHarness({ transcriptDir: await mkdtemp(join(tmpdir(), 'gg-contract-')), responses: {}, ...opts });
};

test('assertHarness accepts the fake harness', async () => {
  contract.assertHarness(await fakeHarness());
});

test('assertHarness names the first missing method', async () => {
  assert.throws(() => contract.assertHarness({}), /\bname\b/);
  for (const method of contract.HARNESS_METHODS) {
    const harness = await fakeHarness();
    delete harness[method];
    assert.throws(() => contract.assertHarness(harness), new RegExp(`\\b${method}\\b`));
  }
  for (const field of contract.CAPABILITY_FIELDS) {
    const harness = await fakeHarness();
    harness.capabilities = { ...harness.capabilities };
    delete harness.capabilities[field];
    assert.throws(() => contract.assertHarness(harness), new RegExp(`\\b${field}\\b`));
  }
});

test('emptyUsage sets null for absent capabilities', () => {
  assert.deepEqual(contract.USAGE_FIELDS, [
    'input', 'cached', 'cacheWrite', 'output', 'reasoning', 'costUsd', 'peakContext', 'turns', 'toolCalls', 'compactions',
  ]);
  for (const field of [
    'skills', 'mcp', 'plugins', 'access', 'network', 'contextBudget', 'interactive', 'background', 'resume',
    'structuredOutput', 'sandbox', 'confinement', 'peakContext', 'cost', 'turns', 'toolCalls', 'reasoningTokens',
    'backgroundWork',
  ]) assert.ok(contract.CAPABILITY_FIELDS.includes(field), `CAPABILITY_FIELDS has ${field}`);
  for (const method of [
    'name', 'capabilities', 'validate', 'resolveTools', 'run', 'interactiveArgs', 'metrics', 'doctor',
  ]) assert.ok(contract.HARNESS_METHODS.includes(method), `HARNESS_METHODS has ${method}`);

  const usage = contract.emptyUsage({ cost: false, reasoningTokens: false, peakContext: true, turns: true, toolCalls: true });
  assert.deepEqual(Object.keys(usage).sort(), [...contract.USAGE_FIELDS].sort());
  assert.equal(usage.costUsd, null);
  assert.equal(usage.reasoning, null);
  for (const field of ['input', 'cached', 'cacheWrite', 'output', 'peakContext', 'turns', 'toolCalls']) {
    assert.equal(usage[field], 0, field);
  }
  const bare = contract.emptyUsage({ cost: false, reasoningTokens: false, peakContext: false, turns: false, toolCalls: false });
  for (const field of ['costUsd', 'reasoning', 'peakContext', 'turns', 'toolCalls']) assert.equal(bare[field], null, field);
});
