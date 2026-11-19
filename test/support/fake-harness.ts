// A scripted stand-in for a Harness. It never spawns anything; a test drives it through `responses`, keyed by
// keys.responseKey: the call's Vertex, Visit and Attempt, and the Action and Recovery Number its Action Marker names.
// test/contract/harness/ runs the Harness contract against it.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type * as commandCleanup from '../../lib/command-cleanup.ts';
import type * as events from '../../lib/events.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as marker from '../../lib/marker.ts';
import type * as runContext from '../../lib/run-context.ts';
import type * as visit from '../../lib/visit.ts';
import * as keys from './keys.ts';

type Usage = events.Usage;

// The frozen version of the fake harness's scripting keys (docs/interfaces/harness.md); a change needs a new ADR (#23).
export const FAKE_HARNESS_VERSION = 3;

const DEFAULT_CAPABILITIES = {
  skills: 'exact',
  mcp: 'exact',
  plugins: 'exact',
  access: 'exact',
  network: 'exact',
  contextBudget: 'exact',
  interactive: false,
  backgroundSessions: false,
  sessionResume: { supported: true, preconditions: [] },
  structuredOutput: true,
  sandbox: 'none',
  confinement: 'none',
  peakContextReporting: true,
  costReporting: true,
  turnCountReporting: true,
  toolCallReporting: true,
  reasoningTokenReporting: true,
  backgroundWork: 'none',
};

// One Attempt's script: the files it writes, its Structured Response, and its result fields (`usage.delta` among them),
// a failure it reports, an error it throws, or `hang` until cancel() or the call's signal; `cleanup` is what its
// Command Cleanup reports, confirmed unless the script says otherwise.
export interface ScriptedResponse {
  cleanup?: commandCleanup.CleanupReport;
  files?: Record<string, string>;
  response?: unknown;
  result?: { usage?: { delta?: Partial<Usage> }; sessionInit?: object; [field: string]: unknown };
  failure?: visit.HarnessFailure;
  throw?: unknown;
  hang?: boolean;
}
export type ScriptedResponses = Record<string, ScriptedResponse>;

// What the interpreter passes a Harness's run, as the fake reads it.
export interface HarnessCall {
  vertex: string;
  visit: number;
  phase: string;
  attempt: number;
  cwd: string;
  marker: string;
  brief?: string;
  resume?: string | null;
  tools?: unknown;
  access?: string;
  network?: boolean;
  persona?: { hash?: string; bytes?: string } | null;
  schema?: unknown;
  [field: string]: unknown;
}

interface Session {
  id: string;
  transcriptPath: string;
  cumulative: Usage;
}

export interface FakeHarnessOptions {
  name?: string;
  capabilities?: Record<string, unknown>;
  protectedPaths?: string[];
  responses?: ScriptedResponses;
  transcriptDir?: string;
  validate?: (agent: unknown) => { ok: boolean; errors: string[] };
  resolveTools?: (agent: { tools?: unknown } | undefined, context?: runContext.ToolsContext) => unknown;
}

const CONFIRMED: commandCleanup.CleanupReport = {
  confirmed: true,
  survivors: [],
  reason: null,
  containment: { kind: 'job' },
};

const emptyInit = () => ({ plugins: [], pluginErrors: [], mcpServers: [], mcpServerErrors: [], capabilities: [] });

const addUsage = (total: Usage, delta: Usage): Usage =>
  contract.usageOf((field) => {
    const [before, added] = [total[field] ?? 0, delta[field]];
    if (added == null) return null;
    return field === 'peakContextTokens' ? Math.max(before, added) : before + added;
  });

// A script's failure and result fields, read once the call has written its files and opened its Session, before it
// waits on a cancel; its response is read when the call returns.
function scriptedResult(script: ScriptedResponse) {
  const failure = script.failure ? { retryAfterMs: null, message: '', ...script.failure } : null;
  const { usage: _usage, sessionInit, ...overrides } = script.result ?? {};
  return { failure, sessionInit, overrides };
}

interface Answered {
  script: ScriptedResponse;
  scripted: ReturnType<typeof scriptedResult>;
  session: Session;
  delta: Usage;
}

// What run returns for a call that ended with `status`: a killed call keeps none of the script's result or failure.
function outcomeOf({ script, scripted, session, delta }: Answered, status: string) {
  const { failure, sessionInit, overrides } = scripted;
  return {
    response: script.response ?? null,
    result: {
      status,
      sessionId: session.id,
      usage: { cumulative: { ...session.cumulative }, delta },
      transcriptPath: session.transcriptPath,
      exitCode: status === 'completed' ? 0 : 1,
      exitSignal: status === 'killed' ? 'SIGTERM' : null,
      repositoryDigest: null,
      agentCliVersion: null,
      effectiveModel: null,
      effectiveEffort: null,
      finalEventSubtype: status === 'completed' ? 'success' : null,
      sessionInit: { ...emptyInit(), ...sessionInit },
      permissionDenials: [],
      commandsRun: 0,
      cleanup: script.cleanup ?? CONFIRMED,
      ...(status === 'killed' ? {} : overrides),
    },
    failure: status === 'killed' ? null : failure,
  } as Awaited<ReturnType<runContext.Harness['run']>>;
}

