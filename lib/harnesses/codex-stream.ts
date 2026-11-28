// What a Codex call's `--json` events and its rollout say (#482), read for lib/harnesses/codex.ts alone: the thread,
// the failure and its Failure Class, the Session's token totals and the tool calls from the stream, and the CLI
// version, model, effort and sandbox of the last turn from the rollout, found by thread id in the sessions tree.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as referencePaths from '../reference-paths.ts';
import type * as visit from '../visit.ts';

// The last turn.completed's usage: the thread's cumulative total, mapped to the Usage token rules (request 3.7).
// A count the usage leaves out is null, never 0 (decision 3).
export interface Totals {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

// A call's stream, read. `failure` is null only for a stream whose last turn event is turn.completed.
export interface CodexStream {
  threadId: string | null;
  failure: visit.HarnessFailure | null;
  totals: Totals | null;
  toolCalls: number;
}

// What a thread's rollout records: its path, the CLI version that wrote it, and the model, effort and sandbox of its
// last turn, and the context its first request sent: the first token_count's input tokens, cached ones among them,
// where a fresh Session starts (#497).
export interface Rollout {
  path: string;
  cliVersion: string | null;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  startContextTokens: number | null;
}

type Line = Record<string, unknown>;

// Each failure text Codex 0.171 ends a turn with, by its Failure Class, the first match winning; any other is unknown
// (Q2 A: codex-rs/codex-api/src/api_bridge.rs and codex-rs/protocol/src/error.rs at rust-v0.171.0). The stream carries
// a message only, with no code, and writes a status as "unexpected status N" or "last status: N". Codex has no spend
// limit of its own (budget), and no text gives a wait gg could honour.
const FAILURE_CLASSES: [string, (string | RegExp)[]][] = [
  ['auth', [/(?:unexpected status|last status:) 401\b/]],
  [
    'quota',
    [
      'You’ve hit your usage limit',
      'Your workspace is out of credits',
      'You hit your spend cap',
      'Quota exceeded.',
      'To use Codex with your ChatGPT plan',
    ],
  ],
  ['rate-limited', [/(?:unexpected status|last status:) 429\b/, 'rate limit exceeded:']],
  [
    'transient',
    [
      'Selected model is at capacity',
      'We’re currently experiencing high demand',
      'stream disconnected before completion',
      'Connection failed:',
      /(?:unexpected status|last status:) 5\d\d\b/,
    ],
  ],
];

const said = (text: string, pattern: string | RegExp) =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

// The items that are a tool call of the Agent's: a message, reasoning or an error item is none.
const TOOL_ITEMS = ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'];

// The events that end a turn, or report why it cannot go on.
const TURN_ENDS = ['turn.completed', 'turn.failed', 'error'];

function parsed(line: string): Line | null {
  try {
    const value: unknown = JSON.parse(line);
    return referencePaths.isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const linesOf = (lines: string[]) => lines.map(parsed).filter((line) => line !== null);
const numberOf = (value: unknown) => (typeof value === 'number' ? value : null);
const stringOf = (value: unknown) => (typeof value === 'string' ? value : null);
const recordOf = (value: unknown): Line => (referencePaths.isRecord(value) ? value : {});

// Codex's input_tokens holds its cached and cache-write tokens, since Codex reads both from the API's
// `input_tokens_details`, a breakdown of input_tokens (codex-rs/codex-api/src/sse/responses.rs at rust-v0.171.0), and
// output_tokens its reasoning tokens, which are reported beside it and never added again.
function totalsOf(usage: Line): Totals {
  const input = numberOf(usage.input_tokens);
  const cached = numberOf(usage.cached_input_tokens);
  const written = numberOf(usage.cache_write_input_tokens);
  return {
    inputTokens: input === null || cached === null || written === null ? null : input - cached - written,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    outputTokens: numberOf(usage.output_tokens),
    reasoningTokens: numberOf(usage.reasoning_output_tokens),
  };
}

// The outcome comes from the final event, never the exit code (decision 4): an error event the turn recovers from,
// Codex's own retry, is no failure, and a stream stopped mid-turn is unknown.
function failureOf(stream: Line[]): visit.HarnessFailure | null {
  const last = stream.findLast((line) => TURN_ENDS.includes(String(line.type)));
  if (last?.type === 'turn.completed') return null;
  if (!last) return { failureClass: 'unknown', retryAfterMs: null, message: 'the stream ended with no turn.completed' };
  const message = stringOf(last.type === 'turn.failed' ? recordOf(last.error).message : last.message);
  const text = message ?? `${String(last.type)} with no message`;
  const failureClass = FAILURE_CLASSES.find(([, patterns]) => patterns.some((pattern) => said(text, pattern)))?.[0];
  return { failureClass: failureClass ?? 'unknown', retryAfterMs: null, message: text };
}

// A call's stream, from its lines; a line that is not a JSON object is skipped.
export function read(lines: string[]): CodexStream {
  const stream = linesOf(lines);
  const completed = stream.findLast((line) => line.type === 'turn.completed');
  return {
    threadId: stringOf(stream.find((line) => line.type === 'thread.started')?.thread_id),
    failure: failureOf(stream),
    totals: completed ? totalsOf(recordOf(completed.usage)) : null,
    toolCalls: stream.filter(
      (line) => line.type === 'item.completed' && TOOL_ITEMS.includes(String(recordOf(line.item).type)),
    ).length,
  };
}

// The rollout of `threadId` in `codexHome`'s sessions tree, or null when there is none. Codex names it
// rollout-<time>-<thread id>.jsonl in a folder of its day, so it is looked for across the whole tree: a thread resumed
// days later keeps its rollout (DVC row L1).
export function rollout(codexHome: string, threadId: string): Rollout | null {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return null;
  const found = readdirSync(sessions, { recursive: true, encoding: 'utf8' }).find(
    (file) => basename(file).startsWith('rollout-') && file.endsWith(`-${threadId}.jsonl`),
  );
  if (found === undefined) return null;
  const path = join(sessions, found);
  const lines = linesOf(readFileSync(path, 'utf8').split('\n'));
  const meta = recordOf(lines.find((line) => line.type === 'session_meta')?.payload);
  const turn = recordOf(lines.findLast((line) => line.type === 'turn_context')?.payload);
  const starts = lines.map((line) =>
    numberOf(recordOf(recordOf(recordOf(line.payload).info).last_token_usage).input_tokens),
  );
  return {
    path,
    cliVersion: stringOf(meta.cli_version),
    model: stringOf(turn.model),
    effort: stringOf(turn.effort),
    sandbox: stringOf(recordOf(turn.sandbox_policy).type),
    startContextTokens: starts.find((tokens) => tokens !== null) ?? null,
  };
}
