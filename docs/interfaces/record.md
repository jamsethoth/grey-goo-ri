# Execution Record and Epic Record

Frozen (#23). The Execution Record is the saved state of one Execution, from which it resumes; the Epic Record holds an
Epic's plan decision and its open Approval Request. Each is one row of the State Database. A change to anything listed
here outside the Reserved section needs a new ADR under `docs/adr/` and a version bump.

- Code source: `ExecutionRecord` and `EpicRecord` (`lib/record.ts`), saved as `ExecutionRecordJson` and `EpicRecordJson`
  (`lib/record-json.ts`), and read back field by field by `lib/record-read.ts`, which refuses any other shape. The
  types are the one declaration: tsc holds each reader to its type both ways (#402).
- Version: `RECORD_SCHEMA_VERSION = 3`, saved as each row's `schemaVersion`. A row of version 2, the one before, still
  reads: each field version 3 added is optional, so a row without it reads (ADR 0024). Every save writes the current
  version, whichever version the row was read at. A row of any other version is a corrupt row, never read as this one.
- Version 3 added the hand-off (#430, ADR 0029): the retry kind `handoff` in `retries.*` and `retryKind`, the fixed
  rows `handed-off` and `handoff-exhausted`, and each Session an Action handed off, in `sessions.*.handedOff`.
- Version 2 added the Harness Result's `repositoryDigest`, `agentCliVersion`, `effectiveModel` and `effectiveEffort`
  (#422).
- The State Database version: `stateDatabase.SCHEMA_VERSION = 1`, its `user_version` (below).

`test/unit/freeze.test.ts` holds every block below to the code: change one and the test names the difference.

## Rules every field follows

- A fresh record declares every field it will ever hold, `null` until set. `record.save` refuses a row that leaves a
  declared field out or adds an undeclared one, so a shape added later lives inside an existing field.
- `null` means deliberately empty; a key a type marks optional (`?` below) may be left out of the row.
- `commonDir` is where the row is, so the row does not hold it.
- A Map in memory (`visits`, `traversals`, `visitState.runs`, `visitState.checks`) is saved as an object keyed by name.
- `ticket` always equals `owner.number`. Until request slice 7 only a Ticket owns an Execution (`owner.kind` is
  `ticket`); an Epic-owned planning Execution keeps the same row key, `('ticket', n)`, and the same id, `<n>.<hex>`
  (X3; GitHub numbers issues and pull requests in one sequence, so an Epic's number is never a Ticket's).
- An Agent's `response` and the `response` an Action output holds are JSON whose shape the repository owns (its
  response schemas), so a field such as `repeatOf` (#127) needs no version bump (N8). They are marked `JsonValue`.
- A Check's evidence beyond `command`, `output` and `foundByNameOnly` is gg's own, saved as JSON keyed by name, so the
  paths below mark it `*: JsonValue`. An Effect's evidence is typed form by form (the write-ahead log, below).

## Top-level fields

The Execution Record's fields, in the order a fresh record declares them:

```text fields:ExecutionRecord
schemaVersion
repository
execution
ticket
owner
epic
flow
configHash
run
state
terminalReason
terminalStop
admissionStop
cursor
visits
traversals
retries
sessions
attempts
outputs
testCommits
history
worktree
branch
base
pr
approvalRequest
configurationSnapshot
visitState
activity
heartbeat
writeAheadLog
```

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `RECORD_SCHEMA_VERSION` |
| `repository` | the repository's GitHub `owner/name` |
| `execution` | the Execution's id, `<ticket>.<6 hex>` |
| `ticket`, `owner` | the issue that owns the Execution: `owner` is `{ kind: ticket \| epic, number }` (X3) |
| `epic` | the Ticket's Epic, or null |
| `flow`, `configHash` | the Flow's name and the Config Hash of the Pinned Configuration it runs under |
| `run` | the Run that last ran it |
| `state` | `active` until it reaches an end state, `held`, `fault` or `abandoned`; `done` once a person resolves it with `gg work done` (#133) |
| `terminalReason` | why it reached its end state: `{ decidedBy, outcome, rule, text }` (request 3.3; below) |
| `terminalStop` | how the Terminal classified the stop, saved before its first reporting Action |
| `admissionStop` | a hold, abandonment or fault admission decided, until its Terminal reports it |
| `cursor` | where it is: `{ vertex, visit, action, recovery, attempt }`, or a Terminal's Vertex with no Visit |
| `visits`, `traversals` | Visits per Vertex, and traversals per bounded Edge `from->to:outcome` |
| `retries` | each Action's spent retry budgets by kind, and a remote Effect's saved retry state |
| `sessions` | each resumable agent Session by Vertex, Visit and Action, with its cumulative Usage |
| `attempts` | the Flow Attempts entered, which the Action Cap bounds |
| `outputs` | each Action's outputs, `{ vertex, visit, action, value }`, which later Visits' inputs read |
| `testCommits` | gg's first test commit, and the commit whose tests a Green Check holds immutable |
| `history` | what happened to the worktree, for the next Brief |
| `worktree`, `branch`, `base`, `pr` | the Ticket's worktree, branch, base branch and pull request |
| `approvalRequest` | the open Approval Request's Pending Instance (`await-approval`) |
| `configurationSnapshot` | what the current Visit entered with: its Agent, Procedure, inputs, commands and pinned files |
| `visitState` | the current Visit's progress: its call, Checks, settled Resolution and unconfirmed cleanup |
| `activity` | `{ busy, generation }`: whether an Attempt is touching the worktree, for the Integrity Assertions |
| `heartbeat` | the time an Attempt last reported it was alive |
| `writeAheadLog` | the intent, evidence and completion of every side effect (request 3.5) |

The Epic Record's fields:

```text fields:EpicRecord
schemaVersion
epic
planDecision
approvalRequest
```

## Every path a row may hold

One line per path: `[]` is a list's item, `*` a keyed object's name or an open object's other keys, and `<form>` the
form of a union, named by its type or its tag. A key that may be left out ends in `?`. The type in parentheses declares
the key. A line `JsonValue` is any JSON, whose shape the repository owns.

The Execution Record:

```text paths:ExecutionRecordJson
schemaVersion: number (recordJson.ExecutionRecordJson)
repository: string (recordJson.ExecutionRecordJson)
execution: string (recordJson.ExecutionRecordJson)
ticket: number (recordJson.ExecutionRecordJson)
owner: object (recordJson.ExecutionRecordJson)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
epic: number | null (recordJson.ExecutionRecordJson)
flow: string (recordJson.ExecutionRecordJson)
configHash: string (recordJson.ExecutionRecordJson)
run: string (recordJson.ExecutionRecordJson)
state: string (recordJson.ExecutionRecordJson)
terminalReason: object | null (recordJson.ExecutionRecordJson)
terminalReason.decidedBy: record.DecidedByHold | record.DecidedByHoldInVisit | record.DecidedByLabel | record.DecidedByLabelInVisit | record.DecidedByAction | record.DecidedByHuman (record.TerminalReason)
terminalReason.decidedBy<record.DecidedByHold>.hold: string | null (record.DecidedByHold)
terminalReason.decidedBy<record.DecidedByHoldInVisit>.hold: string | null (record.DecidedByHoldInVisit)
terminalReason.decidedBy<record.DecidedByHoldInVisit>.vertex: string (record.DecidedByHoldInVisit)
terminalReason.decidedBy<record.DecidedByHoldInVisit>.visit: number | null (record.DecidedByHoldInVisit)
terminalReason.decidedBy<record.DecidedByHuman>.human: string (record.DecidedByHuman)
terminalReason.decidedBy<record.DecidedByHoldInVisit>.action: string | null (record.DecidedByHoldInVisit)
terminalReason.decidedBy<record.DecidedByHoldInVisit>.recovery: number (record.DecidedByHoldInVisit)
terminalReason.decidedBy<record.DecidedByLabel>.label: string (record.DecidedByLabel)
terminalReason.decidedBy<record.DecidedByLabelInVisit>.label: string (record.DecidedByLabelInVisit)
terminalReason.decidedBy<record.DecidedByLabelInVisit>.vertex: string (record.DecidedByLabelInVisit)
terminalReason.decidedBy<record.DecidedByLabelInVisit>.visit: number | null (record.DecidedByLabelInVisit)
terminalReason.decidedBy<record.DecidedByLabelInVisit>.action: string | null (record.DecidedByLabelInVisit)
terminalReason.decidedBy<record.DecidedByLabelInVisit>.recovery: number (record.DecidedByLabelInVisit)
terminalReason.decidedBy<record.DecidedByAction>.vertex: string (record.DecidedByAction)
terminalReason.decidedBy<record.DecidedByAction>.visit: number | null (record.DecidedByAction)
terminalReason.decidedBy<record.DecidedByAction>.action: string | null (record.DecidedByAction)
terminalReason.decidedBy<record.DecidedByAction>.recovery: number (record.DecidedByAction)
terminalReason.outcome: string | null (record.TerminalReason)
terminalReason.rule: object | null (record.TerminalReason)
terminalReason.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
terminalReason.rule.row: string | number | null (visit.RuleIdentity)
terminalReason.text: string (record.TerminalReason)
terminalStop: object | null (recordJson.ExecutionRecordJson)
terminalStop.outcome: string (record.TerminalStop)
terminalStop.response: JsonValue (record.TerminalStop)
terminalStop.actionRef: object | null (record.TerminalStop)
terminalStop.actionRef.vertex: string (marker.ActionIdentity)
terminalStop.actionRef.visit: number (marker.ActionIdentity)
terminalStop.actionRef.procedure?: string | null (marker.ActionIdentity)
terminalStop.actionRef.action: string (marker.ActionIdentity)
terminalStop.actionRef.recovery: number (marker.ActionIdentity)
terminalStop.actionRef.attempt?: number (marker.ActionIdentity)
terminalStop.held: boolean (record.TerminalStop)
terminalStop.abandoned: boolean (record.TerminalStop)
terminalStop.inProgress: boolean (record.TerminalStop)
terminalStop.fresh: boolean (record.TerminalStop)
terminalStop.stopped: boolean (record.TerminalStop)
terminalStop.commentTemplate: string | null (record.TerminalStop)
terminalStop.advice: string | null (record.TerminalStop)
terminalStop.detail: string | null (record.TerminalStop)
terminalStop.error: string | null (record.TerminalStop)
terminalStop.failureClass: string | null (record.TerminalStop)
terminalStop.interrupted: object | null (record.TerminalStop)
terminalStop.interrupted.terminal: string
terminalStop.interrupted.terminalReason: object
terminalStop.interrupted.terminalReason.decidedBy: record.DecidedByHold | record.DecidedByHoldInVisit | record.DecidedByLabel | record.DecidedByLabelInVisit | record.DecidedByAction | record.DecidedByHuman (record.TerminalReason)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHold>.hold: string | null (record.DecidedByHold)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.hold: string | null (record.DecidedByHoldInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.vertex: string (record.DecidedByHoldInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.visit: number | null (record.DecidedByHoldInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHuman>.human: string (record.DecidedByHuman)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.action: string | null (record.DecidedByHoldInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.recovery: number (record.DecidedByHoldInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabel>.label: string (record.DecidedByLabel)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.label: string (record.DecidedByLabelInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.vertex: string (record.DecidedByLabelInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.visit: number | null (record.DecidedByLabelInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.action: string | null (record.DecidedByLabelInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.recovery: number (record.DecidedByLabelInVisit)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByAction>.vertex: string (record.DecidedByAction)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByAction>.visit: number | null (record.DecidedByAction)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByAction>.action: string | null (record.DecidedByAction)
terminalStop.interrupted.terminalReason.decidedBy<record.DecidedByAction>.recovery: number (record.DecidedByAction)
terminalStop.interrupted.terminalReason.outcome: string | null (record.TerminalReason)
terminalStop.interrupted.terminalReason.rule: object | null (record.TerminalReason)
terminalStop.interrupted.terminalReason.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
terminalStop.interrupted.terminalReason.rule.row: string | number | null (visit.RuleIdentity)
terminalStop.interrupted.terminalReason.text: string (record.TerminalReason)
admissionStop: object | null (recordJson.ExecutionRecordJson)
admissionStop.kind: "hold" | "abandon" | "fault" (record.AdmissionStop)
admissionStop.name: string | null (record.AdmissionStop)
admissionStop.terminalReasonText: string | null (record.AdmissionStop)
admissionStop.fresh: boolean (record.AdmissionStop)
admissionStop.advice: string | null (record.AdmissionStop)
admissionStop.detail: string | null (record.AdmissionStop)
admissionStop.inProgress: boolean (record.AdmissionStop)
admissionStop.error: string | null (record.AdmissionStop)
cursor: object (recordJson.ExecutionRecordJson)
cursor.vertex: string (record.Cursor)
cursor.visit: number | null (record.Cursor)
cursor.action: string | null (record.Cursor)
cursor.recovery: number (record.Cursor)
cursor.attempt: number (record.Cursor)
retries: keyed (recordJson.ExecutionRecordJson)
retries.*: object
retries.*.crash?: number
retries.*.handoff?: number
retries.*.parse?: number
retries.*.timeout?: number
retries.*.transient?: number
retries.*.rateLimited?: number
retries.*.remote?: object
retries.*.remote.count: number (sideEffect.RemoteRetry)
retries.*.remote.failureClass: FailureClass | null (sideEffect.RemoteRetry)
retries.*.remote.nextEligibleAt: number (sideEffect.RemoteRetry)
retries.*.remote.started: boolean (sideEffect.RemoteRetry)
sessions: keyed (recordJson.ExecutionRecordJson)
sessions.*: object
sessions.*.sessionId: string | null (record.SessionEntry)
sessions.*.harness: string (record.SessionEntry)
sessions.*.personaHash: string (record.SessionEntry)
sessions.*.transcriptPath: string | null (record.SessionEntry)
sessions.*.cumulativeUsage: object (record.SessionEntry)
sessions.*.cumulativeUsage.inputTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.cacheReadTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.cacheWriteTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.outputTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.reasoningTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.costUsd: number | null (events.Usage)
sessions.*.cumulativeUsage.peakContextTokens: number | null (events.Usage)
sessions.*.cumulativeUsage.turns: number | null (events.Usage)
sessions.*.cumulativeUsage.toolCalls: number | null (events.Usage)
sessions.*.cumulativeUsage.compactions: number | null (events.Usage)
sessions.*.cumulativeUsage.costBasis?: "reported" | "priced" | null (events.Usage)
sessions.*.vertex: string (record.SessionEntry)
sessions.*.model: string | null (record.SessionEntry)
sessions.*.effort: string | null (record.SessionEntry)
sessions.*.handedOff?: list (record.SessionEntry)
sessions.*.handedOff[]: object
sessions.*.handedOff[].attempt: number (record.HandedOffSession)
sessions.*.handedOff[].cumulativeUsage: object (record.HandedOffSession)
sessions.*.handedOff[].cumulativeUsage.cacheReadTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.cacheWriteTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.compactions: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.costBasis?: "reported" | "priced" | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.costUsd: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.inputTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.outputTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.peakContextTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.reasoningTokens: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.toolCalls: number | null (events.Usage)
sessions.*.handedOff[].cumulativeUsage.turns: number | null (events.Usage)
sessions.*.handedOff[].sessionId: string | null (record.HandedOffSession)
sessions.*.handedOff[].transcriptPath: string | null (record.HandedOffSession)
sessions.*.personaName: string (record.SessionEntry)
attempts: number (recordJson.ExecutionRecordJson)
outputs: list (recordJson.ExecutionRecordJson)
outputs[]: object
outputs[].vertex: string (visit.ActionOutput)
outputs[].visit: number (visit.ActionOutput)
outputs[].action: string (visit.ActionOutput)
outputs[].value: object (visit.ActionOutput)
outputs[].value.response?: JsonValue (visit.ActionOutputValue)
outputs[].value.cleanup?: object (visit.ActionOutputValue)
outputs[].value.cleanup.confirmed: boolean (commandCleanup.CallCleanup)
outputs[].value.cleanup.survivors: list (commandCleanup.CallCleanup)
outputs[].value.cleanup.survivors[]: object
outputs[].value.cleanup.survivors[].error: string (commandCleanup.Survivor)
outputs[].value.cleanup.survivors[].pid: number (commandCleanup.Survivor)
outputs[].value.cleanup.survivors[].created: string | null (commandCleanup.Survivor)
outputs[].value.cleanup.survivors[].commandLine: string | null (commandCleanup.Survivor)
outputs[].value.cleanup.reason?: string | null (commandCleanup.CallCleanup)
outputs[].value.cleanup.containment?: kind=job | kind=group | kind=none (commandCleanup.CallCleanup)
outputs[].value.cleanup.containment<kind=job>.kind: "job"
outputs[].value.cleanup.containment<kind=group>.kind: "group"
outputs[].value.cleanup.containment<kind=group>.pgid: number
outputs[].value.cleanup.containment<kind=none>.kind: "none"
outputs[].value.evidence?: open object (visit.ActionOutputValue)
outputs[].value.evidence.command: string
outputs[].value.evidence.output: string
outputs[].value.evidence.foundByNameOnly?: boolean
outputs[].value.evidence.*: JsonValue
outputs[].value.findingsHash?: string (visit.ActionOutputValue)
outputs[].value.files?: list (visit.ActionOutputValue)
outputs[].value.files[]: string
outputs[].value.decision?: object (visit.ActionOutputValue)
outputs[].value.decision.outcome: string
outputs[].value.decision.actor?: string
outputs[].value.decision.reply: string | null
outputs[].value.ref?: string (visit.ActionOutputValue)
outputs[].value.diffStat?: object (visit.ActionOutputValue)
outputs[].value.diffStat.files: number (events.DiffStats)
outputs[].value.diffStat.insertions: number (events.DiffStats)
outputs[].value.diffStat.deletions: number (events.DiffStats)
outputs[].value.diffStat.testFiles: number (events.DiffStats)
outputs[].value.diffStat.testInsertions: number (events.DiffStats)
outputs[].value.output?: string (visit.ActionOutputValue)
testCommits: object (recordJson.ExecutionRecordJson)
testCommits.first: string | null
testCommits.baseline: string | null
history: list (recordJson.ExecutionRecordJson)
history[]: object
history[].kind: string (visit.HistoryItem)
history[].text: string (visit.HistoryItem)
worktree: string (recordJson.ExecutionRecordJson)
branch: string (recordJson.ExecutionRecordJson)
base: string (recordJson.ExecutionRecordJson)
pr: number | null (recordJson.ExecutionRecordJson)
approvalRequest: object | null (recordJson.ExecutionRecordJson)
approvalRequest.id: string (approval.PendingInstance)
approvalRequest.execution: string (approval.PendingInstance)
approvalRequest.vertex: string (approval.PendingInstance)
approvalRequest.visit: number (approval.PendingInstance)
approvalRequest.nonce: string (approval.PendingInstance)
approvalRequest.digest: string (approval.PendingInstance)
configurationSnapshot: object | null (recordJson.ExecutionRecordJson)
configurationSnapshot.vertex: string (visit.ConfigurationSnapshot)
configurationSnapshot.visit: number (visit.ConfigurationSnapshot)
configurationSnapshot.configHash: string (visit.ConfigurationSnapshot)
configurationSnapshot.agent: open object | null (visit.ConfigurationSnapshot)
configurationSnapshot.agent.harness: string (model.Agent)
configurationSnapshot.agent.persona: string (model.Agent)
configurationSnapshot.agent.model: string | null (model.Agent)
configurationSnapshot.agent.effort: string | null (model.Agent)
configurationSnapshot.agent.network?: boolean (model.Agent)
configurationSnapshot.agent.*: JsonValue (model.Agent)
configurationSnapshot.access: string (visit.ConfigurationSnapshot)
configurationSnapshot.procedure: object (visit.ConfigurationSnapshot)
configurationSnapshot.procedure.name: string
configurationSnapshot.procedure.hash: string
configurationSnapshot.outcomes: JsonValue (visit.ConfigurationSnapshot)
configurationSnapshot.route: JsonValue (visit.ConfigurationSnapshot)
configurationSnapshot.routes: JsonValue (visit.ConfigurationSnapshot)
configurationSnapshot.inputs: keyed (visit.ConfigurationSnapshot)
configurationSnapshot.inputs.*: object
configurationSnapshot.inputs.*.value: JsonValue (visit.VertexInput)
configurationSnapshot.inputs.*.vertex: string | null (visit.VertexInput)
configurationSnapshot.inputs.*.visit: number | null (visit.VertexInput)
configurationSnapshot.inputs.*.action: string | null (visit.VertexInput)
configurationSnapshot.inputs.*.absent: boolean (visit.VertexInput)
configurationSnapshot.commands: keyed (visit.ConfigurationSnapshot)
configurationSnapshot.commands.*: JsonValue
configurationSnapshot.testPaths: list (visit.ConfigurationSnapshot)
configurationSnapshot.testPaths[]: string
configurationSnapshot.persona: object | null (visit.ConfigurationSnapshot)
configurationSnapshot.persona.name: string
configurationSnapshot.persona.bytes: string
configurationSnapshot.persona.hash: string
configurationSnapshot.files: keyed (visit.ConfigurationSnapshot)
configurationSnapshot.files.*: object (config.SourceFiles)
configurationSnapshot.files.*.bytes: string
configurationSnapshot.files.*.hash: string
activity: object (recordJson.ExecutionRecordJson)
activity.busy: boolean
activity.generation: number
heartbeat: string | null (recordJson.ExecutionRecordJson)
writeAheadLog: list (recordJson.ExecutionRecordJson)
writeAheadLog[]: object
writeAheadLog[].step: "intent" | "evidence" | "complete" (writeAhead.WriteAheadEntry)
writeAheadLog[].actionMarker: string (writeAhead.WriteAheadEntry)
writeAheadLog[].effect: string | null (writeAhead.WriteAheadEntry)
writeAheadLog[].payload: commit.Payload | push.Payload | comment.Payload | prUpsert.Payload | prReady.Payload | label.Payload | close.Payload | rescue.Payload | reset.Payload | approvalAction.Consumption | writeAhead.CallPayload | null (writeAhead.WriteAheadEntry)
writeAheadLog[].payload<commit.Payload>.message: string (commit.Payload)
writeAheadLog[].payload<commit.Payload>.tree: string (commit.Payload)
writeAheadLog[].payload<commit.Payload>.parent: string (commit.Payload)
writeAheadLog[].payload<push.Payload>.branch: string (push.Payload)
writeAheadLog[].payload<push.Payload>.sha: string (push.Payload)
writeAheadLog[].payload<comment.Payload>.target: object (comment.Payload)
writeAheadLog[].payload<comment.Payload>.target.kind: string
writeAheadLog[].payload<comment.Payload>.target.number: number
writeAheadLog[].payload<comment.Payload>.body: string (comment.Payload)
writeAheadLog[].payload<comment.Payload>.bodyHash: string (comment.Payload)
writeAheadLog[].payload<prUpsert.Payload>.branch: string (prUpsert.Payload)
writeAheadLog[].payload<prUpsert.Payload>.base?: string (prUpsert.Payload)
writeAheadLog[].payload<prUpsert.Payload>.title: string (prUpsert.Payload)
writeAheadLog[].payload<prUpsert.Payload>.body: string (prUpsert.Payload)
writeAheadLog[].payload<prUpsert.Payload>.bodyHash: string (prUpsert.Payload)
writeAheadLog[].payload<prReady.Payload>.number: number (prReady.Payload)
writeAheadLog[].payload<prReady.Payload>.sha: string | null (prReady.Payload)
writeAheadLog[].payload<prReady.Payload>.tree: string | null (prReady.Payload)
writeAheadLog[].payload<label.Payload>.ticket: number (label.Payload)
writeAheadLog[].payload<label.Payload>.add: list (label.Payload)
writeAheadLog[].payload<label.Payload>.add[]: string
writeAheadLog[].payload<label.Payload>.remove: list (label.Payload)
writeAheadLog[].payload<label.Payload>.remove[]: string
writeAheadLog[].payload<close.Payload>.issue: number (close.Payload)
writeAheadLog[].payload<rescue.Payload>.ref: string (rescue.Payload)
writeAheadLog[].payload<rescue.Payload>.commit: string (rescue.Payload)
writeAheadLog[].payload<rescue.Payload>.tree: string (rescue.Payload)
writeAheadLog[].payload<rescue.Payload>.parent: string (rescue.Payload)
writeAheadLog[].payload<rescue.Payload>.left: object (rescue.Payload)
writeAheadLog[].payload<rescue.Payload>.left.head: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<rescue.Payload>.left.index: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<rescue.Payload>.left.tree: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<reset.Payload>.baseline: string (reset.Payload)
writeAheadLog[].payload<reset.Payload>.history: object (reset.Payload)
writeAheadLog[].payload<reset.Payload>.history.kind: string (visit.HistoryItem)
writeAheadLog[].payload<reset.Payload>.history.text: string (visit.HistoryItem)
writeAheadLog[].payload<reset.Payload>.untracked?: object (reset.Payload)
writeAheadLog[].payload<reset.Payload>.untracked.files: keyed (integrity.RollbackSet)
writeAheadLog[].payload<reset.Payload>.untracked.files.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
writeAheadLog[].payload<reset.Payload>.untracked.files.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
writeAheadLog[].payload<reset.Payload>.untracked.files.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
writeAheadLog[].payload<reset.Payload>.untracked.files.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
writeAheadLog[].payload<reset.Payload>.untracked.within?: object (integrity.RollbackSet)
writeAheadLog[].payload<reset.Payload>.untracked.within.paths?: list (integrity.WithinPaths)
writeAheadLog[].payload<reset.Payload>.untracked.within.paths[]: string
writeAheadLog[].payload<reset.Payload>.untracked.within.globs?: list (integrity.WithinPaths)
writeAheadLog[].payload<reset.Payload>.untracked.within.globs[]: string
writeAheadLog[].payload<reset.Payload>.untracked.within.exclude?: list (integrity.WithinPaths)
writeAheadLog[].payload<reset.Payload>.untracked.within.exclude[]: string
writeAheadLog[].payload<reset.Payload>.left?: object (reset.Payload)
writeAheadLog[].payload<reset.Payload>.left.head: string
writeAheadLog[].payload<reset.Payload>.left.index: string
writeAheadLog[].payload<reset.Payload>.left.tree: string
writeAheadLog[].payload<reset.Payload>.left.files?: keyed
writeAheadLog[].payload<reset.Payload>.left.files.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
writeAheadLog[].payload<reset.Payload>.left.files.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
writeAheadLog[].payload<reset.Payload>.left.files.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
writeAheadLog[].payload<reset.Payload>.left.files.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
writeAheadLog[].payload<approvalAction.Consumption>.decision: object (approvalAction.Consumption)
writeAheadLog[].payload<approvalAction.Consumption>.decision.instance: string
writeAheadLog[].payload<approvalAction.Consumption>.decision.event: number
writeAheadLog[].payload<approvalAction.Consumption>.decision.actor?: string
writeAheadLog[].payload<approvalAction.Consumption>.decision.time: string
writeAheadLog[].payload<approvalAction.Consumption>.decision.outcome: string
writeAheadLog[].payload<approvalAction.Consumption>.decision.next: string
writeAheadLog[].payload<approvalAction.Consumption>.decision.reply: string | null
writeAheadLog[].payload<approvalAction.Consumption>.ticket: number (approvalAction.Consumption)
writeAheadLog[].payload<approvalAction.Consumption>.add: list (approvalAction.Consumption)
writeAheadLog[].payload<approvalAction.Consumption>.add[]: string
writeAheadLog[].payload<approvalAction.Consumption>.remove: list (approvalAction.Consumption)
writeAheadLog[].payload<approvalAction.Consumption>.remove[]: string
writeAheadLog[].payload<writeAhead.CallPayload>.baseline: object (writeAhead.CallPayload)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.head: string (integrity.IntegrityBaseline)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.own: object (integrity.IntegrityBaseline)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.own.head: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.own.index: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.own.tree: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle: keyed (integrity.IntegrityBaseline)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*: object
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*.generation: number (integrity.IdleSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*.snapshot: object (integrity.IdleSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*.snapshot.head: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*.snapshot.index: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.idle.*.snapshot.tree: string (integrity.WorktreeSnapshot)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.untracked: keyed (integrity.IntegrityBaseline)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.untracked.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.untracked.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.untracked.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.untracked.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.tests: keyed (integrity.IntegrityBaseline)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.tests.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.tests.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.tests.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
writeAheadLog[].payload<writeAhead.CallPayload>.baseline.tests.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
writeAheadLog[].payload<writeAhead.CallPayload>.containment?: object (writeAhead.CallPayload)
writeAheadLog[].payload<writeAhead.CallPayload>.containment.kind: string (writeAhead.CallContainment)
writeAheadLog[].evidence: commit.Evidence | push.Evidence | comment.Evidence | prUpsert.Evidence | prReady.Evidence | label.Evidence | close.Evidence | rescue.Evidence | reset.Evidence | visit.TableResolution | visit.EffectResolution | visit.ActionCapResolution | visit.RunStoppedResolution | visit.DecisionResolution | null (writeAhead.WriteAheadEntry)
writeAheadLog[].evidence<commit.Evidence>.sha: string | null
writeAheadLog[].evidence<push.Evidence>.remoteSha: string
writeAheadLog[].evidence<comment.Evidence>.id: number
writeAheadLog[].evidence<prUpsert.Evidence>.number: number
writeAheadLog[].evidence<prUpsert.Evidence>.url: string
writeAheadLog[].evidence<label.Evidence>.ok: boolean
writeAheadLog[].evidence<rescue.Evidence>.ref: string
writeAheadLog[].evidence<rescue.Evidence>.commit: string
writeAheadLog[].evidence<reset.Evidence>.head: string
writeAheadLog[].evidence<visit.TableResolution>.row: FixedRow | null
writeAheadLog[].evidence<visit.TableResolution>.check: string | null
writeAheadLog[].evidence<visit.TableResolution>.retryAfterMs: number | null
writeAheadLog[].evidence<visit.TableResolution>.retryKind: "parse" | "timeout" | "transient" | "rateLimited" | "handoff" | null
writeAheadLog[].evidence<visit.TableResolution>.failureClass: string | null
writeAheadLog[].evidence<visit.TableResolution>.sessionId?: string | null
writeAheadLog[].evidence<visit.TableResolution>.reason?: string | null
writeAheadLog[].evidence<visit.TableResolution>.surfaces?: list | null
writeAheadLog[].evidence<visit.TableResolution>.surfaces[]: string
writeAheadLog[].evidence<visit.TableResolution>.attempt?: number
writeAheadLog[].evidence<visit.TableResolution>.signal?: object
writeAheadLog[].evidence<visit.TableResolution>.signal.id: string (visit.CheckSignal)
writeAheadLog[].evidence<visit.TableResolution>.signal.kind: string (visit.CheckSignal)
writeAheadLog[].evidence<visit.TableResolution>.signal.state: "passed" | "failed" (visit.CheckSignal)
writeAheadLog[].evidence<visit.TableResolution>.signal.tree: string | null (visit.CheckSignal)
writeAheadLog[].evidence<visit.TableResolution>.output?: string | null
writeAheadLog[].evidence<visit.TableResolution>.outcome: string
writeAheadLog[].evidence<visit.TableResolution>.direction: Direction
writeAheadLog[].evidence<visit.TableResolution>.rule: object
writeAheadLog[].evidence<visit.TableResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
writeAheadLog[].evidence<visit.TableResolution>.rule.row: string | number | null (visit.RuleIdentity)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta: object
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.inputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.cacheReadTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.cacheWriteTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.outputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.reasoningTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.costUsd: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.peakContextTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.turns: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.toolCalls: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.compactions: number | null (events.Usage)
writeAheadLog[].evidence<visit.TableResolution>.usageDelta.costBasis?: "reported" | "priced" | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.row: "effect-completed"
writeAheadLog[].evidence<visit.EffectResolution>.outcome: string
writeAheadLog[].evidence<visit.EffectResolution>.direction: Direction
writeAheadLog[].evidence<visit.EffectResolution>.rule: object
writeAheadLog[].evidence<visit.EffectResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
writeAheadLog[].evidence<visit.EffectResolution>.rule.row: string | number | null (visit.RuleIdentity)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta: object
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.inputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.cacheReadTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.cacheWriteTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.outputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.reasoningTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.costUsd: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.peakContextTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.turns: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.toolCalls: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.compactions: number | null (events.Usage)
writeAheadLog[].evidence<visit.EffectResolution>.usageDelta.costBasis?: "reported" | "priced" | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.row: "action-cap"
writeAheadLog[].evidence<visit.ActionCapResolution>.actionCap: number
writeAheadLog[].evidence<visit.ActionCapResolution>.outcome: string
writeAheadLog[].evidence<visit.ActionCapResolution>.direction: Direction
writeAheadLog[].evidence<visit.ActionCapResolution>.rule: object
writeAheadLog[].evidence<visit.ActionCapResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
writeAheadLog[].evidence<visit.ActionCapResolution>.rule.row: string | number | null (visit.RuleIdentity)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta: object
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.inputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.cacheReadTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.cacheWriteTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.outputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.reasoningTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.costUsd: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.peakContextTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.turns: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.toolCalls: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.compactions: number | null (events.Usage)
writeAheadLog[].evidence<visit.ActionCapResolution>.usageDelta.costBasis?: "reported" | "priced" | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.row: "run-stopped"
writeAheadLog[].evidence<visit.RunStoppedResolution>.failureClass: string
writeAheadLog[].evidence<visit.RunStoppedResolution>.runStopTicket: number
writeAheadLog[].evidence<visit.RunStoppedResolution>.source: string | null
writeAheadLog[].evidence<visit.RunStoppedResolution>.outcome: string
writeAheadLog[].evidence<visit.RunStoppedResolution>.direction: Direction
writeAheadLog[].evidence<visit.RunStoppedResolution>.rule: object
writeAheadLog[].evidence<visit.RunStoppedResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
writeAheadLog[].evidence<visit.RunStoppedResolution>.rule.row: string | number | null (visit.RuleIdentity)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta: object
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.inputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.cacheReadTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.cacheWriteTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.outputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.reasoningTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.costUsd: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.peakContextTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.turns: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.toolCalls: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.compactions: number | null (events.Usage)
writeAheadLog[].evidence<visit.RunStoppedResolution>.usageDelta.costBasis?: "reported" | "priced" | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.row: "decision"
writeAheadLog[].evidence<visit.DecisionResolution>.outcome: string
writeAheadLog[].evidence<visit.DecisionResolution>.direction: Direction
writeAheadLog[].evidence<visit.DecisionResolution>.rule: object
writeAheadLog[].evidence<visit.DecisionResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
writeAheadLog[].evidence<visit.DecisionResolution>.rule.row: string | number | null (visit.RuleIdentity)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta: object
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.inputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.cacheReadTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.cacheWriteTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.outputTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.reasoningTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.costUsd: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.peakContextTokens: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.turns: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.toolCalls: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.compactions: number | null (events.Usage)
writeAheadLog[].evidence<visit.DecisionResolution>.usageDelta.costBasis?: "reported" | "priced" | null (events.Usage)
writeAheadLog[].time: string (writeAhead.WriteAheadEntry)
visits: keyed (recordJson.ExecutionRecordJson)
visits.*: number
traversals: keyed (recordJson.ExecutionRecordJson)
traversals.*: number
visitState: object | null (recordJson.ExecutionRecordJson)
visitState.recovery: number (recordJson.VisitStateJson)
visitState.firstAttemptBaseline: object | null (recordJson.VisitStateJson)
visitState.firstAttemptBaseline.head: string (integrity.IntegrityBaseline)
visitState.firstAttemptBaseline.own: object (integrity.IntegrityBaseline)
visitState.firstAttemptBaseline.own.head: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.own.index: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.own.tree: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.idle: keyed (integrity.IntegrityBaseline)
visitState.firstAttemptBaseline.idle.*: object
visitState.firstAttemptBaseline.idle.*.generation: number (integrity.IdleSnapshot)
visitState.firstAttemptBaseline.idle.*.snapshot: object (integrity.IdleSnapshot)
visitState.firstAttemptBaseline.idle.*.snapshot.head: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.idle.*.snapshot.index: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.idle.*.snapshot.tree: string (integrity.WorktreeSnapshot)
visitState.firstAttemptBaseline.untracked: keyed (integrity.IntegrityBaseline)
visitState.firstAttemptBaseline.untracked.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
visitState.firstAttemptBaseline.untracked.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
visitState.firstAttemptBaseline.untracked.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
visitState.firstAttemptBaseline.untracked.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
visitState.firstAttemptBaseline.tests: keyed (integrity.IntegrityBaseline)
visitState.firstAttemptBaseline.tests.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
visitState.firstAttemptBaseline.tests.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
visitState.firstAttemptBaseline.tests.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
visitState.firstAttemptBaseline.tests.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
visitState.call: object | null (recordJson.VisitStateJson)
visitState.call.harnessResult: object (visit.AgentCall)
visitState.call.harnessResult.status: "failed" | "completed" | "timed-out" | "killed" (runContext.HarnessResult)
visitState.call.harnessResult.sessionId: string | null (runContext.HarnessResult)
visitState.call.harnessResult.transcriptPath: string | null (runContext.HarnessResult)
visitState.call.harnessResult.usage: object (runContext.HarnessResult)
visitState.call.harnessResult.usage.cumulative: object
visitState.call.harnessResult.usage.cumulative.inputTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.cacheReadTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.cacheWriteTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.outputTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.reasoningTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.costUsd: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.peakContextTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.turns: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.toolCalls: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.compactions: number | null (events.Usage)
visitState.call.harnessResult.usage.cumulative.costBasis?: "reported" | "priced" | null (events.Usage)
visitState.call.harnessResult.usage.delta: object
visitState.call.harnessResult.usage.delta.inputTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.cacheReadTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.cacheWriteTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.outputTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.reasoningTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.costUsd: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.peakContextTokens: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.turns: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.toolCalls: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.compactions: number | null (events.Usage)
visitState.call.harnessResult.usage.delta.costBasis?: "reported" | "priced" | null (events.Usage)
visitState.call.harnessResult.exitCode?: number | null (runContext.HarnessResult)
visitState.call.harnessResult.exitSignal?: string | null (runContext.HarnessResult)
visitState.call.harnessResult.finalEventSubtype?: string | null (runContext.HarnessResult)
visitState.call.harnessResult.sessionInit?: JsonValue (runContext.HarnessResult)
visitState.call.harnessResult.permissionDenials?: JsonValue (runContext.HarnessResult)
visitState.call.harnessResult.commandsRun?: JsonValue (runContext.HarnessResult)
visitState.call.harnessResult.cleanup?: object (runContext.HarnessResult)
visitState.call.harnessResult.cleanup.confirmed: boolean (commandCleanup.CallCleanup)
visitState.call.harnessResult.cleanup.survivors: list (commandCleanup.CallCleanup)
visitState.call.harnessResult.cleanup.survivors[]: object
visitState.call.harnessResult.cleanup.survivors[].error: string (commandCleanup.Survivor)
visitState.call.harnessResult.cleanup.survivors[].pid: number (commandCleanup.Survivor)
visitState.call.harnessResult.cleanup.survivors[].created: string | null (commandCleanup.Survivor)
visitState.call.harnessResult.cleanup.survivors[].commandLine: string | null (commandCleanup.Survivor)
visitState.call.harnessResult.cleanup.reason?: string | null (commandCleanup.CallCleanup)
visitState.call.harnessResult.cleanup.containment?: kind=job | kind=group | kind=none (commandCleanup.CallCleanup)
visitState.call.harnessResult.cleanup.containment<kind=job>.kind: "job"
visitState.call.harnessResult.cleanup.containment<kind=group>.kind: "group"
visitState.call.harnessResult.cleanup.containment<kind=group>.pgid: number
visitState.call.harnessResult.cleanup.containment<kind=none>.kind: "none"
visitState.call.harnessResult.repositoryDigest?: string | null (runContext.HarnessResult)
visitState.call.harnessResult.agentCliVersion?: string | null (runContext.HarnessResult)
visitState.call.harnessResult.effectiveModel?: string | null (runContext.HarnessResult)
visitState.call.harnessResult.effectiveEffort?: string | null (runContext.HarnessResult)
visitState.call.claim: object (visit.AgentCall)
visitState.call.claim.valid: boolean (visit.ClaimSignal)
visitState.call.claim.token: string | null (visit.ClaimSignal)
visitState.call.claim.reason: string | null (visit.ClaimSignal)
visitState.call.response: JsonValue (visit.AgentCall)
visitState.call.baseline: object (visit.AgentCall)
visitState.call.baseline.head: string (integrity.IntegrityBaseline)
visitState.call.baseline.own: object (integrity.IntegrityBaseline)
visitState.call.baseline.own.head: string (integrity.WorktreeSnapshot)
visitState.call.baseline.own.index: string (integrity.WorktreeSnapshot)
visitState.call.baseline.own.tree: string (integrity.WorktreeSnapshot)
visitState.call.baseline.idle: keyed (integrity.IntegrityBaseline)
visitState.call.baseline.idle.*: object
visitState.call.baseline.idle.*.generation: number (integrity.IdleSnapshot)
visitState.call.baseline.idle.*.snapshot: object (integrity.IdleSnapshot)
visitState.call.baseline.idle.*.snapshot.head: string (integrity.WorktreeSnapshot)
visitState.call.baseline.idle.*.snapshot.index: string (integrity.WorktreeSnapshot)
visitState.call.baseline.idle.*.snapshot.tree: string (integrity.WorktreeSnapshot)
visitState.call.baseline.untracked: keyed (integrity.IntegrityBaseline)
visitState.call.baseline.untracked.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
visitState.call.baseline.untracked.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
visitState.call.baseline.untracked.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
visitState.call.baseline.untracked.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
visitState.call.baseline.tests: keyed (integrity.IntegrityBaseline)
visitState.call.baseline.tests.*: integrity.UntrackedLink | integrity.UntrackedBytes (integrity.UntrackedFiles)
visitState.call.baseline.tests.*<integrity.UntrackedLink>.link: string (integrity.UntrackedLink)
visitState.call.baseline.tests.*<integrity.UntrackedLink>.directory: boolean (integrity.UntrackedLink)
visitState.call.baseline.tests.*<integrity.UntrackedBytes>.base64: string (integrity.UntrackedBytes)
visitState.call.signal: object (visit.AgentCall)
visitState.call.signal.status: "failed" | "completed" | "timed-out" | "killed" (visit.CallSignal)
visitState.call.signal.response: JsonValue (visit.CallSignal)
visitState.call.signal.failure: object | null (visit.CallSignal)
visitState.call.signal.failure.failureClass: string (visit.HarnessFailure)
visitState.call.signal.failure.retryAfterMs?: number | null (visit.HarnessFailure)
visitState.call.signal.failure.message?: string (visit.HarnessFailure)
visitState.response: JsonValue (recordJson.VisitStateJson)
visitState.checkFollows: boolean (recordJson.VisitStateJson)
visitState.settled: object | null (recordJson.VisitStateJson)
visitState.settled.action: string
visitState.settled.recovery: number
visitState.settled.resolution: visit.TableResolution | visit.EffectResolution | visit.ActionCapResolution | visit.RunStoppedResolution | visit.DecisionResolution
visitState.settled.resolution<visit.TableResolution>.row: FixedRow | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.check: string | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.retryAfterMs: number | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.retryKind: "parse" | "timeout" | "transient" | "rateLimited" | "handoff" | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.failureClass: string | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.sessionId?: string | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.reason?: string | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.surfaces?: list | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.surfaces[]: string
visitState.settled.resolution<visit.TableResolution>.attempt?: number (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.signal?: object (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.signal.id: string (visit.CheckSignal)
visitState.settled.resolution<visit.TableResolution>.signal.kind: string (visit.CheckSignal)
visitState.settled.resolution<visit.TableResolution>.signal.state: "passed" | "failed" (visit.CheckSignal)
visitState.settled.resolution<visit.TableResolution>.signal.tree: string | null (visit.CheckSignal)
visitState.settled.resolution<visit.TableResolution>.output?: string | null (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.outcome: string (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.direction: Direction (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.rule: object (visit.TableResolution)
visitState.settled.resolution<visit.TableResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
visitState.settled.resolution<visit.TableResolution>.rule.row: string | number | null (visit.RuleIdentity)
visitState.settled.resolution<visit.EffectResolution>.row: "effect-completed" (visit.EffectResolution)
visitState.settled.resolution<visit.EffectResolution>.outcome: string (visit.EffectResolution)
visitState.settled.resolution<visit.EffectResolution>.direction: Direction (visit.EffectResolution)
visitState.settled.resolution<visit.EffectResolution>.rule: object (visit.EffectResolution)
visitState.settled.resolution<visit.EffectResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
visitState.settled.resolution<visit.EffectResolution>.rule.row: string | number | null (visit.RuleIdentity)
visitState.settled.resolution<visit.ActionCapResolution>.row: "action-cap" (visit.ActionCapResolution)
visitState.settled.resolution<visit.ActionCapResolution>.actionCap: number (visit.ActionCapResolution)
visitState.settled.resolution<visit.ActionCapResolution>.outcome: string (visit.ActionCapResolution)
visitState.settled.resolution<visit.ActionCapResolution>.direction: Direction (visit.ActionCapResolution)
visitState.settled.resolution<visit.ActionCapResolution>.rule: object (visit.ActionCapResolution)
visitState.settled.resolution<visit.ActionCapResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
visitState.settled.resolution<visit.ActionCapResolution>.rule.row: string | number | null (visit.RuleIdentity)
visitState.settled.resolution<visit.RunStoppedResolution>.row: "run-stopped" (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.failureClass: string (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.runStopTicket: number (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.source: string | null (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.outcome: string (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.direction: Direction (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.rule: object (visit.RunStoppedResolution)
visitState.settled.resolution<visit.RunStoppedResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
visitState.settled.resolution<visit.RunStoppedResolution>.rule.row: string | number | null (visit.RuleIdentity)
visitState.settled.resolution<visit.DecisionResolution>.row: "decision" (visit.DecisionResolution)
visitState.settled.resolution<visit.DecisionResolution>.outcome: string (visit.DecisionResolution)
visitState.settled.resolution<visit.DecisionResolution>.direction: Direction (visit.DecisionResolution)
visitState.settled.resolution<visit.DecisionResolution>.rule: object (visit.DecisionResolution)
visitState.settled.resolution<visit.DecisionResolution>.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
visitState.settled.resolution<visit.DecisionResolution>.rule.row: string | number | null (visit.RuleIdentity)
visitState.runs: keyed (recordJson.VisitStateJson)
visitState.runs.*: object
visitState.runs.*.output: string | null (visit.CheckRun)
visitState.runs.*.reason: string | null (visit.CheckRun)
visitState.runs.*.failure: string | null (visit.CheckRun)
visitState.runs.*.recoverable: boolean (visit.CheckRun)
visitState.checks: keyed (recordJson.VisitStateJson)
visitState.checks.*: object
visitState.checks.*.id: string (visit.CheckSignal)
visitState.checks.*.kind: string (visit.CheckSignal)
visitState.checks.*.state: "passed" | "failed" (visit.CheckSignal)
visitState.checks.*.tree: string | null (visit.CheckSignal)
visitState.unconfirmedCleanup: object | null (recordJson.VisitStateJson)
visitState.unconfirmedCleanup.confirmed: boolean (commandCleanup.SavedCleanup)
visitState.unconfirmedCleanup.survivors: list (commandCleanup.SavedCleanup)
visitState.unconfirmedCleanup.survivors[]: object
visitState.unconfirmedCleanup.survivors[].error: string (commandCleanup.Survivor)
visitState.unconfirmedCleanup.survivors[].pid: number (commandCleanup.Survivor)
visitState.unconfirmedCleanup.survivors[].created: string | null (commandCleanup.Survivor)
visitState.unconfirmedCleanup.survivors[].commandLine: string | null (commandCleanup.Survivor)
visitState.unconfirmedCleanup.reason: string | null (commandCleanup.SavedCleanup)
visitState.unconfirmedCleanup.containment: kind=job | kind=group | kind=none (commandCleanup.SavedCleanup)
visitState.unconfirmedCleanup.containment<kind=job>.kind: "job"
visitState.unconfirmedCleanup.containment<kind=group>.kind: "group"
visitState.unconfirmedCleanup.containment<kind=group>.pgid: number
visitState.unconfirmedCleanup.containment<kind=none>.kind: "none"
```

The Epic Record:

```text paths:EpicRecordJson
schemaVersion: number (recordJson.EpicRecordJson)
epic: number (recordJson.EpicRecordJson)
approvalRequest: object | null (recordJson.EpicRecordJson)
approvalRequest.id: string (approval.PendingInstance)
approvalRequest.execution: string (approval.PendingInstance)
approvalRequest.vertex: string (approval.PendingInstance)
approvalRequest.visit: number (approval.PendingInstance)
approvalRequest.nonce: string (approval.PendingInstance)
approvalRequest.digest: string (approval.PendingInstance)
planDecision: JsonValue (recordJson.EpicRecordJson)
```

## The Terminal Reason

`terminalReason.decidedBy` is exactly one form:

- `{ hold }`: a hold by its name (`null` for an unnamed one); with the Action keys `vertex, visit, action, recovery`
  when it cut a Visit off (#341).
- `{ label }`: an abandonment, by the State Label a human set (`gg:state:needs-human`); with the Action keys when it cut
  a Visit off.
- `{ vertex, visit, action, recovery }`: an Action, or a fault at the cursor. `visit` and `action` are null for a stop
  decided before any Action.
- `{ human }`: a person's end with `gg work done`, by their gh login (#133). Its State Label is `gg:state:done`, and
  its comment, label and close Actions are `resolve-comment`, `resolve-label` and `resolve-close`, their payloads those of
  the comment, label and close Effects.

`rule` is the rule identity `{ table, row }` exactly when a table row or one of gg's fixed rows (table `fixed`) decided
the Outcome; for a hold, an abandonment or a fault it is null, and so is `outcome`. `ticket_end` carries the same
Terminal Reason (`events.md`).

## The write-ahead log

Every side effect is saved before it is made (ADR 0005): an `intent` entry with its `payload`, then `evidence` once
the effect is seen, then `complete`. `effect` names the Effect (`lib/effects/`); `writeAheadLog[].payload` has one form
per Effect, listed above: `commit`, `push`, `comment`, `pr-upsert`, `pr-ready`, `label` (and a consumed Decision's,
`approvalAction.Consumption`), `rescue`, `reset`, and an agent call's baseline (`writeAhead.CallPayload`).
`writeAheadLog[].evidence` likewise has one form per Effect (`commit.Evidence` and its siblings), told apart by their
keys, and an agent call's completion: its Resolution, one form per Resolution, with the Usage the call spent
(`usageDelta`).

- An open intent whose `effect` names no Effect gg can find or safely repeat holds the Ticket at Reconciliation; it is
  never read as absent (S6, #118).
- `rescue` (#118, ADR 0011) saves the Rescue Ref of an Interrupted Attempt or a failure routed elsewhere: its payload
  is `{ ref, commit, tree, parent, left }`, and its Action output `{ ref, diffStat, output }`.
- `await-approval` saves the Approval Request's Pending Instance in `approvalRequest`, and consumes a Decision through a
  `label` intent carrying `decision: { instance, event, actor?, time, outcome, next, reply }`; its Action output is
  `decision: { outcome, actor?, reply }` (#119, #333).

## Cleanup and containment

A call's or command's Command Cleanup (L6, L11, L14) reports `{ confirmed, survivors, reason, containment }`. The
containment is `{ kind: 'job' }` (a Windows job object), `{ kind: 'group', pgid }` (a POSIX process group) or
`{ kind: 'none' }`. An unconfirmed cleanup is a Pending cleanup hold (#119, J4): the Ticket gets `gg:await:cleanup`, the
report waits in `visitState.unconfirmedCleanup` with the suspended Action's recorded result, and a later Run confirms
cleanup under the recorded containment before it continues. On Windows the record keeps only the kind `job`: gg holds
the job's only handle (`lib/containment.ts`, #245), and the job's kill-on-close ends every process in it when that gg
process ends or closes the handle as it ends the Ticket, which is what makes "the writers are confirmed gone" true on
Windows.

## What the integrity snapshot sees

The `tree` surface is a fingerprint taken with `git add -A` into a temporary index, so it does not see writes into
git-ignored untracked paths outside the Protected Files and the test paths; ignored Protected Files and tests are
still read by explicit pathspec (ADR 0007, QA of PR #35). A rollback snapshot keeps a link as a link: an untracked
symlink or junction is saved as `{ link, directory }`, never the files behind it, and a directory link is made again as
a junction.

## Failure Classes

The set is closed: a new class needs a new ADR and a version bump. Saved in `retries.*.remote.failureClass`,
`terminalStop.failureClass`, a call's `signal.failure.failureClass` and a Resolution's `failureClass`.

```text list:FailureClass
transient
rate-limited
auth
quota
budget
permission
rejected
invalid
unknown
```

| Source | Classes it reports |
| --- | --- |
| a Harness (`harness.md`) | `auth`, `quota`, `budget`, `rate-limited`, `transient`, `unknown` |
| a remote Effect (`classifyRemoteFailure`, `lib/outcome.ts`) | `rejected`, `rate-limited`, `auth`, `permission`, `transient`, `invalid`, `unknown` |
| a run stop (`run-stopped`) | the classes whose reach is the whole Run: `auth`, `quota`, `budget` |

## The State Database

`<git common dir>/gg/gg.db`, a SQLite file that only `gg init` creates (ADR 0009, ADR 0023). Its tables, columns and
indexes, as SQLite stores them, and its `user_version`, which is `stateDatabase.SCHEMA_VERSION`:

```text sql:StateDatabase
table check_results: CREATE TABLE check_results (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, tree TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, marker TEXT NOT NULL, output TEXT NOT NULL)
table configs: CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL)
table events: CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT, ticket INTEGER, json TEXT NOT NULL)
table records: CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n))
index check_results_key: CREATE INDEX check_results_key ON check_results (tree, command)
index events_execution: CREATE INDEX events_execution ON events (execution)
index events_run: CREATE INDEX events_run ON events (run)
index events_ticket: CREATE INDEX events_ticket ON events (ticket)
index events_ts: CREATE INDEX events_ts ON events (ts)
user_version: 1
```

- `records`: one row per record, keyed by `kind` (`ticket` or `epic`) and number; `json` holds the record above.
- `events`: one row per Event, its `json` the Event schema of `events.md`. The `ts` column keeps its name, while the
  Event's own field is `time` (#197, PR #227); `run`, `execution` and `ticket` are copied out for the indexes.
- `configs`: each Pinned Configuration by its Config Hash, first seen at `firstSeen`.
- `check_results`: Check results a later Check may reuse, by tree and command (L8, L13); `ts` as in `events`.

## Reserved

Shapes later tickets land without a version bump. Each sits inside an existing field, never as a new top-level field,
because `record.save` refuses a row missing a declared field; the landing ticket moves it into the declarations and
treats it as optional when absent.

- **#128, a cgroup's identity (N1).** A call's containment (`writeAheadLog[].payload.containment`, landed by #68) gains
  the kind `cgroup` and, beside `kind`, an optional `identity`, the cgroup path a later Run confirms empty.
- **#89, a merge Action (option 3).** The end `merged` with the State Label `gg:state:merged`.
- **Option 3, user Actions as executables (Q8, S6).** A write-ahead intent's `effect` stays an open string; a `confirm`
  evidence is a new form of `writeAheadLog[].evidence`; an Action may carry `onInterrupt`, saved in its Procedure inside
  `configurationSnapshot`. Worked examples:
  - A custom effect's intent: `{ "step": "intent", "actionMarker": "gg:…:deploy:0:r1:1", "effect": "deploy",
    "payload": null, "evidence": null, "time": "…" }`. Until the executable that names `deploy` is declared,
    Reconciliation holds the Ticket on it (S6).
  - Its Confirmation: an `evidence` entry `{ "confirm": { "status": "done", "output": "…" } }` for the same marker,
    then `complete`.
  - An interrupted run: the intent stays open with no evidence; at resume, the Action's `onInterrupt` says whether to
    confirm, rerun or hold, and the default holds.
