// The Claude stream reader over the lines recorded from Claude Code 2.1.328 (test/fixtures/claude/, #425): what each
// line kind gives, the failure each error source gives, and the streams that end without a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as claudeStream from '../../lib/harnesses/claude-stream.ts';
import * as claudeRecordings from '../support/claude-recordings.ts';

const { lines, only, without, withField } = claudeRecordings;

const SUCCESS = lines('success');
const SUCCESS_INIT = JSON.parse(only(SUCCESS, 'system/init')[0] ?? '{}') as Record<string, unknown>;

// The success recording, read: what each case that adds a line kind the reader skips expects back unchanged.
const SUCCESS_READ: claudeStream.ClaudeStream = {
  sessionId: '56850773-3aa4-4cf7-ad6f-7a881aab76db',
  cliVersion: '2.1.328',
  model: 'claude-haiku-5-5',
  sessionInit: {
    plugins: SUCCESS_INIT.plugins as claudeStream.SessionInit['plugins'],
    pluginErrors: [],
    mcpServers: [],
    mcpServerErrors: [],
    capabilities: SUCCESS_INIT.capabilities as claudeStream.SessionInit['capabilities'],
  },
  failure: null,
  finalEventSubtype: 'success',
  response: { answer: 'heliotrope — slow.js printed: "slow done"' },
  permissionDenials: [],
  commandsRun: 1,
  toolCalls: 2,
  turns: 4,
  compactions: 0,
  peakContextTokens: 10035,
  startContextTokens: 9755,
  totals: {
    inputTokens: 4,
    cacheReadTokens: 9753,
    cacheWriteTokens: 10033,
    outputTokens: 241,
    costUsd: 0.0022250300000000002,
  },
};

// A stream's failure, by the fields every case reads: its class and its wait.
const failureOf = (stream: claudeStream.ClaudeStream) =>
  stream.failure && { failureClass: stream.failure.failureClass, retryAfterMs: stream.failure.retryAfterMs ?? null };

// `recorded` with `added` after its init line.
const afterInit = (recorded: string[], added: string[]) => [recorded[0] ?? '', ...added, ...recorded.slice(1)];

const lineOf = (recorded: string[], kind: string) => only(recorded, kind)[0] ?? '';

test('the init line gives the session id, the CLI version, the model and what loaded', () => {
  const read = claudeStream.read(SUCCESS);
  assert.deepEqual(
    {
      sessionId: read.sessionId,
      cliVersion: read.cliVersion,
      model: read.model,
      sessionInit: read.sessionInit,
    },
    {
      sessionId: SUCCESS_READ.sessionId,
      cliVersion: SUCCESS_READ.cliVersion,
      model: SUCCESS_READ.model,
      sessionInit: SUCCESS_READ.sessionInit,
    },
  );
});

// Claude carries on past them and completes: gg fails the call from the init line (decided from the recordings).
test("the init line's plugin errors and failed MCP servers fail the stream as unknown", () => {
  const recorded = lines('init-error');
  const read = claudeStream.read(recorded);
  const init = JSON.parse(lineOf(recorded, 'system/init')) as { plugin_errors: unknown };
  assert.deepEqual(
    {
      failure: failureOf(read),
      pluginErrors: read.sessionInit?.pluginErrors,
      mcpServerErrors: read.sessionInit?.mcpServerErrors,
    },
    {
      failure: { failureClass: 'unknown', retryAfterMs: null },
      pluginErrors: init.plugin_errors,
      mcpServerErrors: [{ name: 'broken', status: 'failed', source: 'dynamic' }],
    },
  );
});

// Request 3.2 names the init line's own array; Claude Code 2.1.328 never sends it, so no recording carries it.
test("the init line's MCP server errors fail the stream as unknown and are reported", () => {
  const entry = { server: 'x', message: 'boom' };
  const init = withField(lineOf(SUCCESS, 'system/init'), 'mcp_server_errors', [entry]);
  const read = claudeStream.read([init, ...SUCCESS.slice(1)]);
  assert.deepEqual(
    { failure: failureOf(read), mcpServerErrors: read.sessionInit?.mcpServerErrors },
    { failure: { failureClass: 'unknown', retryAfterMs: null }, mcpServerErrors: [entry] },
  );
});

