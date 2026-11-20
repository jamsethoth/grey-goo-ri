// The Claude Harness's run over the fake claude CLI, which replays the calls recorded from Claude Code 2.1.328
// (test/fixtures/claude/, #425): the contract's result from the stream, Usage by the token rules, the failure classes,
// the stops, and the files a call writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as contract from '../../../lib/harnesses/contract.ts';
import * as claudeOverFakeCli from '../../support/claude-over-fake-cli.ts';

const { claudeCall, hooksOf } = claudeOverFakeCli;
const fakeCli = claudeOverFakeCli.claudeOverFakeCli;
const CASE = { timeout: 120_000 };

// The session the success recording opened, which the resume recording resumed.
const SUCCESS_SESSION = '56850773-3aa4-4cf7-ad6f-7a881aab76db';

// The Session's total after the success recording, as gg saved it: what the resumed call is given.
const AFTER_SUCCESS = {
  inputTokens: 4,
  cacheReadTokens: 9753,
  cacheWriteTokens: 10033,
  outputTokens: 241,
  reasoningTokens: null,
  costUsd: 0.0022250300000000002,
  peakContextTokens: 10035,
  turns: 4,
  toolCalls: 2,
  compactions: 0,
  costBasis: 'reported',
};

test('assertHarness accepts the Claude Harness built over the fake CLI', (t) => {
  const { harness } = fakeCli(t, { scenario: 'success' });
  contract.assertHarness(harness);
});

test('a completed call returns the structured output, session id and transcript path', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const { response, result } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.equal(result.status, 'completed');
  assert.deepEqual(response, { answer: 'heliotrope — slow.js printed: "slow done"' });
  assert.equal(result.sessionId, SUCCESS_SESSION);
  const transcriptPath = String(result.transcriptPath);
  assert.equal(basename(transcriptPath), `${SUCCESS_SESSION}.jsonl`);
  assert.ok(transcriptPath.startsWith(join(fake.configDirectory, 'projects')), transcriptPath);
  assert.ok(existsSync(transcriptPath), `the transcript the CLI wrote: ${transcriptPath}`);
});

test('a completed call reports the CLI version, the model, its exit and its counts', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    {
      agentCliVersion: result.agentCliVersion,
      effectiveModel: result.effectiveModel,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      finalEventSubtype: result.finalEventSubtype,
      commandsRun: result.commandsRun,
      turns: result.usage.delta.turns,
      toolCalls: result.usage.delta.toolCalls,
      peakContextTokens: result.usage.delta.peakContextTokens,
      failure,
    },
    {
      agentCliVersion: '2.1.328',
      effectiveModel: 'claude-haiku-5-5',
      exitCode: 0,
      exitSignal: null,
      finalEventSubtype: 'success',
      commandsRun: 1,
      turns: 4,
      toolCalls: 2,
      peakContextTokens: 10035,
      failure: null,
    },
  );
});

test('a run without structured output is completed with a null response', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'no-schema' });
  const { response, result } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual({ status: result.status, response }, { status: 'completed', response: null });
});

test('the brief goes to the CLI on stdin, never in its argv', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  await fake.harness.run(claudeCall(fake, { brief: 'the brief, on stdin' }), hooksOf());
  const { argv, stdin } = fake.received();
  assert.equal(stdin, 'the brief, on stdin');
  assert.deepEqual(
    argv.filter((argument) => argument.includes('the brief')),
    [],
  );
});

// Decision 5 (G16): the persona is written from the pinned bytes into the Run directory, and stays there.
test('the persona file is written into the run directory and kept', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  await fake.harness.run(claudeCall(fake), hooksOf());
  const persona = join(fake.runDirectory, `persona-${'a'.repeat(64)}.md`);
  assert.ok(existsSync(persona), `the persona file: ${persona}`);
  assert.equal(readFileSync(persona, 'utf8'), 'You are the implementer.\n');
});

// The Session's total with earlier compactions and a peak above the resumed call's, so the sum and the maximum show.
const EARLIER = { ...AFTER_SUCCESS, toolCalls: 5, compactions: 2, peakContextTokens: 20_000 };

test("a resumed call's delta is its cumulative less the earlier total", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'resume' });
  const { result } = await fake.harness.run(
    claudeCall(fake, { resume: SUCCESS_SESSION, previousUsage: EARLIER }),
    hooksOf(),
  );
  assert.deepEqual(result.usage, {
    cumulative: {
      inputTokens: 10,
      cacheReadTokens: 29937,
      cacheWriteTokens: 10247,
      outputTokens: 362,
      reasoningTokens: null,
      costUsd: 0.0025307700000000003,
      peakContextTokens: 20_000,
      turns: 7,
      toolCalls: 5,
      compactions: 2,
      costBasis: 'reported',
    },
    delta: {
      inputTokens: 6,
      cacheReadTokens: 20184,
      cacheWriteTokens: 214,
      outputTokens: 121,
      reasoningTokens: null,
      costUsd: 0.0003057400000000001,
      peakContextTokens: 10226,
      turns: 3,
      toolCalls: 0,
      compactions: 0,
      costBasis: 'reported',
    },
  });
});

