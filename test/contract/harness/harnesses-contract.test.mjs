import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../../../lib/harnesses/contract.mjs';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const fakeHarness = async (opts = {}) => {
  const fake = await import('../../support/fake-harness.mjs');
  const transcriptDir = await mkdtemp(join(tmpdir(), 'gg-contract-'));
  dirs.push(transcriptDir);
  return fake.fakeHarness({ transcriptDir, responses: {}, ...opts });
};

test('assertHarness accepts the fake harness', async () => {
  contract.assertHarness(await fakeHarness());
});

test('assertHarness names the first missing method', () => {
  assert.throws(() => contract.assertHarness({}), { message: 'harness is missing name' });
});

for (const [method, message] of [
  ['name', 'harness is missing name'],
  ['capabilities', 'harness is missing capabilities'],
  ['validate', 'harness is missing validate'],
  ['resolveTools', 'harness is missing resolveTools'],
  ['run', 'harness is missing run'],
  ['interactiveArgs', 'harness is missing interactiveArgs'],
  ['metrics', 'harness is missing metrics'],
  ['doctor', 'harness is missing doctor'],
]) {
  test(`assertHarness names a missing ${method}`, async () => {
    const harness = await fakeHarness();
    delete harness[method];
    assert.throws(() => contract.assertHarness(harness), { message });
  });
}

for (const [field, message] of [
  ['skills', 'harness fake capabilities are missing skills'],
  ['mcp', 'harness fake capabilities are missing mcp'],
  ['plugins', 'harness fake capabilities are missing plugins'],
  ['access', 'harness fake capabilities are missing access'],
  ['network', 'harness fake capabilities are missing network'],
  ['contextBudget', 'harness fake capabilities are missing contextBudget'],
  ['interactive', 'harness fake capabilities are missing interactive'],
  ['background', 'harness fake capabilities are missing background'],
  ['resume', 'harness fake capabilities are missing resume'],
  ['structuredOutput', 'harness fake capabilities are missing structuredOutput'],
  ['sandbox', 'harness fake capabilities are missing sandbox'],
  ['confinement', 'harness fake capabilities are missing confinement'],
  ['peakContext', 'harness fake capabilities are missing peakContext'],
  ['cost', 'harness fake capabilities are missing cost'],
  ['turns', 'harness fake capabilities are missing turns'],
  ['toolCalls', 'harness fake capabilities are missing toolCalls'],
  ['reasoningTokens', 'harness fake capabilities are missing reasoningTokens'],
  ['backgroundWork', 'harness fake capabilities are missing backgroundWork'],
]) {
  test(`assertHarness names a missing ${field} capability`, async () => {
    const harness = await fakeHarness();
    harness.capabilities = { ...harness.capabilities };
    delete harness.capabilities[field];
    assert.throws(() => contract.assertHarness(harness), { message });
  });
}

test('USAGE_FIELDS lists the Usage fields', () => {
  assert.deepEqual(contract.USAGE_FIELDS, [
    'input', 'cached', 'cacheWrite', 'output', 'reasoning', 'costUsd', 'peakContext', 'turns', 'toolCalls', 'compactions',
  ]);
});

test('emptyUsage sets null for absent capabilities', () => {
  assert.deepEqual(contract.emptyUsage({ cost: false, reasoningTokens: false, peakContext: true, turns: true, toolCalls: true }), {
    input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: null, costUsd: null, peakContext: 0, turns: 0, toolCalls: 0, compactions: 0,
  });
});

test('emptyUsage with no usage capability present sets null for every field a capability gates', () => {
  assert.deepEqual(contract.emptyUsage({ cost: false, reasoningTokens: false, peakContext: false, turns: false, toolCalls: false }), {
    input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: null, costUsd: null, peakContext: null, turns: null, toolCalls: null, compactions: 0,
  });
});