test("the init line's plugin errors alone fail the stream as unknown", () => {
  const entry = { plugin: 'x', message: 'boom' };
  const init = withField(lineOf(SUCCESS, 'system/init'), 'plugin_errors', [entry]);
  const read = claudeStream.read([init, ...SUCCESS.slice(1)]);
  assert.deepEqual(
    { failure: failureOf(read), pluginErrors: read.sessionInit?.pluginErrors },
    { failure: { failureClass: 'unknown', retryAfterMs: null }, pluginErrors: [entry] },
  );
});

// The api-retry recording with its three retry lines' errors and delays replaced, its synthetic rate_limit line kept.
const withRetries = (retries: [string, number][]) => {
  const recorded = lines('api-retry');
  const retryLines = only(recorded, 'system/api_retry');
  return recorded.map((line) => {
    const index = retryLines.indexOf(line);
    const [error, delay] = retries[index] ?? [];
    return index < 0 ? line : withField(withField(line, 'error', error), 'retry_delay_ms', delay);
  });
};

test("the synthetic assistant line's error classifies the failure over the last api_retry line's", () => {
  const read = claudeStream.read(
    withRetries([
      ['rate_limit', 1096],
      ['rate_limit', 1248],
      ['overloaded', 42],
    ]),
  );
  assert.equal(read.failure?.failureClass, 'rate-limited');
});

// Issue decision 4: a rate-limited failure waits the rate_limit retry's delay; a retry for another error sent none.
test('a rate-limited failure waits the last rate_limit retry delay, or none when no rate_limit retry was sent', () => {
  const orders: [string, [string, number][]][] = [
    [
      'rate_limit then overloaded',
      [
        ['overloaded', 1096],
        ['rate_limit', 2014],
        ['overloaded', 42],
      ],
    ],
    [
      'overloaded only',
      [
        ['overloaded', 1096],
        ['overloaded', 1248],
        ['overloaded', 42],
      ],
    ],
    [
      'rate_limit last',
      [
        ['overloaded', 1096],
        ['rate_limit', 1248],
        ['rate_limit', 2014],
      ],
    ],
  ];
  const waits = Object.fromEntries(
    orders.map(([name, retries]) => [name, failureOf(claudeStream.read(withRetries(retries)))?.retryAfterMs]),
  );
  assert.deepEqual(waits, { 'rate_limit then overloaded': 2014, 'overloaded only': null, 'rate_limit last': 2014 });
});

test('the last api_retry line before a failing result gives its class and delay', () => {
  const read = claudeStream.read(without(lines('api-retry'), 'assistant'));
  assert.deepEqual(failureOf(read), { failureClass: 'rate-limited', retryAfterMs: 2014 });
});

test('an earlier api_retry error is not the one that classifies the failure', () => {
  const recorded = without(lines('api-retry'), 'assistant');
  const retries = only(recorded, 'system/api_retry');
  const last = retries.at(-1) ?? '';
  const read = claudeStream.read(
    recorded.map((line) => (line === last ? withField(line, 'error', 'overloaded') : line)),
  );
  assert.equal(read.failure?.failureClass, 'transient');
});

test('the synthetic assistant line of a failed call gives its class', () => {
  const read = claudeStream.read(lines('auth-failure'));
  assert.deepEqual(failureOf(read), { failureClass: 'auth', retryAfterMs: null });
});

test('assistant lines give the tool calls, the commands run and the peak context, each message once', () => {
  const read = claudeStream.read(lines('read-only-powershell'));
  assert.deepEqual(
    { toolCalls: read.toolCalls, commandsRun: read.commandsRun, peakContextTokens: read.peakContextTokens },
    { toolCalls: 7, commandsRun: 6, peakContextTokens: 10888 },
  );
});

test("an assistant line repeated for each of a message's content blocks counts its message once", () => {
  const assistant = only(SUCCESS, 'assistant');
  const read = claudeStream.read([...SUCCESS.slice(0, -1), ...assistant.slice(0, 1), ...SUCCESS.slice(-1)]);
  assert.deepEqual(
    { toolCalls: read.toolCalls, peakContextTokens: read.peakContextTokens },
    { toolCalls: 2, peakContextTokens: 10035 },
  );
});