test('input tokens exclude cache reads and writes', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const { result } = await fake.harness.run(claudeCall(fake), hooksOf());
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = result.usage.delta;
  assert.deepEqual(
    { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens },
    { inputTokens: 4, cacheReadTokens: 9753, cacheWriteTokens: 10033, outputTokens: 241 },
  );
});

// The resume recording makes no tool call and no compaction, so a call that makes both shows they add, not take a max.
test("a resumed call adds its tool calls and compactions to the earlier total's", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'compaction' });
  const { result } = await fake.harness.run(claudeCall(fake, { resume: SUCCESS_SESSION, previousUsage: EARLIER }), hooksOf());
  const countsOf = ({ turns, toolCalls, compactions }: typeof result.usage.delta) => ({
    turns,
    toolCalls,
    compactions,
  });
  assert.deepEqual(
    { cumulative: countsOf(result.usage.cumulative), delta: countsOf(result.usage.delta) },
    { cumulative: { turns: 14, toolCalls: 11, compactions: 3 }, delta: { turns: 10, toolCalls: 6, compactions: 1 } },
  );
});

// Owner, #424 D12 A: compaction stays on and must be evident, so the margin can be tuned.
test('a compaction in the stream is counted', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'compaction' });
  const { result } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    { cumulative: result.usage.cumulative.compactions, delta: result.usage.delta.compactions },
    { cumulative: 1, delta: 1 },
  );
});

test('a rate_limit retry before failure is rate-limited with its delay', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'api-retry' });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    { status: result.status, failureClass: failure?.failureClass, retryAfterMs: failure?.retryAfterMs },
    { status: 'failed', failureClass: 'rate-limited', retryAfterMs: 2014 },
  );
});

// The result says `success` on an API failure: the status comes from its is_error, the subtype is reported as sent.
test('an authentication failure is auth', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'auth-failure' });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    { status: result.status, failureClass: failure?.failureClass, finalEventSubtype: result.finalEventSubtype },
    { status: 'failed', failureClass: 'auth', finalEventSubtype: 'success' },
  );
});

// Claude carries on past a plugin it could not load and a failed MCP server, and completes; gg fails the call.
test('a plugin error in the init event fails the call', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'init-error' });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    {
      status: result.status,
      failureClass: failure?.failureClass,
      mcpServerErrors: (result.sessionInit as { mcpServerErrors?: unknown } | undefined)?.mcpServerErrors,
    },
    {
      status: 'failed',
      failureClass: 'unknown',
      mcpServerErrors: [{ name: 'broken', status: 'failed', source: 'dynamic' }],
    },
  );
});

test('permission denials are reported', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'denial-powershell' });
  const { result } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.ok(Array.isArray(result.permissionDenials), `denials: ${JSON.stringify(result.permissionDenials)}`);
  const denials = result.permissionDenials as {
    tool_name: string;
    tool_input: { command?: string; file_path?: string };
  }[];
  assert.deepEqual(
    denials.map((denial) => [denial.tool_name, denial.tool_input.command ?? denial.tool_input.file_path]),
    [
      ['PowerShell', 'git push origin HEAD:refs/heads/plain'],
      ['PowerShell', '& git push origin HEAD:refs/heads/amp'],
      ['PowerShell', 'iex "git push origin HEAD:refs/heads/iex"'],
      ['PowerShell', "Start-Process git -ArgumentList 'push','origin','HEAD:refs/heads/start' -Wait -NoNewWindow"],
      ['PowerShell', 'cmd /c git push origin HEAD:refs/heads/cmd'],
      ['PowerShell', "Set-Content -Path '<recording>/outside-shell.txt' -Value outside"],
      ['Write', '<recording>\\outside-write.txt'],
    ],
  );
});

// The recording showed --resume keeps the session id (no fork); the Harness reports the Session's first id.
test('a resumed call keeps the first session id', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'resume' });
  const { result } = await fake.harness.run(
    claudeCall(fake, { resume: SUCCESS_SESSION, previousUsage: AFTER_SUCCESS }),
    hooksOf(),
  );
  assert.equal(result.sessionId, SUCCESS_SESSION);
});

