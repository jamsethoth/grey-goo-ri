// The Codex Harness's run over the fake codex CLI, which replays the calls recorded from codex-cli 0.171.0
// (test/fixtures/codex/, #479): the contract's result from the stream, the -o file and the rollout, Usage by the token
// rules, the failure classes, the resume checks, the stops, and the prompt a call sends (#482).
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as briefs from '../../../lib/briefs.ts';
import * as codex from '../../../lib/harnesses/codex.ts';
import * as codexDoctor from '../../../lib/harnesses/codex-doctor.ts';
import * as contract from '../../../lib/harnesses/contract.ts';
import * as codexHookHandlers from '../../support/codex-hook-handlers.ts';
import * as codexOverFakeCli from '../../support/codex-over-fake-cli.ts';

const { codexCall, hooksOf } = codexOverFakeCli;
const fakeCli = codexOverFakeCli.codexOverFakeCli;
const CASE = { timeout: 120_000 };
const TABLE = { timeout: 300_000 };

// The thread the start recording opened, which resume-flags-before and resume-config-after resumed, and its rollout.
const START_THREAD = '01a2044a-1251-7180-8d49-dc1220e52393';
const START_ROLLOUT = `rollout-2026-11-22T12-24-53-${START_THREAD}.jsonl`;

// The thread's total after the start recording, as gg saved it: what a resumed call is given. Codex's input_tokens
// holds its cached tokens, so inputTokens is the uncached rest (request 3.7).
const AFTER_START = {
  inputTokens: 13427,
  cacheReadTokens: 12800,
  cacheWriteTokens: 0,
  outputTokens: 110,
  reasoningTokens: 0,
  costUsd: null,
  peakContextTokens: null,
  turns: null,
  toolCalls: 1,
  compactions: null,
  costBasis: null,
};

// The usage-limit recording's turn.failed text, as Codex 0.171 wrote it.
const USAGE_LIMIT =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit ' +
  'https://chatgpt.com/settings/usage to purchase more credits or try again later.';

// A resumed call of the start thread, under `access`.
const resumed = (access: string) => ({ resume: START_THREAD, access, previousUsage: AFTER_START });

// A stand-in, not a recording: no MXC setup failure is recorded (docs/research/codex-cli.md question 5), so the start
// recording's turn ends in an error that names MXC.
const MXC_ERROR = 'windows sandbox: mxc setup failed: the stand-in error no recording shows';
const mxcFailure = (recorded: string) =>
  [
    ...recorded.split('\n').slice(0, 2),
    JSON.stringify({ type: 'error', message: MXC_ERROR }),
    JSON.stringify({ type: 'turn.failed', error: { message: MXC_ERROR } }),
    '',
  ].join('\n');

test('assertHarness accepts the Codex Harness built over the fake CLI', (t) => {
  const { harness } = fakeCli(t, { scenario: 'start' });
  contract.assertHarness(harness);
});

test('a completed call returns the final message, thread id and rollout path', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start' });
  const { response, result } = await fake.harness.run(codexCall(fake), hooksOf());
  const transcriptPath = String(result.transcriptPath);
  assert.deepEqual(
    {
      status: result.status,
      response,
      sessionId: result.sessionId,
      rollout: basename(transcriptPath),
      inSessions: transcriptPath.startsWith(join(fake.codexHome, 'sessions')),
      written: existsSync(transcriptPath),
    },
    {
      status: 'completed',
      response: { answer: 'heliotrope' },
      sessionId: START_THREAD,
      rollout: START_ROLLOUT,
      inSessions: true,
      written: true,
    },
  );
});

