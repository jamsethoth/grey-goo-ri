# Harness interface

Frozen (#23). Every Harness module (`lib/harnesses/claude.ts`, `lib/harnesses/codex.ts`, and the test fake in
`test/support/fake-harness.ts`) exports an object with the same contract. `assertHarness(obj)` in
`lib/harnesses/contract.ts` checks it and throws naming the first missing method or Capability field. Behaviour is
decided by request section 3.2; Usage token rules by section 3.7. A change to anything listed here outside the Reserved
section needs a new ADR under `docs/adr/` and a version bump; `test/unit/freeze.test.ts` holds every block below to the
code.

## Members

| Member | Shape |
| --- | --- |
| `name` | string, the Harness name an Agent selects |
| `capabilities` | the Capability matrix below |
| `protectedPaths` | the paths that configure the Harness, each a directory with a trailing `/` or a file |
| `validate(agent)` | checks an Agent against the matrix; returns a typed result, never throws |
| `resolveTools(agent, ctx)` | the tools the Harness will pass for this Agent, hint fields marked |
| `run(call)` | runs one Attempt; resolves `{ response, result, failure }` |
| `interactiveArgs(agent, opening, opts)` | argv for an interactive session opened with `opening` |
| `metrics(session)` | cumulative Usage of a Session |
| `doctor(cfg)` | behaviour probes for `gg doctor` |

`HARNESS_METHODS` lists these names in this order:

```text list:HARNESS_METHODS
name
capabilities
protectedPaths
validate
resolveTools
run
interactiveArgs
metrics
doctor
```

`lib/harnesses/shipped.ts` lists every shipped Harness by name. The Protected Files (request 3.6) are gg's own paths
plus every shipped Harness's `protectedPaths`, whichever Harnesses the Agents use; `bin/gg.ts` builds that union with
`protectedFiles` (`lib/interpreter.ts`) and passes it to the Run, so the interpreter imports no Harness module.
`protectedFiles` fails, naming the Harness, when a `protectedPaths` is not an array of paths. No module outside
`lib/harnesses/` names a Harness (`test/unit/layout.test.ts`).

## Capability matrix

`CAPABILITY_FIELDS`; names follow Archon's provider contract, whose reporting Capabilities end in `Reporting`.

```text list:CAPABILITY_FIELDS
skills
mcp
plugins
access
network
contextBudget
interactive
backgroundSessions
sessionResume
structuredOutput
sandbox
confinement
peakContextReporting
costReporting
turnCountReporting
toolCallReporting
reasoningTokenReporting
backgroundWork
```

| Field | Values |
| --- | --- |
| `skills`, `mcp`, `plugins`, `access`, `network`, `contextBudget` | `exact` (the Harness enforces it), `hint` (passed as prompt text or best effort, logged as hinted), `unsupported` (an Agent listing it fails preflight) |
| `interactive` | whether `interactiveArgs` is available |
| `backgroundSessions` | whether the Harness can run a Session in the background |
| `sessionResume` | whether a Session can be resumed, with its preconditions |
| `structuredOutput` | whether the Harness enforces the output schema |
| `sandbox` | `none`, `codex-windows` or `codex-posix` |
| `confinement` | the non-sandbox confinement mode, such as `trusted-commands` |
| `peakContextReporting`, `costReporting`, `turnCountReporting`, `toolCallReporting`, `reasoningTokenReporting` | whether the Harness reports that Usage figure (`peakContextTokens`, `costUsd`, `turns`, `toolCalls`, `reasoningTokens`) |
| `backgroundWork` | `reported`, `none` or `unobserved` |

## `run(call)`

The call gg passes is `SentCall` (`lib/agent-action.ts`): `{ marker, vertex, visit, phase, attempt?, agent, persona:
{ name, bytes, hash }, brief, schema, cwd, resume, access, network?, tools, timeouts, env }`. `agent` is the pinned Agent
with its keys (`harness`, `persona`, `model`, `effort`, `network?`, and any other the Agent declares); `resume` is the
Session to resume, or null; `timeouts` is the Agent's own, as configured (`{ stallMs, wallMs }`), or `{}`. The Harness
receives the Persona bytes, never a path. Every path of the call:

```text paths:SentCall
marker: string
vertex: string
visit: number
phase: string
attempt?: number
agent: open object
agent.harness: string
agent.persona: string
agent.model: string | null
agent.effort: string | null
agent.network?: boolean
agent.*: JsonValue
persona: object
persona.name: string
persona.bytes: string
persona.hash: string
brief: string
schema: object
schema.type?: string (referencePaths.SchemaNode)
schema.properties?: keyed (referencePaths.SchemaNode)
schema.properties.*: SchemaNode
schema.required?: list (referencePaths.SchemaNode)
schema.required[]: string
schema.additionalProperties?: boolean (referencePaths.SchemaNode)
schema.items?: object (referencePaths.SchemaNode)
schema.items.type?: string (referencePaths.SchemaNode)
schema.items.properties?: keyed (referencePaths.SchemaNode)
schema.items.properties.*: SchemaNode
schema.items.required?: list (referencePaths.SchemaNode)
schema.items.required[]: string
schema.items.additionalProperties?: boolean (referencePaths.SchemaNode)
schema.items.items?: SchemaNode | undefined (referencePaths.SchemaNode)
schema.items.enum?: list (referencePaths.SchemaNode)
schema.items.enum[]: string
schema.items.min?: number (referencePaths.SchemaNode)
schema.items.max?: number (referencePaths.SchemaNode)
schema.enum?: list (referencePaths.SchemaNode)
schema.enum[]: string
schema.min?: number (referencePaths.SchemaNode)
schema.max?: number (referencePaths.SchemaNode)
cwd: string
resume: string | null
access: string
network?: boolean
tools: JsonValue
timeouts: JsonValue
env: JsonValue
```

It resolves:

```
{ response, result, failure }
```

- `response`: the unvalidated Structured Response object, or `null` when the agent returned none or unparsable output
  (the malformed case). The orchestrator validates it. Its shape is the repository's response schema's, so gg reads it
  as opaque JSON.
- `result`: the Harness Result (`HarnessResult`, `lib/run-context.ts`) `{ status: 'completed' | 'failed' | 'timed-out'
  | 'killed', sessionId, transcriptPath, usage: { cumulative, delta }, exitCode?, exitSignal?, finalEventSubtype?,
  sessionInit?, permissionDenials?, commandsRun?, cleanup? }`. `sessionInit` is `{ plugins, pluginErrors, mcpServers,
  mcpServerErrors, capabilities }` as the Harness's stream reported it. `exitSignal` is the OS signal that ended the
  process, or null. `sessionInit`, `permissionDenials` and `commandsRun` are diagnostic only. Outcomes are classified
  from the final event, not the exit code.
- `cleanup` is `{ confirmed, survivors, reason, containment }` (`CleanupReport`, `lib/command-cleanup.ts`; decisions L6,
  L11, L14). `run` resolves only once the processes it started are gone, or reports that it could not confirm they
  are (L6). A result with no `cleanup` reads as unconfirmed, and unconfirmed holds the Ticket, whatever the `status`: it
  is Pending until a later Run confirms cleanup under the `containment` reported. A Harness that holds a job for an
  unconfirmed call gives the report a `closeJob`, as `exec.runShell` does, which gg calls before it releases the ticket
  lock.
