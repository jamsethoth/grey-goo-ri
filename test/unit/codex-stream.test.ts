// What a Codex call's --json events and rollout say (#482): the thread, the failure and its Failure Class, the token
// totals and tool calls from the stream, and the last turn's facts from the rollout, found in the sessions tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codexStream from '../../lib/harnesses/codex-stream.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const FIXTURES = new URL('../fixtures/codex/', import.meta.url);
const recordedLines = (name: string) =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .filter(Boolean);
const line = (value: object) => JSON.stringify(value);

// A turn that ends in `message`, as Codex 0.171 sends a failed turn: an error event, then turn.failed.
const failedTurn = (message: string) => [
  line({ type: 'thread.started', thread_id: 'thread-1' }),
  line({ type: 'turn.started' }),
  line({ type: 'error', message }),
  line({ type: 'turn.failed', error: { message } }),
];

test('the thread id comes from thread.started', () => {
  assert.equal(codexStream.read(recordedLines('start')).threadId, '01a2044a-1251-7180-8d49-dc1220e52393');
});

test('a stream with no thread.started has no thread id', () => {
  const lines = recordedLines('start').filter((recorded) => !recorded.includes('"thread.started"'));
  assert.equal(codexStream.read(lines).threadId, null);
});

// Ported, feature-flow 89e1d67 test/core.test.mjs: the last turn.completed is the thread's total. Its counts follow
// gg's token rules (request 3.7): Codex's input_tokens holds the cached and cache-write tokens, so inputTokens is the
// rest,
// and output_tokens holds the reasoning tokens, which are reported beside it and never added again.
test('codexUsage takes the last cumulative turn.completed and does not double-count reasoning', () => {
  const lines = [
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5,' +
      '"reasoning_output_tokens":3}}',
    '{"type":"turn.completed","usage":{"input_tokens":150,"cached_input_tokens":60,"cache_write_input_tokens":10,' +
      '"output_tokens":9,"reasoning_output_tokens":4}}',
  ];
  assert.deepEqual(codexStream.read(lines).totals, {
    inputTokens: 80,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 9,
    reasoningTokens: 4,
  });
});

// Decision 3: a count the stream never reported is null, never zero; inputTokens is the rest of input_tokens, so it is
// null when input_tokens, cached_input_tokens or cache_write_input_tokens is missing.
test('a turn.completed that leaves a count out reports it null', () => {
  const usage = {
    input_tokens: 150,
    cached_input_tokens: 60,
    cache_write_input_tokens: 10,
    output_tokens: 9,
    reasoning_output_tokens: 4,
  };
  const totalsWithout = (key: string | null) => {
    const left = Object.fromEntries(Object.entries(usage).filter(([name]) => name !== key));
    return codexStream.read([line(key === null ? { type: 'turn.completed' } : { type: 'turn.completed', usage: left })])
      .totals;
  };
  const full = { inputTokens: 80, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 9, reasoningTokens: 4 };
  assert.deepEqual(
    Object.keys(usage).map((key) => totalsWithout(key)),
    [
      { ...full, inputTokens: null },
      { ...full, inputTokens: null, cacheReadTokens: null },
      { ...full, inputTokens: null, cacheWriteTokens: null },
      { ...full, outputTokens: null },
      { ...full, reasoningTokens: null },
    ],
  );
  assert.deepEqual(totalsWithout(null), {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  });
});

test('a stream with no turn.completed reports no totals', () => {
  assert.equal(codexStream.read(recordedLines('usage-limit')).totals, null);
});

// A tool call is a completed command, MCP tool call, file change or web search; a message, reasoning or an error item
// is none.
test("the tool calls are the stream's completed command, MCP, file-change and web-search items", () => {
  const item = (type: string) => line({ type: 'item.completed', item: { id: type, type } });
  const lines = [
    line({ type: 'item.started', item: { id: 'command', type: 'command_execution' } }),
    item('command_execution'),
    item('mcp_tool_call'),
    item('file_change'),
    item('web_search'),
    item('agent_message'),
    item('reasoning'),
    item('error'),
    line({ type: 'turn.completed', usage: {} }),
  ];
  assert.equal(codexStream.read(lines).toolCalls, 4);
});

