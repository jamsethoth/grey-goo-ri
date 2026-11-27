// One Attempt through `codex exec` (#482), for lib/harnesses/codex.ts alone: the launch profile's files written, the
// prompt on stdin, the call over the shared run loop (#480), and the contract's result from the stream, the -o file and
// the rollout, a resume held to the sandbox its rollout's last turn ran under.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as commandCleanup from '../command-cleanup.ts';
import type * as events from '../events.ts';
import type * as exec from '../exec.ts';
import * as jsonValue from '../json-value.ts';
import type * as runContext from '../run-context.ts';
import type * as visit from '../visit.ts';
import * as cliCall from './cli-call.ts';
import type * as codex from './codex.ts';
import * as codexStream from './codex-stream.ts';
import * as contract from './contract.ts';

// What run reads of the call beyond launchArgs's (docs/interfaces/harness.md, SentCall).
export interface RunCall extends codex.CodexCall {
  persona: { bytes: string };
  brief: string;
  previousUsage: events.Usage | null;
  tools: codex.CodexTools;
  timeouts: { stallMs?: number; wallMs?: number };
  env: Record<string, string>;
}

// What the Harness gives run: gg's Codex home, which holds the rollouts, and the launch profile's launch of a call,
// which fails when a listing does or Codex lacks a tool the call lists.
export interface Runs {
  codexHome: string;
  launch: (call: RunCall) => Promise<codex.Launch>;
}

type RunResult = Awaited<ReturnType<runContext.Harness['run']>>;

// The limits a call runs under when its Agent sets none, the Claude Harness's (decision 3 of #425).
const DEFAULT_TIMEOUTS = { stallMs: 900_000, wallMs: 7_200_000 };

const unknownFailure = (message: string): visit.HarnessFailure => ({
  failureClass: 'unknown',
  retryAfterMs: null,
  message,
});

// A call's Usage (decision 3, F3): turn.completed's tokens are the thread's total, the stream's tool calls this call's
// own, which a resumed call adds to the earlier total. Codex reports no cost, peak context, turns or compactions, and a
// stream with no turn.completed no tokens: each null, never 0, with no cost basis (#487).
function usageOf(stream: codexStream.CodexStream, previous: events.Usage | null) {
  const cumulative = contract.usageOf((field) =>
    field === 'toolCalls'
      ? (previous?.toolCalls ?? 0) + stream.toolCalls
      : (stream.totals?.[field as keyof codexStream.Totals] ?? null),
  );
  const delta = contract.usageDelta(cumulative, previous, null);
  return { cumulative: { ...cumulative, costBasis: null }, delta: { ...delta, costBasis: null } };
}

// A call that started no `codex exec`: its launch could not be built, or its executable could not start.
function unstarted(failure: visit.HarnessFailure | null, stream: codexStream.CodexStream, call: RunCall): RunResult {
  const usage = usageOf(stream, call.previousUsage);
  const result = {
    status: 'failed' as const,
    sessionId: null,
    transcriptPath: null,
    usage,
    cleanup: commandCleanup.NO_COMMAND,
  };
  return { response: null, result, failure };
}

// A resume recomputes its sandbox from its own flags (openai/codex#40149), so its rollout's last turn says what it ran
// under: a rollout missing, or under another sandbox than the call asked, discards the output (ported, feature-flow
// 89e1d67 lib/adapters.mjs:74-78,111).
function resumeFailure(call: RunCall, rollout: codexStream.Rollout | null): visit.HarnessFailure | null {
  if (call.resume === null) return null;
  const access = call.access === 'workspace-write' ? 'workspace-write' : 'read-only';
  if (rollout === null) return unknownFailure(`the rollout of resumed thread ${call.resume} is missing`);
  if (rollout.sandbox === access) return null;
  return unknownFailure(
    `resumed thread ${call.resume} ran under ${rollout.sandbox ?? 'no recorded sandbox'}, not ${access}`,
  );
}

// The -o file's final message, never a message the stream sent first (decision 2, F2, codex#19816); none, or text
// that is no JSON, is the malformed case, which gg's validation of the response handles.
function finalMessage(path: string): jsonValue.JsonValue {
  if (!existsSync(path)) return null;
  try {
    return jsonValue.checked(JSON.parse(readFileSync(path, 'utf8')), 'the final message');
  } catch {
    return null;
  }
}