test('the repository digest changes when .claude/skills changes', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const skill = join(fake.cwd, '.claude', 'skills', 'probe');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'one\n');
  const before = (await fake.harness.run(claudeCall(fake), hooksOf())).result.repositoryDigest;
  writeFileSync(join(skill, 'SKILL.md'), 'two\n');
  const after = (await fake.harness.run(claudeCall(fake), hooksOf())).result.repositoryDigest;
  assert.equal(typeof before, 'string', `a digest: ${before}`);
  assert.equal(typeof after, 'string', `a digest: ${after}`);
  assert.notEqual(after, before);
});

// Clarify round 1: the digest is over the files' bytes, so two assets that decode to the same text still differ.
test('the repository digest tells apart binary assets that are not UTF-8', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const asset = join(fake.cwd, '.claude', 'skills', 'probe', 'asset.bin');
  mkdirSync(join(asset, '..'), { recursive: true });
  writeFileSync(asset, Buffer.from([0x80]));
  const before = (await fake.harness.run(claudeCall(fake), hooksOf())).result.repositoryDigest;
  writeFileSync(asset, Buffer.from([0x81]));
  const after = (await fake.harness.run(claudeCall(fake), hooksOf())).result.repositoryDigest;
  assert.notEqual(after, before);
});

// A Harness returns only once its processes are gone, or reports that it could not confirm it (L6, L11).
test("a Claude call's result reports its Command Cleanup", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const { result } = await fake.harness.run(claudeCall(fake), hooksOf());
  assert.deepEqual(
    { confirmed: result.cleanup?.confirmed, survivors: result.cleanup?.survivors },
    { confirmed: true, survivors: [] },
  );
});

test('a Claude call reports it has started before it resolves', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const reports: unknown[] = [];
  await fake.harness.run(claudeCall(fake), hooksOf({ started: (report) => reports.push(report) }));
  assert.equal(reports.length, 1, JSON.stringify(reports));
});

test('a call silent past stallMs is timed-out', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success', mode: 'hang' });
  const { result, failure } = await fake.harness.run(claudeCall(fake, { timeouts: { stallMs: 500 } }), hooksOf());
  assert.deepEqual({ status: result.status, failure }, { status: 'timed-out', failure: null });
});

test('a call past wallMs is timed-out', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success', mode: 'hang' });
  const { result, failure } = await fake.harness.run(claudeCall(fake, { timeouts: { wallMs: 500 } }), hooksOf());
  assert.deepEqual({ status: result.status, failure }, { status: 'timed-out', failure: null });
});

// Decision 3 (G4 A): the Harness applies the defaults, keeping the configured object as passed.
test('a call that sets no timeouts runs under the 900000 ms stall and 7200000 ms wall defaults', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const timeouts = {};
  await fake.harness.run(claudeCall(fake, { timeouts }), hooksOf());
  const [options] = fake.launches;
  assert.deepEqual(
    { stallMs: options?.stallMs, wallMs: options?.wallMs, timeouts },
    { stallMs: 900_000, wallMs: 7_200_000, timeouts: {} },
  );
});

// Decision 3: a stall is the stream and the transcript both still. The stream re-arms launch's stall clock itself,
// and the Harness's onIdle answers the transcript's last write, from which launch re-arms it (#423 Q2 A), so a tool
// that runs silent while the transcript grows keeps the call alive.
test("the stall clock's idle check answers the transcript's last write", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  const { result } = await fake.harness.run(claudeCall(fake), hooksOf());
  const onIdle = fake.launches[0]?.onIdle;
  assert.equal(typeof onIdle, 'function', 'the Harness gives launch an onIdle');
  const written = new Date('2026-11-19T12:00:00Z');
  utimesSync(String(result.transcriptPath), written, written);
  assert.equal(await onIdle?.(), written.getTime());
});

test('a call whose signal aborts is killed', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success', mode: 'hang' });
  const controller = new AbortController();
  const hooks = hooksOf({ started: () => controller.abort(), signal: controller.signal });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooks);
  assert.deepEqual({ status: result.status, failure }, { status: 'killed', failure: null });
});

test('interactiveArgs, metrics and doctor throw not implemented until their slices', (t) => {
  const { harness } = fakeCli(t, { scenario: 'success' });
  assert.throws(() => harness.interactiveArgs({}, 'opening'), { message: 'not implemented' });
  assert.throws(() => harness.metrics(SUCCESS_SESSION), { message: 'not implemented' });
  assert.throws(() => harness.doctor({}), { message: 'not implemented' });
});