// Q18 A: no repository content reaches a call, so there is no repository configuration to digest.
test(
  'a completed call reports the CLI version, the model and effort, its exit and no repository digest',
  CASE,
  async (t) => {
    const fake = fakeCli(t, { scenario: 'start' });
    const { result, failure } = await fake.harness.run(codexCall(fake), hooksOf());
    assert.deepEqual(
      {
        agentCliVersion: result.agentCliVersion,
        effectiveModel: result.effectiveModel,
        effectiveEffort: result.effectiveEffort,
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        repositoryDigest: result.repositoryDigest,
        toolCalls: result.usage.delta.toolCalls,
        failure,
      },
      {
        agentCliVersion: '0.171.0',
        effectiveModel: 'gpt-6-luna',
        effectiveEffort: 'low',
        exitCode: 0,
        exitSignal: null,
        repositoryDigest: null,
        toolCalls: 1,
        failure: null,
      },
    );
  },
);

test('a Codex call reports its start and its Command Cleanup', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start' });
  const reports: unknown[] = [];
  const { result } = await fake.harness.run(codexCall(fake), hooksOf({ started: (report) => reports.push(report) }));
  assert.deepEqual(
    { started: reports.length, confirmed: result.cleanup?.confirmed, survivors: result.cleanup?.survivors },
    { started: 1, confirmed: true, survivors: [] },
  );
});

// Decision 2 (F2, codex#19816): the response is the -o file's final message, never a message the stream sent first,
// here one that fits the schema too.
test('the response is the final message from -o, never an earlier message in the stream', CASE, async (t) => {
  const fake = fakeCli(t, {
    scenario: 'start',
    stream: (recorded) =>
      recorded.replace(
        /"type":"agent_message","text":"(?:[^"\\]|\\.)*"/g,
        '"type":"agent_message","text":"{\\"answer\\":\\"an earlier message\\"}"',
      ),
  });
  const { response } = await fake.harness.run(codexCall(fake), hooksOf());
  assert.deepEqual(response, { answer: 'heliotrope' });
});

// The request 3.2 regression: with an MCP server active, --output-schema still holds the final message.
test('the schema with an MCP server active still validates the final message', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'mcp-schema' });
  const call = codexCall(fake);
  const { response, result } = await fake.harness.run(call, hooksOf());
  const answer = 'The probe tool requires approval, but approval is unavailable, so it did not return a word.';
  assert.deepEqual(
    {
      status: result.status,
      response,
      claim: briefs.validateResponse(call.schema as Parameters<typeof briefs.validateResponse>[0], response).valid,
    },
    { status: 'completed', response: { answer }, claim: true },
  );
});

// The versioned regression fixture of request 3.2 (codex#19816), a case of its own: recorded on the Codex gg pins, a
// call with a config MCP server active sends a plain-text message before the tool call and the schema's JSON as its
// final message, and gg's response is that final message. A new Codex minimum fails it until it is re-recorded.
test('codex#19816 regression, recorded on the pinned codex-cli: the response is the final message', CASE, async (t) => {
  const fixture = (extension: string) =>
    readFileSync(new URL(`../../fixtures/codex/mcp-schema${extension}`, import.meta.url), 'utf8');
  const recorded = JSON.parse(fixture('.json')) as { cliVersion: string; lastMessage: string };
  const messages = fixture('.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; item?: { type: string; text?: string } })
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => event.item?.text);
  const fake = fakeCli(t, { scenario: 'mcp-schema' });
  const { response } = await fake.harness.run(codexCall(fake), hooksOf());
  assert.deepEqual(
    {
      cliVersion: recorded.cliVersion,
      finalIsLastMessage: messages.at(-1) === recorded.lastMessage,
      firstIsJson: messages[0]?.startsWith('{'),
      response,
    },
    {
      cliVersion: `codex-cli ${codexDoctor.MINIMUM_VERSION}`,
      finalIsLastMessage: true,
      firstIsJson: false,
      response: JSON.parse(recorded.lastMessage) as unknown,
    },
  );
});