- `failure`: for `failed`, `{ failureClass, retryAfterMs?, message? }` (`HarnessFailure`, `lib/visit.ts`), its class one of `auth`, `quota`, `budget`,
  `rate-limited`, `transient` or `unknown` (`record.md` lists every source's Failure Classes); otherwise `null`.

Every path of the Harness Result and of a failure:

```text paths:HarnessResult
status: "failed" | "completed" | "timed-out" | "killed" (runContext.HarnessResult)
sessionId: string | null (runContext.HarnessResult)
transcriptPath: string | null (runContext.HarnessResult)
usage: object (runContext.HarnessResult)
usage.cumulative: object
usage.cumulative.inputTokens: number | null (events.Usage)
usage.cumulative.cacheReadTokens: number | null (events.Usage)
usage.cumulative.cacheWriteTokens: number | null (events.Usage)
usage.cumulative.outputTokens: number | null (events.Usage)
usage.cumulative.reasoningTokens: number | null (events.Usage)
usage.cumulative.costUsd: number | null (events.Usage)
usage.cumulative.peakContextTokens: number | null (events.Usage)
usage.cumulative.turns: number | null (events.Usage)
usage.cumulative.toolCalls: number | null (events.Usage)
usage.cumulative.compactions: number | null (events.Usage)
usage.cumulative.costBasis?: "reported" | "priced" | null (events.Usage)
usage.delta: object
usage.delta.inputTokens: number | null (events.Usage)
usage.delta.cacheReadTokens: number | null (events.Usage)
usage.delta.cacheWriteTokens: number | null (events.Usage)
usage.delta.outputTokens: number | null (events.Usage)
usage.delta.reasoningTokens: number | null (events.Usage)
usage.delta.costUsd: number | null (events.Usage)
usage.delta.peakContextTokens: number | null (events.Usage)
usage.delta.turns: number | null (events.Usage)
usage.delta.toolCalls: number | null (events.Usage)
usage.delta.compactions: number | null (events.Usage)
usage.delta.costBasis?: "reported" | "priced" | null (events.Usage)
exitCode?: number | null (runContext.HarnessResult)
exitSignal?: string | null (runContext.HarnessResult)
finalEventSubtype?: string | null (runContext.HarnessResult)
sessionInit?: JsonValue (runContext.HarnessResult)
permissionDenials?: JsonValue (runContext.HarnessResult)
commandsRun?: JsonValue (runContext.HarnessResult)
cleanup?: object (runContext.HarnessResult)
cleanup.confirmed: boolean (commandCleanup.CallCleanup)
cleanup.survivors: list (commandCleanup.CallCleanup)
cleanup.survivors[]: object
cleanup.survivors[].error: string (commandCleanup.Survivor)
cleanup.survivors[].pid: number (commandCleanup.Survivor)
cleanup.survivors[].created: string | null (commandCleanup.Survivor)
cleanup.survivors[].commandLine: string | null (commandCleanup.Survivor)
cleanup.reason?: string | null (commandCleanup.CallCleanup)
cleanup.containment?: kind=job | kind=group | kind=none (commandCleanup.CallCleanup)
cleanup.containment<kind=job>.kind: "job"
cleanup.containment<kind=group>.kind: "group"
cleanup.containment<kind=group>.pgid: number
cleanup.containment<kind=none>.kind: "none"
```

```text paths:HarnessFailure
failureClass: string (visit.HarnessFailure)
retryAfterMs?: number | null (visit.HarnessFailure)
message?: string (visit.HarnessFailure)
```

A Harness never throws or rejects for an expected failure; a rejection is an unexpected fault.

`schema` is a Structured Response schema inside gg's strict subset (`assertStrict`, `lib/briefs.ts`): `object` with
every property required and `additionalProperties: false`, `array` with `items`, `string`, `boolean`, `integer`, and
an `enum` of strings. Every Harness accepts every schema in the subset, so one schema serves an Agent on any Harness.
The subset is the common ground of the Harnesses' structured-output modes: Codex's `--output-schema` requires every
property and no extras. It is also narrow enough for gg's own validation and path typing (`validateResponse`,
`fieldType`). Whatever `structuredOutput` says, the orchestrator validates every `response` against the schema.

## Usage

`USAGE_FIELDS`, the counts every Usage holds, in order:

```text list:USAGE_FIELDS
inputTokens
cacheReadTokens
cacheWriteTokens
outputTokens
reasoningTokens
costUsd
peakContextTokens
turns
toolCalls
compactions
```