// Every way a call can fail resolves a typed result: a Harness never throws or rejects for an expected failure
// (request section 4). Each row is the fake's recording and mode, the call's changes, and whether its signal aborts.
const FAILURE_PATHS: [string, claudeOverFakeCli.FakeCli, Record<string, unknown>, boolean][] = [
  ['an authentication failure', { scenario: 'auth-failure' }, {}, false],
  ['retries before a failure', { scenario: 'api-retry' }, {}, false],
  ['an init error', { scenario: 'init-error' }, {}, false],
  ['a stream with no result line', { scenario: 'success', mode: 'no-result' }, {}, false],
  ['a nonzero exit with no result line', { scenario: 'auth-failure', mode: 'no-result' }, {}, false],
  [
    'a stall with no transcript to read',
    { scenario: 'success', mode: 'hang-no-transcript' },
    { timeouts: { stallMs: 500 } },
    false,
  ],
  ['a line that is not JSON', { scenario: 'success', mode: 'garbage' }, {}, false],
  ['an executable that cannot start', { scenario: 'success', command: 'gg-no-such-claude' }, {}, false],
  ['a stall', { scenario: 'success', mode: 'hang' }, { timeouts: { stallMs: 500 } }, false],
  ['the wall clock', { scenario: 'success', mode: 'hang' }, { timeouts: { wallMs: 500 } }, false],
  ['a cancel', { scenario: 'success', mode: 'hang' }, {}, true],
];

test('every failure path resolves a typed result, never a rejection', { timeout: 300_000 }, async (t) => {
  const ended: Record<string, unknown> = {};
  for (const [name, cli, changes, cancels] of FAILURE_PATHS) {
    const fake = fakeCli(t, cli);
    const controller = new AbortController();
    const hooks = hooksOf({ started: () => cancels && controller.abort(), signal: controller.signal });
    try {
      const { result, failure } = await fake.harness.run(claudeCall(fake, changes), hooks);
      ended[name] = { status: result.status, failureClass: failure?.failureClass ?? null };
    } catch (err) {
      ended[name] = `rejected: ${(err as Error).message}`;
    }
  }
  assert.deepEqual(ended, {
    'an authentication failure': { status: 'failed', failureClass: 'auth' },
    'retries before a failure': { status: 'failed', failureClass: 'rate-limited' },
    'an init error': { status: 'failed', failureClass: 'unknown' },
    'a stream with no result line': { status: 'failed', failureClass: 'unknown' },
    'a nonzero exit with no result line': { status: 'failed', failureClass: 'unknown' },
    'a stall with no transcript to read': { status: 'timed-out', failureClass: null },
    'a line that is not JSON': { status: 'completed', failureClass: null },
    'an executable that cannot start': { status: 'failed', failureClass: 'unknown' },
    'a stall': { status: 'timed-out', failureClass: null },
    'the wall clock': { status: 'timed-out', failureClass: null },
    'a cancel': { status: 'killed', failureClass: null },
  });
});

// The reporting Capability each Usage field turns on (docs/interfaces/harness.md, Usage); the others always count.
const USAGE_CAPABILITY: Record<string, string> = {
  reasoningTokens: 'reasoningTokenReporting',
  costUsd: 'costReporting',
  peakContextTokens: 'peakContextReporting',
  turns: 'turnCountReporting',
  toolCalls: 'toolCallReporting',
};

// Every Usage field, in both halves: null where its Capability is absent and a number otherwise, and every summed
// field's delta is its cumulative less the earlier total (peakContextTokens is a maximum, not a sum).
test(
  'every Usage field follows its Capability, and a summed field is its cumulative less the earlier total',
  CASE,
  async (t) => {
    const fake = fakeCli(t, { scenario: 'resume' });
    const { result } = await fake.harness.run(
      claudeCall(fake, { resume: SUCCESS_SESSION, previousUsage: AFTER_SUCCESS }),
      hooksOf(),
    );
    const capabilities = fake.harness.capabilities as Record<string, unknown>;
    const broken: string[] = [];
    for (const field of contract.USAGE_FIELDS as contract.CountField[]) {
      const reported = !USAGE_CAPABILITY[field] || capabilities[USAGE_CAPABILITY[field]] === true;
      for (const half of ['cumulative', 'delta'] as const) {
        const value = result.usage[half][field];
        if (reported ? typeof value !== 'number' : value !== null) broken.push(`${half}.${field} is ${value}`);
      }
      const [cumulative, delta, earlier] = [
        result.usage.cumulative[field],
        result.usage.delta[field],
        AFTER_SUCCESS[field],
      ];
      if (reported && field !== 'peakContextTokens' && delta !== (cumulative ?? 0) - (earlier ?? 0))
        broken.push(`delta.${field} ${delta} is not ${cumulative} less ${earlier}`);
    }
    assert.deepEqual(broken, []);
  },
);