async function writeFiles(cwd: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

// Each script's usage delta over the empty usage the capabilities give: a field the capabilities omit stays null.
const deltaOf = (script: ScriptedResponse, empty: Usage): Usage => {
  const costBasis = script.result?.usage?.delta?.costBasis;
  const counts = contract.usageOf((field) =>
    empty[field] === null ? null : (script.result?.usage?.delta?.[field] ?? empty[field]),
  );
  return costBasis === undefined ? counts : { ...counts, costBasis };
};

function sessionStore(capabilities: Record<string, unknown>, transcriptDir: string | undefined) {
  const sessions = new Map<string, Session>();
  const open = async (resume: string | null | undefined): Promise<Session> => {
    if (resume) {
      const resumed = sessions.get(resume);
      if (!resumed) throw new Error(`fake harness has no session ${resume} to resume`);
      return resumed;
    }
    // Register before the first await so concurrent calls never share an id.
    const id = `fake-session-${sessions.size + 1}`;
    const directory = transcriptDir as string;
    const session = {
      id,
      transcriptPath: join(directory, `${id}.jsonl`),
      cumulative: contract.emptyUsage(capabilities),
    };
    sessions.set(id, session);
    await mkdir(directory, { recursive: true });
    await writeFile(session.transcriptPath, '');
    return session;
  };
  return { open, metrics: (id: string) => sessions.get(id)?.cumulative ?? null };
}

const recordedCall = (call: HarnessCall) => ({
  marker: call.marker,
  brief: call.brief,
  resume: call.resume,
  tools: call.tools,
  cwd: call.cwd,
  access: call.access,
  network: call.network,
  personaHash: call.persona?.hash,
  personaBytes: call.persona?.bytes,
  schema: call.schema,
  previousUsage: call.previousUsage,
  runDirectory: call.runDirectory,
});

export function fakeHarness({
  name = 'fake',
  capabilities,
  protectedPaths = [],
  responses = {},
  transcriptDir,
  validate = () => ({ ok: true, errors: [] }),
  resolveTools = (agent) => agent?.tools ?? {},
}: FakeHarnessOptions = {}) {
  const fullCapabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
  const sessions = sessionStore(fullCapabilities, transcriptDir);
  const hung: (() => void)[] = [];
  const calls: ReturnType<typeof recordedCall>[] = [];

  async function run(call: HarnessCall, hooks?: runContext.HarnessHooks) {
    calls.push(recordedCall(call));
    const { action, recovery } = marker.partsOf(call.marker);
    const key = keys.responseKey({ ...call, action, recovery: Number(recovery) });
    const script = responses[key];
    if (!script) throw new Error(`fake harness has no scripted response for ${key}`);
    if (script.throw) throw script.throw;
    // Its started report names the containment its cleanup reports, as gg's command runner does: a job or none.
    hooks?.started({ kind: (script.cleanup ?? CONFIRMED).containment.kind === 'job' ? 'job' : 'none' });
    // Register before the first await so a cancel() or an abort during setup is not lost.
    const cancelled = script.hang
      ? new Promise<void>((resolve) => {
          hung.push(resolve);
          if (hooks?.signal.aborted) resolve();
          hooks?.signal.addEventListener('abort', () => resolve(), { once: true });
        })
      : null;
    await writeFiles(call.cwd, script.files ?? {});
    const session = await sessions.open(call.resume);
    const delta = deltaOf(script, contract.emptyUsage(fullCapabilities));
    session.cumulative = addUsage(session.cumulative, delta);
    const answered = { script, scripted: scriptedResult(script), session, delta };
    if (cancelled) {
      await cancelled;
      return outcomeOf(answered, 'killed');
    }
    return outcomeOf(answered, answered.scripted.failure ? 'failed' : 'completed');
  }

  return {
    name,
    capabilities: fullCapabilities,
    protectedPaths,
    validate,
    resolveTools,
    run: run as (call: Record<string, unknown>, hooks?: runContext.HarnessHooks) => ReturnType<typeof run>,
    interactiveArgs: () => [],
    metrics: sessions.metrics,
    doctor: () => ({ ok: true, checks: [] }),
    calls,
    // Test-only: resolves every hung call as killed, as an aborted signal does its own call.
    cancel: () => {
      for (const resolve of hung.splice(0)) resolve();
    },
  };
}

export type FakeHarness = ReturnType<typeof fakeHarness>;
