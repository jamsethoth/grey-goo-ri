import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../../../lib/harnesses/contract.ts';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const fakeHarness = async (opts = {}) => {
  const fake = await import('../../support/fake-harness.ts');
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
  ['protectedPaths', 'harness is missing protectedPaths'],
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
  ['backgroundSessions', 'harness fake capabilities are missing backgroundSessions'],
  ['sessionResume', 'harness fake capabilities are missing sessionResume'],
  ['structuredOutput', 'harness fake capabilities are missing structuredOutput'],
  ['sandbox', 'harness fake capabilities are missing sandbox'],
  ['confinement', 'harness fake capabilities are missing confinement'],
  ['peakContextReporting', 'harness fake capabilities are missing peakContextReporting'],
  ['costReporting', 'harness fake capabilities are missing costReporting'],
  ['turnCountReporting', 'harness fake capabilities are missing turnCountReporting'],
  ['toolCallReporting', 'harness fake capabilities are missing toolCallReporting'],
  ['reasoningTokenReporting', 'harness fake capabilities are missing reasoningTokenReporting'],
  ['backgroundWork', 'harness fake capabilities are missing backgroundWork'],
]) {
  test(`assertHarness names a missing ${field} capability`, async () => {
    const harness = await fakeHarness();
    harness.capabilities = { ...harness.capabilities };
    delete harness.capabilities[field];
    assert.throws(() => contract.assertHarness(harness), { message });
  });
}

test('every Harness declares the paths that configure it', async () => {
  const { HARNESSES } = await import('../../../lib/harnesses/shipped.ts');
  const modules = readdirSync(new URL('../../../lib/harnesses/', import.meta.url))
    .filter((f) => !['contract.ts', 'shipped.ts'].includes(f))
    .map((f) => f.replace(/\.ts$/, ''));
  assert.deepEqual(Object.keys(HARNESSES).sort(), modules.sort(), 'every Harness module is shipped');
  assert.deepEqual(Object.fromEntries(Object.entries(HARNESSES).map(([name, h]) => [name, h.protectedPaths])), {
    claude: ['.claude/', '.mcp.json', 'CLAUDE.md'],
    codex: ['.codex/', 'AGENTS.md'],
  });
  assert.deepEqual((await fakeHarness()).protectedPaths, []);
  assert.deepEqual((await fakeHarness({ protectedPaths: ['.fake/'] })).protectedPaths, ['.fake/']);
});

test('USAGE_FIELDS lists the Usage fields', () => {
  assert.deepEqual(contract.USAGE_FIELDS, [
    'inputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens',
    'costUsd',
    'peakContextTokens',
    'turns',
    'toolCalls',
    'compactions',
  ]);
});

test('emptyUsage sets null for absent capabilities', () => {
  assert.deepEqual(
    contract.emptyUsage({
      costReporting: false,
      reasoningTokenReporting: false,
      peakContextReporting: true,
      turnCountReporting: true,
      toolCallReporting: true,
    }),
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      costUsd: null,
      peakContextTokens: 0,
      turns: 0,
      toolCalls: 0,
      compactions: 0,
    },
  );
});

test('emptyUsage with no usage capability present sets null for every field a capability gates', () => {
  assert.deepEqual(
    contract.emptyUsage({
      costReporting: false,
      reasoningTokenReporting: false,
      peakContextReporting: false,
      turnCountReporting: false,
      toolCallReporting: false,
    }),
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      costUsd: null,
      peakContextTokens: null,
      turns: null,
      toolCalls: null,
      compactions: 0,
    },
  );
});

test('CAPABILITY_FIELDS lists the Capability fields', () => {
  assert.deepEqual(contract.CAPABILITY_FIELDS, [
    'skills',
    'mcp',
    'plugins',
    'access',
    'network',
    'contextBudget',
    'interactive',
    'backgroundSessions',
    'sessionResume',
    'structuredOutput',
    'sandbox',
    'confinement',
    'peakContextReporting',
    'costReporting',
    'turnCountReporting',
    'toolCallReporting',
    'reasoningTokenReporting',
    'backgroundWork',
  ]);
});