test('the prompt goes to the CLI on stdin, never in its argv', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start' });
  await fake.harness.run(codexCall(fake, { brief: 'the brief, on stdin' }), hooksOf());
  const { argv, stdin } = fake.received();
  assert.deepEqual(
    {
      endsWithBrief: String(stdin).endsWith('the brief, on stdin'),
      inArgv: argv.filter((argument) => argument.includes('the brief')),
    },
    { endsWithBrief: true, inArgv: [] },
  );
});

// Decision 6 (ported, feature-flow 89e1d67 lib/adapters.mjs:70-71): Codex has no system-prompt flag, so the persona
// leads a Session's first prompt; a resumed thread already holds it.
test('the persona reaches the first prompt only', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: ['start', 'resume-flags-before'] });
  const brief = 'Read README.md and answer with the word it names.';
  await fake.harness.run(codexCall(fake, { brief }), hooksOf());
  await fake.harness.run(codexCall(fake, { brief, ...resumed('workspace-write') }), hooksOf());
  const [first, second] = fake.calls();
  assert.deepEqual(
    {
      first: { persona: first?.stdin.startsWith('You are the implementer.\n'), brief: first?.stdin.endsWith(brief) },
      resumed: second?.stdin,
    },
    { first: { persona: true, brief: true }, resumed: brief },
  );
});

// Q4 A: gg's skills list goes with the persona into a Session's first prompt only. A hand-off successor's Session is
// fresh (its call has no resume), so its first prompt carries both.
test('the skills list reaches the first prompt only, as the persona does', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: ['start', 'resume-flags-before'] });
  const skill = join(fake.codexHome, 'skills', '.system', 'probe-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: probe-skill\ndescription: A skill the probe lists.\n---\n');
  await fake.harness.run(codexCall(fake), hooksOf());
  await fake.harness.run(codexCall(fake, resumed('workspace-write')), hooksOf());
  const [first, second] = fake.calls();
  const listing = '- probe-skill: A skill the probe lists.';
  assert.deepEqual(
    { first: first?.stdin.includes(listing), resumed: second?.stdin.includes(listing) },
    { first: true, resumed: false },
  );
});

// ADR 0031 point 7, #481 Q2 A: each call lists what Codex has installed afresh before it spawns, never the listing an
// earlier call took.
test('each call lists the plugins and MCP servers afresh before it spawns', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start' });
  await fake.harness.run(codexCall(fake), hooksOf());
  await fake.harness.run(codexCall(fake), hooksOf());
  const started = (command: string) => fake.launches.filter(({ args }) => args[0] === command).length;
  assert.deepEqual(
    { plugin: started('plugin'), mcp: started('mcp'), exec: started('exec') },
    { plugin: 2, mcp: 2, exec: 2 },
  );
});

// Decision 6 (ported, lib/adapters.mjs:73): the thread id from thread.started, else the resume id.
test('a resume with no thread.started keeps the resume id', CASE, async (t) => {
  const fake = fakeCli(t, {
    scenario: 'resume-flags-before',
    stream: (recorded) =>
      recorded
        .split('\n')
        .filter((line) => !line.includes('"thread.started"'))
        .join('\n'),
  });
  const { result } = await fake.harness.run(codexCall(fake, resumed('workspace-write')), hooksOf());
  assert.deepEqual(
    { status: result.status, sessionId: result.sessionId },
    { status: 'completed', sessionId: START_THREAD },
  );
});

// Decision 3 (F3): turn.completed's usage is the thread's cumulative total; this call's share is it less the total gg
// saved after the last call. Codex reports no cost, peak context, turns or compactions, so each stays null.
test("a resumed call's delta is its cumulative less the earlier total", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'resume-flags-before' });
  const { result } = await fake.harness.run(codexCall(fake, resumed('workspace-write')), hooksOf());
  assert.deepEqual(result.usage, {
    cumulative: {
      inputTokens: 14535,
      cacheReadTokens: 39424,
      cacheWriteTokens: 0,
      outputTokens: 263,
      reasoningTokens: 0,
      costUsd: null,
      peakContextTokens: null,
      turns: null,
      toolCalls: 2,
      compactions: null,
      costBasis: null,
    },
    delta: {
      inputTokens: 1108,
      cacheReadTokens: 26624,
      cacheWriteTokens: 0,
      outputTokens: 153,
      reasoningTokens: 0,
      costUsd: null,
      peakContextTokens: null,
      turns: null,
      toolCalls: 1,
      compactions: null,
      costBasis: null,
    },
  });
});