`inputTokens` is uncached input only, `cacheReadTokens` is cache reads, `cacheWriteTokens` is cache creation. Every
field whose reporting Capability (`reasoningTokenReporting`, `costReporting`, `peakContextReporting`,
`turnCountReporting`, `toolCallReporting`) is declared absent is `null`, never `0`; `emptyUsage(capabilities)` builds
that shape. On resume `cumulative` is the Session's running total and `delta` is this Attempt's share. A Usage may also
name its `costBasis`, `reported` (the Harness's own figure) or `priced` (gg priced the tokens), or `null`; any other key
is refused (`events.Usage`, `events.md`).

## The fake harness

`test/support/fake-harness.ts` stands in for a Harness in every test: it never spawns anything, and a test scripts it.
Its scripting version is `FAKE_HARNESS_VERSION = 1`, and every scripting key below is frozen with it.

Beyond `HARNESS_METHODS`, the fake has only these test-only members: `calls`, every call it was given, and `cancel()`,
which resolves every hung call as `killed`.

```text list:fake-harness-test-only
calls
cancel
```

A test gives it `responses`, keyed `<vertex>/<visit>/<phase>/<attempt>` (`keys.responseKey`), each a
`ScriptedResponse`: the files the Attempt writes, its Structured Response, its result fields (`usage.delta` among
them), a failure it reports, an error it throws, or `hang` until `cancel()`, and the cleanup its Command Cleanup
reports, confirmed unless the script says otherwise (`closeJob` is a function, as a real report's is; `throw` is any value
thrown, an `Error` among them). Every path a script may hold:

```text paths:ScriptedResponse
cleanup?: object (fakeHarness.ScriptedResponse)
cleanup.confirmed: boolean (commandCleanup.CleanupReport)
cleanup.survivors: list (commandCleanup.CleanupReport)
cleanup.survivors[]: object
cleanup.survivors[].error: string (commandCleanup.Survivor)
cleanup.survivors[].pid: number (commandCleanup.Survivor)
cleanup.survivors[].created: string | null (commandCleanup.Survivor)
cleanup.survivors[].commandLine: string | null (commandCleanup.Survivor)
cleanup.reason: string | null (commandCleanup.CleanupReport)
cleanup.containment: kind=job | kind=group | kind=none (commandCleanup.CleanupReport)
cleanup.containment<kind=job>.kind: "job"
cleanup.containment<kind=group>.kind: "group"
cleanup.containment<kind=group>.pgid: number
cleanup.containment<kind=none>.kind: "none"
cleanup.closeJob?: () => void (commandCleanup.CleanupReport)
files?: keyed (fakeHarness.ScriptedResponse)
files.*: string
response?: unknown (fakeHarness.ScriptedResponse)
result?: open object (fakeHarness.ScriptedResponse)
result.usage?: object
result.usage.delta?: object
result.usage.delta.inputTokens?: number | null
result.usage.delta.cacheReadTokens?: number | null
result.usage.delta.cacheWriteTokens?: number | null
result.usage.delta.outputTokens?: number | null
result.usage.delta.reasoningTokens?: number | null
result.usage.delta.costUsd?: number | null
result.usage.delta.peakContextTokens?: number | null
result.usage.delta.turns?: number | null
result.usage.delta.toolCalls?: number | null
result.usage.delta.compactions?: number | null
result.usage.delta.costBasis?: "reported" | "priced" | null
result.sessionInit?: object
result.*: unknown
failure?: open object (fakeHarness.ScriptedResponse)
failure.kind?: string
failure.retryAfterMs?: number | null
failure.message?: string
failure.*: unknown
throw?: unknown (fakeHarness.ScriptedResponse)
hang?: boolean (fakeHarness.ScriptedResponse)
```

## Reserved

Shapes later tickets land without a version bump; the landing ticket moves each into the contract.

- **#68, an Interrupted Attempt retried (N1).** The Harness's report that it has started, given before `run` resolves,
  carrying the containment kind (`job`, `none`; `cgroup` later, #128) and an optional identity, so gg saves the kind in
  the call intent by a second write (`record.md`).
- **#135, cost and quota reports (J13).** The Harness Result's `quota`: `null` or `{ plan, windows: [{ limit,
  windowMinutes, resetsAt, usedPercent: { first, last } }], credits: { balance, unit } | null }`, the snapshots the
  Harness saw during the Attempt; the Capability `quotaReporting` (`reported`, `partial` or `none`); and the fake
  harness's `quota` scripting key, which scripts it.