// The launch with its files written, and no final message left from an earlier try at the same Attempt.
async function prepared(runs: Runs, call: RunCall) {
  const launched = await runs.launch(call);
  for (const [path, text] of Object.entries(launched.files)) writeFileSync(path, text);
  rmSync(launched.lastMessage, { force: true });
  return launched;
}

// Codex has no system-prompt flag, so the persona, then gg's skills list, lead a Session's first prompt; a resumed
// thread already holds both (ported, feature-flow 89e1d67 lib/adapters.mjs:70-71; Q4 A).
const promptOf = (call: RunCall, launched: codex.Launch) =>
  call.resume === null ? [call.persona.bytes, launched.skills, call.brief].filter(Boolean).join('\n') : call.brief;

// What the rollout tells of the call: where it is, and the CLI version, model and effort its last turn ran with.
const rolloutFacts = (rollout: codexStream.Rollout | null) => ({
  transcriptPath: rollout?.path ?? null,
  agentCliVersion: rollout?.cliVersion ?? null,
  effectiveModel: rollout?.model ?? null,
  effectiveEffort: rollout?.effort ?? null,
});

// The rollout of the call's thread, or the error a sessions tree that cannot be read throws.
function rolloutOf(codexHome: string, sessionId: string | null): codexStream.Rollout | null | Error {
  if (sessionId === null) return null;
  try {
    return codexStream.rollout(codexHome, sessionId);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// A call that ended: its thread is the one thread.started names, else the resumed one (ported, lib/adapters.mjs:73),
// and its rollout says what it ran with; a rollout that cannot be read fails a completed call, never a throw (request
// section 4), and any other ending keeps its own status and failure (Q2 A). No repository content reaches a call
// (Q18 A), so there is no repository configuration to digest.
function endedResult(
  { status, stream, failure, ended }: cliCall.CliCallEnded<codexStream.CodexStream> & { ended: exec.LaunchResult },
  call: RunCall,
  runs: Runs,
  lastMessage: string,
): RunResult {
  const sessionId = stream.threadId ?? call.resume;
  const read = rolloutOf(runs.codexHome, sessionId);
  const rollout = read instanceof Error ? null : read;
  const unread = read instanceof Error ? unknownFailure(`the rollout could not be read: ${read.message}`) : null;
  const discarded = status === 'completed' ? (unread ?? resumeFailure(call, rollout)) : null;
  const result = {
    status: discarded ? ('failed' as const) : status,
    sessionId,
    usage: usageOf(stream, call.previousUsage),
    exitCode: ended.code,
    exitSignal: ended.signal,
    cleanup: ended.cleanup,
    ...rolloutFacts(rollout),
    repositoryDigest: null,
  };
  const response = status === 'completed' && !discarded ? finalMessage(lastMessage) : null;
  return { response, result, failure: discarded ?? failure };
}

// One Attempt: a launch that could not be built or started is a typed failure, never a throw (request section 4).
export async function run(
  runner: Pick<exec.Exec, 'launch'>,
  runs: Runs,
  call: RunCall,
  hooks: runContext.HarnessHooks,
): Promise<RunResult> {
  const launched = await prepared(runs, call).catch((err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
  );
  if (launched instanceof Error) return unstarted(unknownFailure(launched.message), codexStream.read([]), call);
  const called = await cliCall.run(runner, hooks, {
    launch: {
      command: 'codex',
      args: launched.argv,
      cwd: call.cwd,
      env: { ...launched.env, ...call.env },
      input: promptOf(call, launched),
      stallMs: call.timeouts.stallMs ?? DEFAULT_TIMEOUTS.stallMs,
      wallMs: call.timeouts.wallMs ?? DEFAULT_TIMEOUTS.wallMs,
    },
    read: codexStream.read,
  });
  const { ended } = called;
  if (ended === null) return unstarted(called.failure, called.stream, call);
  return endedResult({ ...called, ended }, call, runs, launched.lastMessage);
}