// Request section 2, #487: a count the stream never reported is null, never 0; the stream's own tool calls still count.
test('a call with no turn.completed reports null Usage', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start', mode: 'no-result' });
  const { result } = await fake.harness.run(codexCall(fake), hooksOf());
  const unreported = {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    costUsd: null,
    peakContextTokens: null,
    turns: null,
    toolCalls: 1,
    compactions: null,
    costBasis: null,
  };
  assert.deepEqual(result.usage, { cumulative: unreported, delta: unreported });
});

test('a usage-limit failure is quota', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'usage-limit' });
  const { response, result, failure } = await fake.harness.run(codexCall(fake), hooksOf());
  assert.deepEqual(
    { status: result.status, response, failure },
    { status: 'failed', response: null, failure: { failureClass: 'quota', retryAfterMs: null, message: USAGE_LIMIT } },
  );
});

test('an auth failure is auth', CASE, async (t) => {
  const invalid = fakeCli(t, { scenario: 'auth-invalid' });
  const missing = fakeCli(t, { scenario: 'auth-missing' });
  const ended = {
    invalid: await invalid.harness.run(codexCall(invalid), hooksOf()),
    missing: await missing.harness.run(codexCall(missing), hooksOf()),
  };
  assert.deepEqual(
    {
      invalid: { status: ended.invalid.result.status, failureClass: ended.invalid.failure?.failureClass },
      missing: { status: ended.missing.result.status, failureClass: ended.missing.failure?.failureClass },
    },
    { invalid: { status: 'failed', failureClass: 'auth' }, missing: { status: 'failed', failureClass: 'auth' } },
  );
});

// Decision 6 (ported, lib/adapters.mjs:74-78): a resume recomputes the sandbox from its own flags (openai/codex#40149),
// so the rollout's last turn says what it ran under; a read-only call whose turn ran workspace-write gives nothing.
test('a resume whose rollout records another sandbox discards the output', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'resume-flags-before' });
  const { response, result, failure } = await fake.harness.run(codexCall(fake, resumed('read-only')), hooksOf());
  assert.deepEqual(
    { status: result.status, response, failureClass: failure?.failureClass },
    { status: 'failed', response: null, failureClass: 'unknown' },
  );
});

test('a resume whose rollout is missing fails closed', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'resume-flags-before', rollout: false });
  const { response, result, failure } = await fake.harness.run(codexCall(fake, resumed('workspace-write')), hooksOf());
  assert.deepEqual(
    { status: result.status, response, failureClass: failure?.failureClass, transcriptPath: result.transcriptPath },
    { status: 'failed', response: null, failureClass: 'unknown', transcriptPath: null },
  );
});