test('a compact_boundary line is one compaction', () => {
  const read = claudeStream.read(lines('compaction'));
  assert.deepEqual(
    { compactions: read.compactions, peakContextTokens: read.peakContextTokens },
    { compactions: 1, peakContextTokens: 141288 },
  );
});

// The recording's status lines report compacting, a failed try and a success: only the boundary counts.
test('status lines are not compactions', () => {
  const read = claudeStream.read(without(lines('compaction'), 'system/compact_boundary'));
  assert.equal(read.compactions, 0);
});

test('the result line gives the response, the subtype, the turns, the denials and the totals', () => {
  assert.deepEqual(claudeStream.read(SUCCESS), SUCCESS_READ);
});

test("the result line's permission denials are reported as sent", () => {
  const recorded = lines('denial-powershell');
  const result = JSON.parse(lineOf(recorded, 'result/success')) as { permission_denials: unknown[] };
  const read = claudeStream.read(recorded);
  assert.deepEqual(
    { permissionDenials: read.permissionDenials, commandsRun: read.commandsRun },
    { permissionDenials: result.permission_denials, commandsRun: 0 },
  );
  assert.equal(result.permission_denials.length, 7);
});

test('a result without structured_output gives a null response', () => {
  const read = claudeStream.read(lines('no-schema'));
  assert.deepEqual({ response: read.response, failure: read.failure }, { response: null, failure: null });
});

// The result's modelUsage is the Session's running total (decided from the recordings), summed over its models.
test("the result's modelUsage gives the Session's totals, summed over its models", () => {
  const recorded = lines('resume');
  const result = lineOf(recorded, 'result/success');
  const { modelUsage } = JSON.parse(result) as { modelUsage: Record<string, Record<string, unknown>> };
  const [usage] = Object.values(modelUsage);
  const twoModels = withField(result, 'modelUsage', { ...modelUsage, 'claude-other': usage });
  assert.deepEqual(claudeStream.read([...recorded.slice(0, -1), twoModels]).totals, {
    inputTokens: 20,
    cacheReadTokens: 59874,
    cacheWriteTokens: 20494,
    outputTokens: 724,
    costUsd: 0.005061540000000001,
  });
});

test('an empty modelUsage gives null totals', () => {
  const read = claudeStream.read(lines('auth-failure'));
  assert.deepEqual({ totals: read.totals, turns: read.turns }, { totals: null, turns: 1 });
});

// The status comes from is_error, never the subtype, which says success on an API failure.
test('a result that is an error with no error line before it is unknown', () => {
  const result = withField(lineOf(SUCCESS, 'result/success'), 'is_error', true);
  const read = claudeStream.read([...SUCCESS.slice(0, -1), result]);
  assert.deepEqual(
    { failure: failureOf(read), finalEventSubtype: read.finalEventSubtype },
    { failure: { failureClass: 'unknown', retryAfterMs: null }, finalEventSubtype: 'success' },
  );
});

test('the max budget subtype is a budget failure', () => {
  const result = withField(
    withField(lineOf(SUCCESS, 'result/success'), 'is_error', true),
    'subtype',
    'error_max_budget_usd',
  );
  const read = claudeStream.read([...SUCCESS.slice(0, -1), result]);
  assert.deepEqual(
    { failure: failureOf(read), finalEventSubtype: read.finalEventSubtype },
    { failure: { failureClass: 'budget', retryAfterMs: null }, finalEventSubtype: 'error_max_budget_usd' },
  );
});

test('a stream with no result line is an unknown failure with no subtype and no totals', () => {
  const read = claudeStream.read(without(SUCCESS, 'result/success'));
  assert.deepEqual(
    { failure: failureOf(read), finalEventSubtype: read.finalEventSubtype, totals: read.totals },
    { failure: { failureClass: 'unknown', retryAfterMs: null }, finalEventSubtype: null, totals: null },
  );
});

test('a line that is not JSON is skipped', () => {
  assert.deepEqual(claudeStream.read(afterInit(SUCCESS, ['not a JSON line'])), SUCCESS_READ);
});

