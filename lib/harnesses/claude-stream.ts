// What a Claude call's stream-json lines say (#425): its session, its failure, its response and its counts, read from
// the lines as Claude Code wrote them. Only lib/harnesses/claude.ts imports it.
import type * as jsonValue from '../json-value.ts';
import type * as visit from '../visit.ts';

// The init line's report of what loaded: diagnostic only (docs/interfaces/harness.md, sessionInit).
export interface SessionInit {
  plugins: jsonValue.JsonValue;
  pluginErrors: jsonValue.JsonValue;
  mcpServers: jsonValue.JsonValue;
  mcpServerErrors: jsonValue.JsonValue;
  capabilities: jsonValue.JsonValue;
}

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

// stub: #425 Green reads the lines.
export function read(_lines: string[]): ClaudeStream {
  return {
    sessionId: 'stub',
    cliVersion: 'stub',
    model: 'stub',
    sessionInit: null,
    failure: null,
    finalEventSubtype: 'stub',
    response: 'stub',
    permissionDenials: 'stub',
    commandsRun: -1,
    toolCalls: -1,
    turns: -1,
    compactions: -1,
    peakContextTokens: -1,
    totals: null,
  };
}