// Every resume passes -s and -C before resume, where a resumed turn takes them (ADR 0031 point 3), and is held to the
// rollout's last sandbox: each access the call can ask, over a rollout whose last turn ran each sandbox.
test("every resume passes -s and -C before resume and checks the rollout's last sandbox", TABLE, async (t) => {
  const rows = [
    ['resume-config-after', 'read-only'],
    ['resume-config-after', 'workspace-write'],
    ['resume-flags-before', 'read-only'],
    ['resume-flags-before', 'workspace-write'],
  ] as const;
  const ended: Record<string, unknown> = {};
  for (const [scenario, access] of rows) {
    const fake = fakeCli(t, { scenario });
    const { result } = await fake.harness.run(codexCall(fake, resumed(access)), hooksOf());
    const before = ['exec', '-s', access, '-C', fake.cwd, 'resume', START_THREAD];
    ended[`${scenario} ${access}`] = {
      status: result.status,
      flagsBeforeResume: fake.received().argv.slice(0, before.length).join(' ') === before.join(' '),
    };
  }
  assert.deepEqual(ended, {
    'resume-config-after read-only': { status: 'completed', flagsBeforeResume: true },
    'resume-config-after workspace-write': { status: 'failed', flagsBeforeResume: true },
    'resume-flags-before read-only': { status: 'failed', flagsBeforeResume: true },
    'resume-flags-before workspace-write': { status: 'completed', flagsBeforeResume: true },
  });
});

// #481 D12 A, ADR 0031 point 4: no fallback to unelevated, which isolates nothing usable, so an MXC error ends the
// call as a typed failure and Codex is launched once.
test('an mxc error ends the call as a typed failure with no second launch', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start', stream: mxcFailure });
  const { result, failure } = await fake.harness.run(codexCall(fake), hooksOf());
  assert.deepEqual(
    {
      status: result.status,
      failure,
      launches: fake.launches.filter(({ args }) => args[0] === 'exec').length,
    },
    { status: 'failed', failure: { failureClass: 'unknown', retryAfterMs: null, message: MXC_ERROR }, launches: 1 },
  );
});

// Q3 A: Codex 0.171 keeps no call log under $CODEX_HOME/logs, so a failed call carries the stream's error and stderr.
test("a nonzero exit carries the stream's error and stderr", CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'usage-limit', stderr: 'the CLI wrote this to stderr' });
  const { result, failure } = await fake.harness.run(codexCall(fake), hooksOf());
  assert.deepEqual(
    { exitCode: result.exitCode, message: failure?.message },
    { exitCode: 1, message: `${USAGE_LIMIT}\nstderr: the CLI wrote this to stderr` },
  );
});

// Decision 4: the outcome comes from the final event, never the exit code. Each recorded stream whose exit was not 0,
// found from the recordings, by the status its final event gives: unelevated-workspace-write completed its turn and
// still exited 1.
test('every recorded nonzero exit takes its outcome from the final event, never the exit code', TABLE, async (t) => {
  const fixtures = new URL('../../fixtures/codex/', import.meta.url);
  const nonzero = readdirSync(fixtures)
    .filter((file) => file.endsWith('.jsonl') && !file.endsWith('.rollout.jsonl'))
    .map((file) => file.slice(0, -'.jsonl'.length))
    .filter((scenario) => {
      const recorded = JSON.parse(readFileSync(new URL(`${scenario}.json`, fixtures), 'utf8')) as { exitCode: number };
      return recorded.exitCode !== 0;
    });
  const ended: Record<string, string> = {};
  for (const scenario of nonzero) {
    const fake = fakeCli(t, { scenario });
    ended[scenario] = (await fake.harness.run(codexCall(fake), hooksOf())).result.status;
  }
  assert.deepEqual(ended, {
    'auth-invalid': 'failed',
    'auth-missing': 'failed',
    'resume-outside-git': 'failed',
    'tree-kill': 'failed',
    'unelevated-workspace-write': 'completed',
    'usage-limit': 'failed',
  });
});

// An Agent that lists a plugin Codex has not installed: its launch fails before any spawn.
const MISSING_PLUGIN = { harness: 'codex', persona: 'implementer.md', model: null, effort: null, plugins: ['gg-none'] };

