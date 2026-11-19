// What a Claude call's stream-json lines say (#425): its session, its failure, its response and its counts, read from
// the lines as Claude Code wrote them. Only lib/harnesses/claude.ts imports it.
import type * as jsonValue from '../json-value.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as visit from '../visit.ts';

// The init line's report of what loaded: diagnostic only (docs/interfaces/harness.md, sessionInit).
export type SessionInit = {
  plugins: jsonValue.JsonValue;
  pluginErrors: jsonValue.JsonValue;
  mcpServers: jsonValue.JsonValue;
  mcpServerErrors: jsonValue.JsonValue;
  capabilities: jsonValue.JsonValue;
};

// The result line's per-model totals, summed: the Session's running total, not this call's share.
export interface Totals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

// A call's stream, read: what the init line, the assistant lines and the result line said. `failure` is null only for a
// result that is no error after an init that loaded everything; a stream with no result line is a failure.
export interface ClaudeStream {
  sessionId: string | null;
  cliVersion: string | null;
  model: string | null;
  sessionInit: SessionInit | null;
  failure: visit.HarnessFailure | null;
  finalEventSubtype: string | null;
  response: jsonValue.JsonValue;
  permissionDenials: jsonValue.JsonValue;
  commandsRun: number;
  toolCalls: number;
  turns: number;
  compactions: number;
  peakContextTokens: number;
  totals: Totals | null;
}

type Line = Record<string, unknown>;

// Each error value Claude sends, by its Failure Class (issue decision 4, plan A3); any other value is unknown.
const FAILURE_CLASSES: Record<string, string> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'quota',
  rate_limit: 'rate-limited',
  overloaded: 'transient',
  server_error: 'transient',
};

// Claude's own tool that carries the Structured Response: no tool call of the Agent's.
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const SHELL_TOOLS = ['Bash', 'PowerShell'];

function parsed(line: string): Line | null {
  try {
    const value: unknown = JSON.parse(line);
    return referencePaths.isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// What Claude sent, as JSON it parsed: diagnostic values gg passes on unread.
const sent = (value: unknown) => (value ?? null) as jsonValue.JsonValue;
const numberOf = (value: unknown) => (typeof value === 'number' ? value : 0);
const stringOf = (value: unknown) => (typeof value === 'string' ? value : null);
const recordsOf = (value: unknown) => (Array.isArray(value) ? value.filter(referencePaths.isRecord) : []);

// The init line's report; a server that did not connect is an MCP server error.
function sessionInitOf(init: Line): SessionInit {
  const mcpServers = recordsOf(init.mcp_servers);
  return {
    plugins: sent(init.plugins),
    pluginErrors: sent(init.plugin_errors ?? []),
    mcpServers: sent(mcpServers),
    mcpServerErrors: sent([
      ...(Array.isArray(init.mcp_server_errors) ? init.mcp_server_errors : []),
      ...mcpServers.filter((server) => server.status !== 'connected'),
    ]),
    capabilities: sent(init.capabilities),
  };
}

const initFailed = (sessionInit: SessionInit | null) =>
  [sessionInit?.pluginErrors, sessionInit?.mcpServerErrors].some((errors) => Array.isArray(errors) && errors.length);

// The result line's per-model totals, summed; none when it names no model.
function totalsOf(modelUsage: unknown): Totals | null {
  const models = Object.values(referencePaths.isRecord(modelUsage) ? modelUsage : {}).filter(referencePaths.isRecord);
  if (!models.length) return null;
  const sum = (key: string) => models.reduce((total, usage) => total + numberOf(usage[key]), 0);
  return {
    inputTokens: sum('inputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheWriteTokens: sum('cacheCreationInputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: sum('costUSD'),
  };
}

// The status comes from the result's is_error, never its subtype, which says success on an API failure. The class
// comes from the synthetic assistant line's error, else the last api_retry line's; only rate_limit waits.
function failureOf(stream: Line[], result: Line | null, sessionInit: SessionInit | null): visit.HarnessFailure | null {
  if (!result) return { failureClass: 'unknown', message: 'the stream ended with no result line' };
  if (result.is_error !== true)
    return initFailed(sessionInit)
      ? { failureClass: 'unknown', message: 'the init line reported plugin or MCP server errors' }
      : null;
  const message = stringOf(result.result) ?? 'the result is an error';
  if (result.subtype === 'error_max_budget_usd') return { failureClass: 'budget', message };
  const retry = stream.findLast((line) => line.type === 'system' && line.subtype === 'api_retry');
  const error = stream.findLast((line) => line.type === 'assistant' && typeof line.error === 'string')?.error;
  const failureClass = FAILURE_CLASSES[String(error ?? retry?.error)] ?? 'unknown';
  if (failureClass !== 'rate-limited') return { failureClass, message };
  return {
    failureClass,
    retryAfterMs: typeof retry?.retry_delay_ms === 'number' ? retry.retry_delay_ms : null,
    message,
  };
}

// The assistant lines' tool uses by id, Claude's StructuredOutput left out: Claude repeats a message's line for each of
// its content blocks, so an id counts once.
function toolUsesOf(stream: Line[]) {
  const toolUses = new Map<string, unknown>();
  for (const line of stream)
    if (line.type === 'assistant' && referencePaths.isRecord(line.message))
      for (const block of recordsOf(line.message.content))
        if (block.type === 'tool_use' && typeof block.id === 'string' && block.name !== STRUCTURED_OUTPUT_TOOL)
          toolUses.set(block.id, block.name);
  return toolUses;
}

// The largest context a message was sent with: its uncached input, cache reads and cache writes.
const peakOf = (stream: Line[]) =>
  Math.max(
    0,
    ...stream.map((line) => {
      const usage = referencePaths.isRecord(line.message) ? line.message.usage : undefined;
      if (line.type !== 'assistant' || !referencePaths.isRecord(usage)) return 0;
      return ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce(
        (total, key) => total + numberOf(usage[key]),
        0,
      );
    }),
  );

// A call's stream, from its lines; a line that is not a JSON object is skipped.
export function read(lines: string[]): ClaudeStream {
  const stream = lines.map(parsed).filter((line) => line !== null);
  const init = stream.find((line) => line.type === 'system' && line.subtype === 'init');
  const result = stream.findLast((line) => line.type === 'result') ?? null;
  const sessionInit = init ? sessionInitOf(init) : null;
  const toolUses = toolUsesOf(stream);
  const denied = new Set(recordsOf(result?.permission_denials).map((denial) => denial.tool_use_id));
  const shellRuns = [...toolUses].filter(([id, name]) => SHELL_TOOLS.includes(String(name)) && !denied.has(id));
  return {
    sessionId: stringOf(init?.session_id),
    cliVersion: stringOf(init?.claude_code_version),
    model: stringOf(init?.model),
    sessionInit,
    failure: failureOf(stream, result, sessionInit),
    finalEventSubtype: stringOf(result?.subtype),
    response: sent(result?.structured_output),
    permissionDenials: sent(result?.permission_denials),
    commandsRun: shellRuns.length,
    toolCalls: toolUses.size,
    turns: numberOf(result?.num_turns),
    compactions: stream.filter((line) => line.type === 'system' && line.subtype === 'compact_boundary').length,
    peakContextTokens: peakOf(stream),
    totals: totalsOf(result?.modelUsage),
  };
}
