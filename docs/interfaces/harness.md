# Harness interface

Every Harness module (`lib/harnesses/claude.mjs`, `lib/harnesses/codex.mjs`, and the test fake in
`test/support/fake-harness.mjs`) exports an object with the same contract. `assertHarness(obj)` in
`lib/harnesses/contract.mjs` checks it and throws naming the first missing method or Capability field. Behaviour is
decided by request section 3.2; Usage token rules by section 3.7.

## Members

| Member | Shape |
| --- | --- |
| `name` | string, the Harness name an Agent selects |
| `capabilities` | the Capability matrix below |
| `validate(agent)` | checks an Agent against the matrix; returns a typed result, never throws |
| `resolveTools(agent, ctx)` | the tools the Harness will pass for this Agent, hint fields marked |
| `run(call)` | runs one Attempt; resolves `{ response, result, failure }` |
| `interactiveArgs(agent, opening, opts)` | argv for an interactive session opened with `opening` |
| `metrics(session)` | cumulative Usage of a Session |
| `doctor(cfg)` | behaviour probes for `gg doctor` |

`HARNESS_METHODS` lists these names in this order.

## Capability matrix

`CAPABILITY_FIELDS`; names follow Archon's provider contract.

| Field | Values |
| --- | --- |
| `skills`, `mcp`, `plugins`, `access`, `network`, `contextBudget` | `exact` (the Harness enforces it), `hint` (passed as prompt text or best effort, logged as hinted), `unsupported` (an Agent listing it fails preflight) |
| `interactive` | whether `interactiveArgs` is available |
| `background` | whether the Harness can run an Attempt in the background |
| `resume` | whether a Session can be resumed, with its preconditions |
| `structuredOutput` | whether the Harness enforces the output schema |
| `sandbox` | `none`, `codex-windows` or `codex-posix` |
| `confinement` | the non-sandbox confinement mode, such as `trusted-commands` |
| `peakContext`, `cost`, `turns`, `toolCalls`, `reasoningTokens` | whether the Harness reports that Usage figure |
| `backgroundWork` | `reported`, `none` or `unobserved` |

## `run(call)`

```
call = { marker, vertex, visit, phase, attempt, agent, persona: { bytes, hash }, brief, schema, cwd,
         resume: sessionId | null, access, network, tools, timeouts: { stallMs, wallMs }, env }
```

The Harness receives the Persona bytes, never a path.

```
{ response, result, failure }
```

- `response`: the unvalidated Structured Response object, or `null` when the agent returned none or unparsable output
  (the malformed case). The orchestrator validates it.
- `result`: the Harness Result `{ status: 'completed' | 'failed' | 'timed-out' | 'killed', sessionId,
  usage: { cumulative, delta }, transcriptPath, exitCode, signal, finalEventSubtype,
  init: { plugins, pluginErrors, mcpServers, mcpServerErrors, capabilities }, permissionDenials, commandsRun }`.
  `commandsRun` is diagnostic only. Outcomes are classified from the final event, not the exit code.
- `failure`: for `failed`, `{ class: 'auth' | 'quota' | 'budget' | 'rate-limited' | 'transient' | 'unknown',
  retryAfterMs, message }`; otherwise `null`.

A Harness never throws or rejects for an expected failure; a rejection is an unexpected fault.

## Usage

`USAGE_FIELDS`: `{ input, cached, cacheWrite, output, reasoning, costUsd, peakContext, turns, toolCalls, compactions }`.
`input` is uncached input only, `cached` is cache reads, `cacheWrite` is cache creation. Every field whose Capability
(`reasoningTokens`, `cost`, `peakContext`, `turns`, `toolCalls`) is declared absent is `null`, never `0`;
`emptyUsage(capabilities)` builds that shape. On resume `cumulative` is the Session's running total and `delta`
is this Attempt's share.