// Every way a call can fail resolves a typed result: a Harness never throws or rejects for an expected failure
// (request section 4). Each row is the fake, the call's changes, whether its signal aborts, and whether its stream ends
// with turn.completed.
const FAILURE_PATHS: [string, codexOverFakeCli.FakeCodex, Record<string, unknown>, boolean, boolean][] = [
  ['a usage limit', { scenario: 'usage-limit' }, {}, false, false],
  ['an invalid API key', { scenario: 'auth-invalid' }, {}, false, false],
  ['no login', { scenario: 'auth-missing' }, {}, false, false],
  ['a stream with no turn.completed', { scenario: 'start', mode: 'no-result' }, {}, false, false],
  ['a call killed mid-turn', { scenario: 'tree-kill' }, {}, false, false],
  ['a line that is not JSON', { scenario: 'start', mode: 'garbage' }, {}, false, true],
  ['an executable that cannot start', { scenario: 'start', command: 'gg-no-such-codex' }, {}, false, false],
  ['a listing that prints none', { scenario: 'start', listings: false }, {}, false, false],
  [
    'a plugin Codex lacks',
    { scenario: 'start' },
    { agent: MISSING_PLUGIN, tools: codex.resolveTools(MISSING_PLUGIN) },
    false,
    false,
  ],
  [
    'a resume whose rollout is missing',
    { scenario: 'resume-flags-before', rollout: false },
    resumed('workspace-write'),
    false,
    true,
  ],
  ['a resume under another sandbox', { scenario: 'resume-flags-before' }, resumed('read-only'), false, true],
  ['an mxc error', { scenario: 'start', stream: mxcFailure }, {}, false, false],
  ['a stall', { scenario: 'start', mode: 'hang' }, { timeouts: { stallMs: 500 } }, false, false],
  ['the wall clock', { scenario: 'start', mode: 'hang' }, { timeouts: { wallMs: 500 } }, false, false],
  ['a cancel', { scenario: 'start', mode: 'hang' }, {}, true, false],
];

test('every failure path resolves a typed result, never a rejection', TABLE, async (t) => {
  const ended: Record<string, unknown> = {};
  for (const [name, cli, changes, cancels] of FAILURE_PATHS) {
    const fake = fakeCli(t, cli);
    const controller = new AbortController();
    const hooks = hooksOf({ started: () => cancels && controller.abort(), signal: controller.signal });
    try {
      const { result, failure } = await fake.harness.run(codexCall(fake, changes), hooks);
      ended[name] = { status: result.status, failureClass: failure?.failureClass ?? null };
    } catch (err) {
      ended[name] = `rejected: ${(err as Error).message}`;
    }
  }
  assert.deepEqual(ended, {
    'a usage limit': { status: 'failed', failureClass: 'quota' },
    'an invalid API key': { status: 'failed', failureClass: 'auth' },
    'no login': { status: 'failed', failureClass: 'auth' },
    'a stream with no turn.completed': { status: 'failed', failureClass: 'unknown' },
    'a call killed mid-turn': { status: 'failed', failureClass: 'unknown' },
    'a line that is not JSON': { status: 'completed', failureClass: null },
    'an executable that cannot start': { status: 'failed', failureClass: 'unknown' },
    'a listing that prints none': { status: 'failed', failureClass: 'unknown' },
    'a plugin Codex lacks': { status: 'failed', failureClass: 'unknown' },
    'a resume whose rollout is missing': { status: 'failed', failureClass: 'unknown' },
    'a resume under another sandbox': { status: 'failed', failureClass: 'unknown' },
    'an mxc error': { status: 'failed', failureClass: 'unknown' },
    'a stall': { status: 'timed-out', failureClass: null },
    'the wall clock': { status: 'timed-out', failureClass: null },
    'a cancel': { status: 'killed', failureClass: null },
  });
});

// The counts Codex gives only in turn.completed: the thread's token totals.
const TURN_COUNTS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const;

