import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as contract from '../../lib/harnesses/contract.mjs';

const DEFAULT_CAPABILITIES = {
  skills: 'exact', mcp: 'exact', plugins: 'exact', access: 'exact', network: 'exact', contextBudget: 'exact',
  interactive: false, background: false, resume: { supported: true, preconditions: [] }, structuredOutput: true,
  sandbox: 'none', confinement: 'none', peakContext: true, cost: true, turns: true, toolCalls: true,
  reasoningTokens: true, backgroundWork: 'none',
};

const emptyInit = () => ({ plugins: [], pluginErrors: [], mcpServers: [], mcpServerErrors: [], capabilities: [] });

// Scripted stand-in for a Harness. Never spawns anything; tests drive it through `responses`.
export function fakeHarness({
  name = 'fake', capabilities, responses = {}, transcriptDir,
  validate = () => ({ ok: true, errors: [] }), resolveTools = (node) => node?.tools ?? {},
} = {}) {
  const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
  const sessions = new Map();
  const hung = [];
  const calls = [];

  const addUsage = (total, delta) => Object.fromEntries(contract.USAGE_FIELDS.map((field) => {
    if (delta[field] === null) return [field, null];
    return [field, field === 'peakContext' ? Math.max(total[field], delta[field]) : total[field] + delta[field]];
  }));

  async function session(resume) {
    if (resume) {
      if (!sessions.has(resume)) throw new Error(`fake harness has no session ${resume} to resume`);
      return sessions.get(resume);
    }
    // Register before the first await so concurrent calls never share an id.
    const id = `fake-session-${sessions.size + 1}`;
    const s = { id, transcriptPath: join(transcriptDir, `${id}.jsonl`), cumulative: contract.emptyUsage(caps) };
    sessions.set(id, s);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(s.transcriptPath, '');
    return s;
  }

  async function run(call) {
    calls.push({
      marker: call.marker, brief: call.brief, resume: call.resume, tools: call.tools, cwd: call.cwd,
      access: call.access, network: call.network, personaHash: call.persona?.hash,
      personaBytes: call.persona?.bytes, schema: call.schema,
    });
    const key = `${call.vertex}/${call.visit}/${call.phase}/${call.attempt}`;
    const script = responses[key];
    if (!script) throw new Error(`fake harness has no scripted response for ${key}`);
    if (script.throw) throw script.throw;
    // Register before the first await so a cancel() during setup is not lost.
    const cancelled = script.hang ? new Promise((resolve) => hung.push(resolve)) : null;

    for (const [path, content] of Object.entries(script.files ?? {})) {
      const target = join(call.cwd, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const s = await session(call.resume);
    const empty = contract.emptyUsage(caps);
    const delta = Object.fromEntries(Object.entries(empty).map(([field, zero]) =>
      [field, zero === null ? null : script.result?.usage?.delta?.[field] ?? zero]));
    s.cumulative = addUsage(s.cumulative, delta);

    const failure = script.failure ? { retryAfterMs: null, message: '', ...script.failure } : null;
    const { usage: _usage, init, ...overrides } = script.result ?? {};
    const outcome = (status) => ({
      response: script.response ?? null,
      result: {
        status, sessionId: s.id, usage: { cumulative: { ...s.cumulative }, delta }, transcriptPath: s.transcriptPath,
        exitCode: status === 'completed' ? 0 : 1, signal: status === 'killed' ? 'SIGTERM' : null,
        finalEventSubtype: status === 'completed' ? 'success' : null, init: { ...emptyInit(), ...init },
        permissionDenials: [], commandsRun: 0, ...(status === 'killed' ? {} : overrides),
      },
      failure: status === 'killed' ? null : failure,
    });

    if (cancelled) {
      await cancelled;
      return outcome('killed');
    }
    return outcome(failure ? 'failed' : 'completed');
  }

  return {
    name,
    capabilities: caps,
    validate,
    resolveTools,
    run,
    interactiveArgs: () => [],
    metrics: (id) => sessions.get(id)?.cumulative ?? null,
    doctor: () => ({ ok: true, checks: [] }),
    calls,
    // Test-only: resolves every hung call as killed.
    cancel: () => { for (const resolve of hung.splice(0)) resolve(); },
  };
}
