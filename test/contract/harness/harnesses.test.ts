import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../../../lib/exec.ts';
import * as contract from '../../../lib/harnesses/contract.ts';
import * as claudeOverFakeCli from '../../support/claude-over-fake-cli.ts';
import type * as fakeHarnessModule from '../../support/fake-harness.ts';

const CASE = { timeout: 120_000 };
const dirs: string[] = [];

// The modules in lib/harnesses/ that are no Harness: the contract, the shipped list, the modules a Harness splits
// along a seam inside it, and gg ask-session, which questions a Claude Session outside any Attempt (#430).
const NOT_HARNESSES = [
  'contract.ts',
  'shipped.ts',
  'claude-stream.ts',
  'claude-doctor.ts',
  'claude-handoff-hook.ts',
  'claude-plugins.ts',
  'codex-doctor.ts',
  'codex-plugins.ts',
  'codex-skills.ts',
  'codex-stream.ts',
  'codex-run.ts',
  'ask-session.ts',
  'cli-call.ts',
  'cli-doctor.ts',
];
after(() => Promise.all(dirs.map((directory) => rm(directory, { recursive: true, force: true }))));

const fakeHarness = async (options: Partial<fakeHarnessModule.FakeHarnessOptions> = {}) => {
  const fake = await import('../../support/fake-harness.ts');
  const transcriptDir = await mkdtemp(join(tmpdir(), 'gg-contract-'));
  dirs.push(transcriptDir);
  return fake.fakeHarness({ transcriptDir, responses: {}, ...options });
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
  ['launchProfile', 'harness is missing launchProfile'],
  ['validate', 'harness is missing validate'],
  ['resolveTools', 'harness is missing resolveTools'],
  ['run', 'harness is missing run'],
  ['interactiveArgs', 'harness is missing interactiveArgs'],
  ['metrics', 'harness is missing metrics'],
  ['doctor', 'harness is missing doctor'],
]) {
  test(`assertHarness names a missing ${method}`, async () => {
    const harness: Record<string, unknown> = await fakeHarness();
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
    const capabilities: Record<string, unknown> = { ...harness.capabilities };
    harness.capabilities = capabilities as typeof harness.capabilities;
    delete capabilities[field];
    assert.throws(() => contract.assertHarness(harness), { message });
  });
}

test('every Harness declares the paths that configure it', async () => {
  const shipped = await import('../../../lib/harnesses/shipped.ts');
  const modules = readdirSync(new URL('../../../lib/harnesses/', import.meta.url))
    .filter((file) => !NOT_HARNESSES.includes(file))
    .map((file) => file.replace(/\.ts$/, ''));
  assert.deepEqual(Object.keys(shipped.HARNESSES).sort(), modules.sort(), 'every Harness module is shipped');
  assert.deepEqual(
    Object.fromEntries(Object.entries(shipped.HARNESSES).map(([name, harness]) => [name, harness.protectedPaths])),
    {
      claude: ['.claude/', '.mcp.json', 'CLAUDE.md'],
      codex: ['.codex/', 'AGENTS.md'],
    },
  );
  assert.deepEqual((await fakeHarness()).protectedPaths, []);
  assert.deepEqual((await fakeHarness({ protectedPaths: ['.fake/'] })).protectedPaths, ['.fake/']);
});

// A Harness starts its CLI only through the exec bin/gg.ts builds and passes down (ADR 0019, #423), so shipped builds
// every Harness module from the exec it is given, each keeping every contract member it declares and holding no other.
// The sentinel launch shows the built Claude run starts its CLI through that exec (#423 D8).
test('shipped builds every Harness module from the exec it is given', CASE, async (t) => {
  const shipped = await import('../../../lib/harnesses/shipped.ts');
  const modules = readdirSync(new URL('../../../lib/harnesses/', import.meta.url))
    .filter((file) => !NOT_HARNESSES.includes(file))
    .map((file) => file.replace(/\.ts$/, ''));
  const launched: string[] = [];
  const launch = (options: exec.LaunchOptions) => {
    launched.push(options.command);
    return Promise.reject(new Error('the sentinel launch starts nothing'));
  };
  const built = shipped.shipped({
    launch,
    childInJob: () => Promise.reject(new Error('the sentinel probe starts nothing')),
  });
  assert.deepEqual(Object.keys(built).sort(), modules.sort(), 'every Harness module is built');
  for (const name of modules) {
    const harness = built[name] as Record<string, unknown>;
    const declared = shipped.HARNESSES[name as keyof typeof shipped.HARNESSES];
    for (const member of Object.keys(declared).filter((member) => contract.HARNESS_METHODS.includes(member)))
      assert.equal(
        harness[member],
        (declared as Record<string, unknown>)[member],
        `${name} keeps its declared ${member}`,
      );
    const extra = Object.keys(harness).filter((member) => !contract.HARNESS_METHODS.includes(member));
    assert.deepEqual(extra, [], `${name} holds only contract members`);
  }
  const fake = claudeOverFakeCli.claudeOverFakeCli(t, { scenario: 'success' });
  const run = built.claude!.run as typeof fake.harness.run;
  await run(claudeOverFakeCli.claudeCall(fake), claudeOverFakeCli.hooksOf());
  assert.equal(launched.length, 1, 'the built Claude run launched through the exec shipped was given');
});

// The launch profile is a contract member (#428 Q1 A), so gg reads it from the Harness it runs, as it reads its
// Protected Files: Claude's from its declaration, and none from Codex or the fake.
test('each shipped Harness keeps its launch profile, and the fake declares none', async () => {
  const shipped = await import('../../../lib/harnesses/shipped.ts');
  const built = shipped.shipped(exec.createExec({ kernel32: null }));
  assert.deepEqual(
    {
      claude: built.claude!.launchProfile,
      codex: built.codex!.launchProfile,
      fake: ((await fakeHarness()) as Record<string, unknown>).launchProfile,
    },
    // The hand-off hook joined gg's settings file at version 3 (#430).
    { claude: { name: 'claude-headless', version: 3 }, codex: { name: 'codex-exec', version: 1 }, fake: null },
  );
});

// A Harness returns only once its processes are gone, or reports that it could not confirm it (L6, L11).
test("a Harness's result reports its Command Cleanup", async () => {
  const call = {
    marker: 'gg:e1:v:1:p:0:r1:1',
    vertex: 'v',
    visit: 1,
    phase: 'p',
    attempt: 1,
    cwd: dirs[0] ?? tmpdir(),
  };
  const harness = await fakeHarness({ responses: { 'v/1/p/0/1': { response: { claim: 'ok' } } } });
  const { result } = await harness.run(call);
  assert.equal((result.cleanup as { confirmed: unknown }).confirmed, true);
  assert.deepEqual((result.cleanup as { survivors: unknown }).survivors, []);
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