// Every failure path: a stream with no turn.completed reports null for each token count in both halves, never 0 or the
// earlier total; one with it reports each as a number.
test(
  'every failure path with no turn.completed reports null tokens, and one with it reports them',
  TABLE,
  async (t) => {
    const broken: string[] = [];
    for (const [name, cli, changes, cancels, turnCompleted] of FAILURE_PATHS) {
      const fake = fakeCli(t, cli);
      const controller = new AbortController();
      const hooks = hooksOf({ started: () => cancels && controller.abort(), signal: controller.signal });
      const { result } = await fake.harness.run(codexCall(fake, changes), hooks);
      for (const half of ['cumulative', 'delta'] as const)
        for (const field of TURN_COUNTS) {
          const value = result.usage[half][field];
          if (turnCompleted ? typeof value !== 'number' : value !== null)
            broken.push(`${name}: ${half}.${field} is ${value}`);
        }
    }
    assert.deepEqual(broken, []);
  },
);

// The reporting Capability each Usage field turns on (docs/interfaces/harness.md, Usage); the others always count but
// compactions, which Codex's stream never reports (docs/research/codex-cli.md question 6).
const USAGE_CAPABILITY: Record<string, string> = {
  reasoningTokens: 'reasoningTokenReporting',
  costUsd: 'costReporting',
  peakContextTokens: 'peakContextReporting',
  turns: 'turnCountReporting',
  toolCalls: 'toolCallReporting',
};

// Every Usage field, in both halves: null where Codex reports none and a number otherwise, with no cost basis, and
// every reported field's delta is its cumulative less the earlier total.
test(
  'every Usage count Codex does not report is null, and a reported one is its cumulative less the earlier total',
  CASE,
  async (t) => {
    const fake = fakeCli(t, { scenario: 'resume-flags-before' });
    const { result } = await fake.harness.run(codexCall(fake, resumed('workspace-write')), hooksOf());
    const capabilities = fake.harness.capabilities as Record<string, unknown>;
    const broken: string[] = [];
    for (const field of contract.USAGE_FIELDS as contract.CountField[]) {
      const capability = USAGE_CAPABILITY[field];
      const reported = field !== 'compactions' && (!capability || capabilities[capability] === true);
      for (const half of ['cumulative', 'delta'] as const) {
        const value = result.usage[half][field];
        if (reported ? typeof value !== 'number' : value !== null) broken.push(`${half}.${field} is ${value}`);
      }
      const [cumulative, delta, earlier] = [
        result.usage.cumulative[field],
        result.usage.delta[field],
        AFTER_START[field],
      ];
      if (reported && delta !== (cumulative ?? 0) - (earlier ?? 0))
        broken.push(`delta.${field} ${delta} is not ${cumulative} less ${earlier}`);
    }
    for (const half of ['cumulative', 'delta'] as const)
      if (result.usage[half].costBasis !== null) broken.push(`${half}.costBasis is ${result.usage[half].costBasis}`);
    assert.deepEqual(broken, []);
  },
);

test('interactiveArgs and metrics throw not implemented until their slices', (t) => {
  const { harness } = fakeCli(t, { scenario: 'start' });
  assert.throws(() => harness.interactiveArgs({}, 'opening'), { message: 'not implemented' });
  assert.throws(() => harness.metrics(START_THREAD), { message: 'not implemented' });
});

// --- The hand-off hook (#485)

// A budget below the 13,227 tokens hooks-on's latest request sent (Clarify probe P1), so its hook asks.
const SMALL_BUDGET = 1000;

// A call of an Agent with a contextBudget over the fake replaying hooks-on, the recorded call whose hooks fired under
// exec: what it reported, and the PostToolUse hooks its launch installs.
async function budgetedCall(t: TestContext) {
  const fake = fakeCli(t, { scenario: 'hooks-on' });
  const sent = codexCall(fake);
  const agent = { ...(sent.agent as Record<string, unknown>), contextBudget: SMALL_BUDGET };
  const { result } = await fake.harness.run(
    codexCall(fake, { agent, tools: fake.harness.resolveTools(agent) }),
    hooksOf(),
  );
  const [launched] = fake.calls();
  const postToolUse = codexHookHandlers
    .hookHandlers(launched?.argv ?? [])
    .filter(({ event }) => event === 'PostToolUse');
  return { fake, result, argv: launched?.argv ?? [], postToolUse };
}