// The line kinds that say nothing the reader reports: each added to the success recording reads as it does.
const SKIPPED_KINDS: [string, string[]][] = [
  ['user', only(SUCCESS, 'user')],
  ['rate_limit_event', only(SUCCESS, 'rate_limit_event')],
  ['system/thinking_tokens', only(lines('resume'), 'system/thinking_tokens')],
  ['system/permission_denied', only(lines('denial-powershell'), 'system/permission_denied')],
  ['system/status', only(lines('compaction'), 'system/status')],
  ['stream_event', only(lines('partial-messages'), 'stream_event')],
];

test('each line kind the reader skips changes nothing it reports', () => {
  const changed: string[] = [];
  for (const [kind, added] of SKIPPED_KINDS) {
    assert.ok(added.length, `the recordings hold a ${kind} line`);
    try {
      assert.deepEqual(claudeStream.read(afterInit(SUCCESS, added)), SUCCESS_READ);
    } catch {
      changed.push(kind);
    }
  }
  assert.deepEqual(changed, []);
  assert.deepEqual(claudeStream.read(without(SUCCESS, 'user', 'rate_limit_event')), SUCCESS_READ);
});

// Issue decision 4 and plan A3: each error value Claude sends maps to one Failure Class.
const ERROR_CLASSES: Record<string, string> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'quota',
  rate_limit: 'rate-limited',
  overloaded: 'transient',
  server_error: 'transient',
  invalid_request: 'unknown',
  model_not_found: 'unknown',
  max_output_tokens: 'unknown',
  unknown: 'unknown',
};

// The two lines an error value comes in: the synthetic assistant line of a failed call (auth-failure), and the last
// api_retry line, when no synthetic line follows it (api-retry without its assistant line).
const ERROR_SOURCES: [string, (error: string) => string[]][] = [
  [
    'synthetic assistant line',
    (error) =>
      lines('auth-failure').map((line) => (line.includes('"<synthetic>"') ? withField(line, 'error', error) : line)),
  ],
  [
    'last api_retry line',
    (error) => {
      const recorded = without(lines('api-retry'), 'assistant');
      const last = only(recorded, 'system/api_retry').at(-1);
      return recorded.map((line) => (line === last ? withField(line, 'error', error) : line));
    },
  ],
];

test('every error value maps to its one Failure Class from either source', () => {
  const got: Record<string, string | null> = {};
  const expected: Record<string, string> = {};
  for (const [source, streamOf] of ERROR_SOURCES)
    for (const [error, failureClass] of Object.entries(ERROR_CLASSES)) {
      got[`${source}: ${error}`] = claudeStream.read(streamOf(error)).failure?.failureClass ?? null;
      expected[`${source}: ${error}`] = failureClass;
    }
  assert.deepEqual(got, expected);
});

// A drive then a slash at any escape depth, or a Git Bash path under any drive's root (#486); a slash before the
// Git Bash form rules it out, since a URL's host and path segments always follow one.
const ABSOLUTE_LOCAL_PATH = /\b[A-Za-z]:[\\/]|(?<![\w.<>/-])\/[a-z]\/(?=[\w.~-])/;

test('the recording scan flags a local path in any form and leaves a URL or a relative path', () => {
  const samples = {
    '"cwd":"/c/dev/repo"': true,
    'cd /d/scratch && ls': true,
    '/c/Users/someone': true,
    'C:\\\\dev\\\\repo': true,
    'https://docs.anthropic.com/en/docs/x': false,
    'https://a/b': false,
    'http://x/y/z': false,
    'https://example.com//a/b': false,
    '<recording>/c/x': false,
    'see ./a/b': false,
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(samples).map((text) => [text, ABSOLUTE_LOCAL_PATH.test(text)])),
    samples,
  );
});

test('no recording holds an absolute local path', () => {
  const recordings = new URL('../fixtures/claude/', import.meta.url);
  const withPath = readdirSync(recordings)
    .filter((file) => /\.jsonl?$/.test(file))
    .filter((file) => ABSOLUTE_LOCAL_PATH.test(readFileSync(new URL(file, recordings), 'utf8')));
  assert.deepEqual(withPath, []);
});
