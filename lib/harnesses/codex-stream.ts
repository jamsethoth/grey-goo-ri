// What a Codex call's `--json` events and its rollout say (#482), read for lib/harnesses/codex.ts alone: the thread,
// the failure and its Failure Class, the Session's token totals and the tool calls from the stream, and the CLI
// version, model, effort and sandbox of the last turn from the rollout, found by thread id in the sessions tree.
import type * as visit from '../visit.ts';

// The last turn.completed's usage: the thread's cumulative total, mapped to the Usage token rules (request 3.7).
export interface Totals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

// A call's stream, read. `failure` is null only for a stream whose last turn event is turn.completed.
export interface CodexStream {
  threadId: string | null;
  failure: visit.HarnessFailure | null;
  totals: Totals | null;
  toolCalls: number;
}

// What a thread's rollout records: its path, the CLI version that wrote it, and the model, effort and sandbox of its
// last turn.
export interface Rollout {
  path: string;
  cliVersion: string | null;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
}

// A call's stream, from its lines; a line that is not a JSON object is skipped.
export function read(_lines: string[]): CodexStream {
  const totals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  return { threadId: 'stub', failure: { failureClass: 'budget', message: 'stub' }, totals, toolCalls: 0 };
}

// The rollout of `threadId` in `codexHome`'s sessions tree, or null when there is none.
export function rollout(_codexHome: string, _threadId: string): Rollout | null {
  return null;
}