// The hook input a PostToolUse sends, with the keys hooks-on's hook log shows, for the thread and rollout the call
// reported.
const postToolUseInput = (result: { sessionId: unknown; transcriptPath: unknown }, cwd: string) =>
  JSON.stringify({
    session_id: result.sessionId,
    turn_id: 'turn-1',
    transcript_path: result.transcriptPath,
    cwd,
    hook_event_name: 'PostToolUse',
    model: 'gpt-6-luna',
    permission_mode: 'bypassPermissions',
    tool_name: 'shell',
    tool_input: { command: 'node --version' },
    tool_response: 'v26.13.0',
    tool_use_id: 'call-1',
  });

// A hook's command run as Codex starts one, through a shell, since the command is a shell command line: sh -c on POSIX,
// and on win32 ComSpec's /c, the shell Codex's binary names. unverified: which shell Codex 0.171 starts commandWindows
// in on win32; the owner's gg doctor --probe run before merge checks the hook under the real CLI (Q2 A).
function runHook(command: string, input: string, cwd: string) {
  const win32 = process.platform === 'win32';
  return spawnSync(
    win32 ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    win32 ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
    { cwd, input, encoding: 'utf8', timeout: 30_000, windowsVerbatimArguments: win32 },
  );
}

// What the hook printed for Codex to add to the agent's context.
function addedContext(ran: ReturnType<typeof spawnSync>) {
  assert.equal(ran.status, 0, `the hook exits 0: ${String(ran.stderr)}`);
  const said = JSON.parse(String(ran.stdout)) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(said.hookSpecificOutput?.hookEventName, 'PostToolUse', String(ran.stdout));
  return said.hookSpecificOutput.additionalContext ?? '';
}

// Past the budget the hook the launch installs, run on this platform's command over the rollout the call wrote, asks
// the agent to end handed off with its note (#485 DoD 2; Q2 A: the hook's firing is recorded, its answer constructed).
test("past its context budget a Codex Agent's hook asks for a hand-off", CASE, async (t) => {
  const { fake, result, argv, postToolUse } = await budgetedCall(t);
  assert.ok(codexHookHandlers.overrides(argv).includes('features.hooks=true'), JSON.stringify(argv));
  assert.ok(argv.includes('--dangerously-bypass-hook-trust'), JSON.stringify(argv));
  assert.equal(postToolUse.length, 1, JSON.stringify(argv));
  const command = postToolUse[0]!.keys[process.platform === 'win32' ? 'commandWindows' : 'command'] ?? '';
  const text = addedContext(runHook(command, postToolUseInput(result, fake.cwd), fake.cwd));
  assert.ok(text.includes('"handed-off"'), `it names the Claim token: ${text}`);
  assert.ok(text.includes(`"${briefs.HANDOFF_NOTE}"`), `it names the note field: ${text}`);
  assert.ok(text.includes('13k'), `it gives the latest request's context: ${text}`);
});

// Request 3.2: commandWindows is required for any hook on win32, and it runs there from a worktree whose path holds a
// space, as every path the fake gives does.
test("the hook's win32 command runs", { ...CASE, skip: process.platform !== 'win32' && 'win32 only' }, async (t) => {
  const { fake, result, postToolUse } = await budgetedCall(t);
  const commandWindows = postToolUse[0]?.keys.commandWindows;
  assert.ok(commandWindows, `the hook has a commandWindows: ${JSON.stringify(postToolUse)}`);
  assert.ok(fake.cwd.includes(' '));
  const text = addedContext(runHook(commandWindows, postToolUseInput(result, fake.cwd), fake.cwd));
  assert.ok(text.includes('"handed-off"'), text);
});