// Codex retries a dropped request itself and says so in error events; a turn that then completes has no failure.
test('an error event the turn recovers from is no failure', () => {
  const recorded = recordedLines('start');
  const reconnecting = line({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  const lines = [...recorded.slice(0, 2), reconnecting, ...recorded.slice(2)];
  assert.equal(codexStream.read(lines).failure, null);
});

// tree-kill: the call's job was ended mid-turn, so its stream stops after turn.started.
test('a stream that ends with neither turn.completed nor turn.failed is an unknown failure', () => {
  assert.equal(codexStream.read(recordedLines('tree-kill')).failure?.failureClass, 'unknown');
});

// Q2 A: each failure text Codex 0.171 can end a turn with, by the class its source gives it
// (codex-rs/codex-api/src/api_bridge.rs and codex-rs/protocol/src/error.rs at rust-v0.171.0), first match wins: the
// recorded texts are marked, the others written from the source formats. Codex reports no spend limit of its own
// (budget), and no text gives a wait gg could honour, so retryAfterMs is null.
const SOURCE_TEXTS: [string, string][] = [
  ['unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: x', 'auth'],
  ['exceeded retry limit, last status: 401 Unauthorized, request id: req_1', 'auth'],
  ['You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.', 'quota'],
  ['Your workspace is out of credits. Add credits to keep using Codex.', 'quota'],
  ['You hit your spend cap set by the owner of your workspace. Ask the owner to raise it.', 'quota'],
  ['Quota exceeded. Check your plan and billing details.', 'quota'],
  ['To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.', 'quota'],
  ['exceeded retry limit, last status: 429 Too Many Requests, request id: req_2', 'rate-limited'],
  ['rate limit exceeded: Rate limit reached for requests', 'rate-limited'],
  ['Selected model is at capacity. Please try a different model.', 'transient'],
  ['We’re currently experiencing high demand, which may cause temporary errors.', 'transient'],
  ['stream disconnected before completion: error sending request for url', 'transient'],
  ['Connection failed: error sending request for url (https://api.openai.com/v1/responses)', 'transient'],
  ['exceeded retry limit, last status: 500 Internal Server Error, request id: req_3', 'transient'],
  ['exceeded retry limit, last status: 503 Service Unavailable', 'transient'],
  ['unexpected status 403 Forbidden: the request is not allowed', 'unknown'],
  [
    'Codex ran out of room in the model’s context window. Start a new thread or clear earlier history before retrying.',
    'unknown',
  ],
  ['windows sandbox: mxc setup failed', 'unknown'],
];

// The Failure Class of each recorded failed turn (#479), every recording whose stream has a turn.failed.
const RECORDED_CLASSES: Record<string, string> = {
  'auth-invalid': 'auth',
  'auth-missing': 'auth',
  'usage-limit': 'quota',
};

// Each HTTP status Codex 0.171 classes, in both texts its source writes a status in (api_bridge.rs's UnexpectedStatus
// and RetryLimit), each ending a turn through turn.failed and through a last error event.
const STATUS_CLASSES: [string, string][] = [
  ['401 Unauthorized', 'auth'],
  ['429 Too Many Requests', 'rate-limited'],
  ['500 Internal Server Error', 'transient'],
  ['502 Bad Gateway', 'transient'],
  ['503 Service Unavailable', 'transient'],
  ['504 Gateway Timeout', 'transient'],
];
const statusTexts = (status: string) => [
  `unexpected status ${status}: upstream body, url: x`,
  `exceeded retry limit, last status: ${status}, request id: req_4`,
];
const endedBy = (message: string) => ({
  'turn.failed': [line({ type: 'turn.started' }), line({ type: 'turn.failed', error: { message } })],
  error: [line({ type: 'turn.started' }), line({ type: 'error', message })],
});

// Each status text, through each event, whose Failure Class or retry delay is not its source's.
function misclassedStatuses() {
  const broken: string[] = [];
  for (const [status, failureClass] of STATUS_CLASSES)
    for (const message of statusTexts(status))
      for (const [event, lines] of Object.entries(endedBy(message))) {
        const failure = codexStream.read(lines).failure;
        if (failure?.failureClass !== failureClass || failure.retryAfterMs !== null)
          broken.push(`${event} ${message}: ${JSON.stringify(failure)}, not ${failureClass}`);
      }
  return broken;
}

test('every failure text of Codex 0.171 is classed as its source says, with no retry delay', () => {
  const recorded = readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.jsonl') && !file.endsWith('.rollout.jsonl'))
    .map((file) => file.slice(0, -'.jsonl'.length))
    .filter((name) => recordedLines(name).some((recordedLine) => recordedLine.includes('"turn.failed"')));
  assert.deepEqual(recorded.sort(), Object.keys(RECORDED_CLASSES).sort(), 'every recorded failed turn is classed');
  const broken: string[] = [];
  for (const [message, failureClass] of SOURCE_TEXTS) {
    const failure = codexStream.read(failedTurn(message)).failure;
    if (failure?.failureClass !== failureClass || failure.retryAfterMs !== null || failure.message !== message)
      broken.push(`${message}: ${JSON.stringify(failure)}, not ${failureClass}`);
  }
  broken.push(...misclassedStatuses());
  for (const [name, failureClass] of Object.entries(RECORDED_CLASSES)) {
    const failure = codexStream.read(recordedLines(name)).failure;
    if (failure?.failureClass !== failureClass) broken.push(`${name}: ${failure?.failureClass}, not ${failureClass}`);
  }
  assert.deepEqual(broken, []);
});

// Ported, feature-flow 89e1d67 test/core.test.mjs: the sandbox of a thread's latest turn, from its rollout.
test('recordedSandbox reads the latest turn sandbox from a dated rollout file', (t) => {
  const home = tempDirectory.tempDirectory(t, 'gg-codexhome-');
  const directory = join(home, 'sessions', '2026', '11', '26');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'rollout-2026-x-abc123.jsonl'),
    '{"type":"turn_context","payload":{"sandbox_policy":{"type":"read-only"}}}\n' +
      '{"type":"turn_context","payload":{"sandbox_policy":{"type":"workspace-write","x":1}}}\n',
  );
  assert.equal(codexStream.rollout(home, 'abc123')?.sandbox, 'workspace-write');
  assert.equal(codexStream.rollout(home, 'missing'), null);
});

