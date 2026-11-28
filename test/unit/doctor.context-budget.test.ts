// What every shipped Harness with a context budget checks of it under gg doctor --probe (#497 Q1 A, Q2 A): the
// starting context its profile probe's first request sent, and a warning for each Agent whose contextBudget is below
// twice it, over each Harness's CLI answering in-process as recorded. The check itself is cli-doctor.ts's startChecks.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as caseEnv from '../support/case-env.ts';
import * as exampleSource from '../support/example-source.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as recordedCodexCli from '../support/recorded-codex-cli.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// Each shipped Harness's CLI as recorded, by the name shipped gives it, and the context its profile probe's recording
// sent on its first request: Claude's success stream's first assistant message (input, cache reads and cache writes),
// Codex's start rollout's first token_count (last_token_usage.input_tokens).
const RECORDED: Record<string, { cli: () => ReturnType<typeof recordedCli.recordedCli>; start: number }> = {
  claude: { cli: () => recordedCli.recordedCli(), start: 9755 },
  codex: { cli: () => recordedCodexCli.recordedCodexCli({ rollouts: true }), start: 13_016 },
};

// The shipped Harnesses whose contextBudget Capability is supported, which the rule binds.
const budgeted = () =>
  Object.entries(shipped.HARNESSES)
    .filter(([, harness]) => harness.capabilities.contextBudget !== 'unsupported')
    .map(([name]) => name);

// The machine a case runs on until it ends: GG_HOME a directory of the case's, so gg's Codex home is the case's, and
// PATH one folder holding gg and, on win32, an unpackaged pwsh.
function machine(t: TestContext) {
  const directory = tempDirectory.tempDirectory(t, 'gg-doctor-budget-');
  const bin = join(directory, 'PowerShell', '7');
  mkdirSync(bin, { recursive: true });
  for (const file of process.platform === 'win32' ? ['pwsh.exe', 'gg.cmd'] : ['gg']) writeFileSync(join(bin, file), '');
  caseEnv.caseEnv(t, { PATH: bin, GG_HOME: join(directory, 'gg-home') });
}

// Harness `name`'s doctor over its recorded CLI.
function harnessDoctor(name: string) {
  return shipped.shipped(RECORDED[name]!.cli())[name]!.doctor as (
    options: runContext.DoctorOptions,
  ) => Promise<runContext.DoctorReport>;
}

const agent = (harness: string, more: Record<string, number> = {}) => ({
  harness,
  persona: 'implementer.md',
  access: 'read-only',
  ...more,
});

// What is wrong with Harness `name`'s budget checks under --probe, given an Agent below twice its recorded start, one
// above it and one with no budget: anything but one passed starting-context check naming the start and one
// context-budget warning naming the tight Agent alone. Empty when nothing is.
async function wrongBudgetChecks(name: string): Promise<string[]> {
  const { start } = RECORDED[name]!;
  const agents = {
    tight: agent(name, { contextBudget: start }),
    roomy: agent(name, { contextBudget: start * 10 }),
    unbudgeted: agent(name),
  };
  const { checks } = await harnessDoctor(name)({ probe: true, agents });
  const starts = checks.filter((check) => check.name === 'starting-context');
  const warnings = checks.filter((check) => check.name === 'context-budget');
  const wrong: string[] = [];
  if (starts.length !== 1 || !starts[0]!.ok || !starts[0]!.message.includes(String(start)))
    wrong.push(`${name}: starting-context ${JSON.stringify(starts)}`);
  const named = warnings.map(({ message, severity }) => ({ severity, tight: message.includes('agent tight') }));
  if (JSON.stringify(named) !== JSON.stringify([{ severity: 'warning', tight: true }]))
    wrong.push(`${name}: context-budget ${JSON.stringify(warnings)}`);
  return wrong;
}

// #497 Q2 A: one shared check, so every shipped Harness with a context budget reports its measured start under --probe
// and warns once for each Agent below twice it; a new such Harness without a recording here fails the first assert.
test('each budgeted shipped Harness reports its start under --probe and warns per Agent below twice it', async (t) => {
  machine(t);
  assert.deepEqual(Object.keys(RECORDED), budgeted());
  const wrong: string[] = [];
  for (const name of budgeted()) wrong.push(...(await wrongBudgetChecks(name)));
  assert.deepEqual(wrong, []);
});

// ADR 0028: the start is measured on a model call, which only --probe makes, so the cheap doctor judges no budget.
test('without --probe no shipped Harness measures a starting context or judges a contextBudget', async (t) => {
  machine(t);
  const seen: string[] = [];
  for (const name of budgeted()) {
    const agents = { tight: agent(name, { contextBudget: 1 }) };
    const { checks } = await harnessDoctor(name)({ probe: false, agents });
    for (const check of checks)
      if (check.name === 'starting-context' || check.name === 'context-budget') seen.push(`${name}: ${check.name}`);
  }
  assert.deepEqual(seen, []);
});

// A case that asks nobody reads no labels.
const DEPS = { gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh), cwd: '/repo' };
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// The example Source with every Agent on Harness `name`, as gg init --harness <name> writes it, and the reviewer's
// contextBudget `budget`; beside a user source that holds only the machine settings.
function exampleOn(name: string, budget: number): config.Configuration {
  const repository = exampleSource.config();
  for (const declared of Object.values(repository.agents)) declared.harness = name;
  exampleSource.putAt(repository, ['agents', 'reviewer', 'contextBudget'], budget);
  const files = Object.fromEntries(
    exampleSource.WRITTEN_NAMES.filter((written) => written !== 'gg.json').map((written) => [
      written,
      file(exampleSource.fixtureText(written)),
    ]),
  );
  return {
    repository,
    user: { maxParallel: 2, worktreeRoot: '~/worktrees' },
    repositoryFile: '/repo/.agents/gg/gg.json',
    userFile: '/home/.agents/gg/gg.json',
    files: { repository: files, user: {} },
  };
}

// #497 DoD 1, through #494's passed line: gg doctor --probe prints each Harness's measured start, and warns, naming the
// Agent, at the trial's budget of 8,000, below every recorded start.
test('gg doctor --probe prints the starting context and warns, naming the Agent, below twice it', async (t) => {
  machine(t);
  const wrong: string[] = [];
  for (const name of budgeted()) {
    const { start, cli } = RECORDED[name]!;
    const harnesses = shipped.shipped(cli());
    const { text } = await doctor.doctor({ config: exampleOn(name, 8000), ...DEPS, harnesses, probe: true });
    const lines = text.split('\n');
    const passed = lines.filter((line) => line.startsWith(`passed: harness ${name}: starting-context: `));
    const said = (kind: string, seen: string[]) => `${name} ${kind}: ${JSON.stringify(seen)}`;
    if (passed.length !== 1 || !passed[0]!.includes(String(start))) wrong.push(said('passed', passed));
    const warned = lines.filter(
      (line) =>
        line.startsWith(`warning: harness ${name}: context-budget: `) && line.endsWith(' [harness-doctor-failed]'),
    );
    if (warned.length !== 1 || !warned[0]!.includes('agent reviewer') || !warned[0]!.includes('8000'))
      wrong.push(said('warned', warned));
    const errors = lines.filter((line) => line.startsWith('error: '));
    if (errors.length) wrong.push(said('errors', errors));
  }
  assert.deepEqual(wrong, []);
});