// DVC row L1: feature-flow looked in today's and yesterday's folders only, so a thread resumed days later lost its
// rollout; the lookup is by thread id across the whole sessions tree.
test('a rollout is found by its thread id anywhere in the sessions tree', (t) => {
  const home = tempDirectory.tempDirectory(t, 'gg-codexhome-');
  const directory = join(home, 'sessions', '2020', '01', '02');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'rollout-2020-01-02T03-04-05-old-thread.jsonl');
  writeFileSync(path, '{"type":"turn_context","payload":{"sandbox_policy":{"type":"read-only"}}}\n');
  assert.equal(codexStream.rollout(home, 'old-thread')?.path, path);
});

test("the rollout gives the CLI version, and the last turn's model, effort and sandbox", (t) => {
  const home = tempDirectory.tempDirectory(t, 'gg-codexhome-');
  const directory = join(home, 'sessions', '2026', '11', '22');
  mkdirSync(directory, { recursive: true });
  const thread = '01a2044a-1251-7180-8d49-dc1220e52393';
  const path = join(directory, `rollout-2026-11-22T12-24-53-${thread}.jsonl`);
  copyFileSync(new URL('resume-flags-before.rollout.jsonl', FIXTURES), path);
  assert.deepEqual(codexStream.rollout(home, thread), {
    path,
    cliVersion: '0.171.0',
    model: 'gpt-6-luna',
    effort: 'low',
    sandbox: 'workspace-write',
  });
});
