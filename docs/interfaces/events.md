# Events

Frozen (#23). An Event is one row of the State Database's append-only `events` table (`record.md`), written by
`events.eventLog` and read back, checked against its declaration, by `lib/event-read.ts`. A change to anything listed
here outside the Reserved section needs a new ADR under `docs/adr/` and a version bump.

- Code source: `ActionEvent` (`DeterministicActionEvent` and `AgentActionEvent`) and each Lifecycle Event
  (`RunStartEvent`, `RunEndEvent`, `TicketStartEvent`, `TicketEndEvent`, `LabelFailedEvent`, `VisitEndEvent`,
  `ConfigChangeEvent`), all in `lib/events.ts`, each derived from its declaration there (`ACTION`, `AGENT`,
  `LIFECYCLE`).
- Version: `EVENT_SCHEMA_VERSION = 2`, saved as each Event's `schemaVersion`. A row of any other version is refused.

`test/unit/freeze.test.ts` holds every block below to the code.

## Rules every Event follows

- Every Event starts with its header: `schemaVersion`, `time` (ISO 8601) and `type`.
- Its declared fields follow in their declared order. A **required** field must be given, though it may be `null`; an
  **optional** field not given is saved as `null`. No other field is accepted: a field added to an Event is a new
  declaration, which needs a version bump.
- Every Event scoped to one Execution names its `owner`, `{ kind: ticket | epic, number }`, beside the unchanged
  `ticket` (X3): every Action Event, `ticket_start`, `ticket_end`, `visit_end` and `config_change`. `ticket` equals
  `owner.number`, and only `kind: ticket` is written until request slice 7. The `events.ticket` column stays.
- An Agent's `response`, a Structured Response's fields and a Harness's `sessionInit`, `tools`, `permissionDenials` and
  `commandsRun` are JSON the repository or the Harness owns, marked `JsonValue`.

## The Action Event

One per Action Attempt. A deterministic Action's Event has `agent: false` and none of the agent fields; an agent
Action's has `agent: true` and every agent field, after the Action fields. The Action fields, by presence:

```text presence:action
flow: required
configHash: required
launchProfile: required
confinement: required
ticket: required
owner: required
run: required
execution: required
vertex: required
visit: required
procedure: required
action: required
recovery: required
attempt: required
durationMs: required
outcome: required
direction: required
signals: required
rule: required
check: optional
integrityViolations: optional
retryAfterMs: optional
failureClass: optional
error: optional
cleanup: optional
decision: optional
```

The agent fields, all required:

```text presence:agent
harness: required
agentCliVersion: required
model: required
effort: required
personaHash: required
tools: required
sessionInit: required
sessionId: required
sessionLineage: required
transcriptPath: required
usage: required
exitCode: required
exitSignal: required
finalEventSubtype: required
permissionDenials: required
commandsRun: required
```

Every path, for each kind (`[]` a list's item, `*` a keyed name, `<form>` a union's form, `?` a key a row may leave
out, the declaring type in parentheses):

```text paths:DeterministicActionEvent
schemaVersion: 2 (events.DeterministicActionEvent)
time: string (events.DeterministicActionEvent)
type: "action" (events.DeterministicActionEvent)
flow: string (events.DeterministicActionEvent)
configHash: string (events.DeterministicActionEvent)
launchProfile: string | null (events.DeterministicActionEvent)
confinement: string | null (events.DeterministicActionEvent)
ticket: number (events.DeterministicActionEvent)
owner: object (events.DeterministicActionEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
run: string (events.DeterministicActionEvent)
execution: string (events.DeterministicActionEvent)
vertex: string (events.DeterministicActionEvent)
visit: number (events.DeterministicActionEvent)
procedure: string | null (events.DeterministicActionEvent)
action: string (events.DeterministicActionEvent)
recovery: number (events.DeterministicActionEvent)
attempt: number (events.DeterministicActionEvent)
durationMs: number (events.DeterministicActionEvent)
outcome: string (events.DeterministicActionEvent)
direction: string (events.DeterministicActionEvent)
signals: object (events.DeterministicActionEvent)
signals.harnessResult?: object (events.ActionSignals)
signals.harnessResult.status: "failed" | "completed" | "timed-out" | "killed"
signals.harnessResult.failureClass?: string | null
signals.claim?: object (events.ActionSignals)
signals.claim.valid: boolean (visit.ClaimSignal)
signals.claim.token: string | null (visit.ClaimSignal)
signals.claim.reason: string | null (visit.ClaimSignal)
signals.checks?: list (events.ActionSignals)
signals.checks[]: object
signals.checks[].id: string (visit.CheckSignal)
signals.checks[].kind: string (visit.CheckSignal)
signals.checks[].state: "passed" | "failed" (visit.CheckSignal)
signals.checks[].tree: string | null (visit.CheckSignal)
signals.integrity?: list (events.ActionSignals)
signals.integrity[]: object
signals.integrity[].name: string
signals.integrity[].passed: boolean
signals.integrity[].violations: list
signals.integrity[].violations[]: surface=keyof WorktreeSnapshot | surface=protected | committed tests
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.worktree: string
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.surface: keyof WorktreeSnapshot
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.before: string
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.after: string
signals.integrity[].violations[]<surface=protected | committed tests>.worktree: string
signals.integrity[].violations[]<surface=protected | committed tests>.surface: "protected" | "committed tests"
signals.integrity[].violations[]<surface=protected | committed tests>.after: list
signals.integrity[].violations[]<surface=protected | committed tests>.after[]: string
rule: object (events.DeterministicActionEvent)
rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
rule.row: string | number | null (visit.RuleIdentity)
check: string | null (events.DeterministicActionEvent)
integrityViolations: list | null (events.DeterministicActionEvent)
integrityViolations[]: surface=keyof WorktreeSnapshot | surface=protected | committed tests
integrityViolations[]<surface=keyof WorktreeSnapshot>.worktree: string
integrityViolations[]<surface=keyof WorktreeSnapshot>.surface: keyof WorktreeSnapshot
integrityViolations[]<surface=keyof WorktreeSnapshot>.before: string
integrityViolations[]<surface=keyof WorktreeSnapshot>.after: string
integrityViolations[]<surface=protected | committed tests>.worktree: string
integrityViolations[]<surface=protected | committed tests>.surface: "protected" | "committed tests"
integrityViolations[]<surface=protected | committed tests>.after: list
integrityViolations[]<surface=protected | committed tests>.after[]: string
retryAfterMs: number | null (events.DeterministicActionEvent)
failureClass: string | null (events.DeterministicActionEvent)
error: string | null (events.DeterministicActionEvent)
cleanup: object | null (events.DeterministicActionEvent)
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
decision: object | null (events.DeterministicActionEvent)
decision.instance: string
decision.event: number
decision.actor?: string
decision.time: string
decision.outcome: string
decision.next: string
decision.reply: string | null
agent: false (events.DeterministicActionEvent)
```

```text paths:AgentActionEvent
schemaVersion: 2 (events.AgentActionEvent)
time: string (events.AgentActionEvent)
type: "action" (events.AgentActionEvent)
flow: string (events.AgentActionEvent)
configHash: string (events.AgentActionEvent)
launchProfile: string | null (events.AgentActionEvent)
confinement: string | null (events.AgentActionEvent)
ticket: number (events.AgentActionEvent)
owner: object (events.AgentActionEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
run: string (events.AgentActionEvent)
execution: string (events.AgentActionEvent)
vertex: string (events.AgentActionEvent)
visit: number (events.AgentActionEvent)
procedure: string | null (events.AgentActionEvent)
action: string (events.AgentActionEvent)
recovery: number (events.AgentActionEvent)
attempt: number (events.AgentActionEvent)
durationMs: number (events.AgentActionEvent)
outcome: string (events.AgentActionEvent)
direction: string (events.AgentActionEvent)
signals: object (events.AgentActionEvent)
signals.harnessResult?: object (events.ActionSignals)
signals.harnessResult.status: "failed" | "completed" | "timed-out" | "killed"
signals.harnessResult.failureClass?: string | null
signals.claim?: object (events.ActionSignals)
signals.claim.valid: boolean (visit.ClaimSignal)
signals.claim.token: string | null (visit.ClaimSignal)
signals.claim.reason: string | null (visit.ClaimSignal)
signals.checks?: list (events.ActionSignals)
signals.checks[]: object
signals.checks[].id: string (visit.CheckSignal)
signals.checks[].kind: string (visit.CheckSignal)
signals.checks[].state: "passed" | "failed" (visit.CheckSignal)
signals.checks[].tree: string | null (visit.CheckSignal)
signals.integrity?: list (events.ActionSignals)
signals.integrity[]: object
signals.integrity[].name: string
signals.integrity[].passed: boolean
signals.integrity[].violations: list
signals.integrity[].violations[]: surface=keyof WorktreeSnapshot | surface=protected | committed tests
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.worktree: string
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.surface: keyof WorktreeSnapshot
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.before: string
signals.integrity[].violations[]<surface=keyof WorktreeSnapshot>.after: string
signals.integrity[].violations[]<surface=protected | committed tests>.worktree: string
signals.integrity[].violations[]<surface=protected | committed tests>.surface: "protected" | "committed tests"
signals.integrity[].violations[]<surface=protected | committed tests>.after: list
signals.integrity[].violations[]<surface=protected | committed tests>.after[]: string
rule: object (events.AgentActionEvent)
rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
rule.row: string | number | null (visit.RuleIdentity)
check: string | null (events.AgentActionEvent)
integrityViolations: list | null (events.AgentActionEvent)
integrityViolations[]: surface=keyof WorktreeSnapshot | surface=protected | committed tests
integrityViolations[]<surface=keyof WorktreeSnapshot>.worktree: string
integrityViolations[]<surface=keyof WorktreeSnapshot>.surface: keyof WorktreeSnapshot
integrityViolations[]<surface=keyof WorktreeSnapshot>.before: string
integrityViolations[]<surface=keyof WorktreeSnapshot>.after: string
integrityViolations[]<surface=protected | committed tests>.worktree: string
integrityViolations[]<surface=protected | committed tests>.surface: "protected" | "committed tests"
integrityViolations[]<surface=protected | committed tests>.after: list
integrityViolations[]<surface=protected | committed tests>.after[]: string
retryAfterMs: number | null (events.AgentActionEvent)
failureClass: string | null (events.AgentActionEvent)
error: string | null (events.AgentActionEvent)
cleanup: object | null (events.AgentActionEvent)
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
decision: object | null (events.AgentActionEvent)
decision.instance: string
decision.event: number
decision.actor?: string
decision.time: string
decision.outcome: string
decision.next: string
decision.reply: string | null
agent: true (events.AgentActionEvent)
harness: string (events.AgentActionEvent)
agentCliVersion: string | null (events.AgentActionEvent)
model: string | null (events.AgentActionEvent)
effort: string | null (events.AgentActionEvent)
personaHash: string (events.AgentActionEvent)
tools: JsonValue (events.AgentActionEvent)
sessionInit: JsonValue (events.AgentActionEvent)
sessionId: string | null (events.AgentActionEvent)
sessionLineage: string | null (events.AgentActionEvent)
transcriptPath: string | null (events.AgentActionEvent)
usage: object (events.AgentActionEvent)
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
exitCode: number | null (events.AgentActionEvent)
exitSignal: string | null (events.AgentActionEvent)
finalEventSubtype: string | null (events.AgentActionEvent)
permissionDenials: JsonValue (events.AgentActionEvent)
commandsRun: JsonValue (events.AgentActionEvent)
```

- `signals` holds what the Outcome was decided from: the Harness Result's status and Failure Class, the Claim, each
  Check signal `{ id, kind, state, tree }` and each Integrity Assertion with its violations (#114, #115).
- `rule` is the rule identity `{ table, row }`: the Transition Table, a Procedure's Rule Table or one of gg's fixed rows
  (table `fixed`) (#115).
- `cleanup` is the call's or command's Command Cleanup, `{ confirmed, survivors, reason, containment }`, its
  containment `{ kind: 'job' }`, `{ kind: 'group', pgid }` or `{ kind: 'none' }` (#118, L11, L14).
- `decision` is a consumed Decision, `{ instance, event, actor?, time, outcome, next, reply }` (#119, #333).
- `usage` is `{ cumulative, delta }`, each a Usage: every `USAGE_FIELDS` count (`harness.md`), `null` where the Harness
  does not report it, and an optional `costBasis`, `reported` or `priced` (J13, #135). The Usage is closed: an Event
  whose Usage holds any other key, or a count that is not a number or `null`, is refused when it is written.
- There is no `requireTestPass` (#115), `repeat` (#114) or `exhausted` (#117).

A Terminal's reporting Actions carry the Action ids `<report>-<effect>` (#111), their report one of `end`, `hold`,
`fault`, `abandon` and `resolve`, the last `gg work done`'s (#133):

```text list:report-actions
end-comment
end-epic-comment
end-label
hold-comment
hold-label
fault-comment
fault-label
abandon-label
resolve-comment
resolve-label
resolve-close
```

## Lifecycle Events

Each Lifecycle Event's fields, by presence, then every path it holds.

### run_start

```text presence:run_start
run: required
```

```text paths:RunStartEvent
schemaVersion: 2 (events.RunStartEvent)
time: string (events.RunStartEvent)
type: "run_start" (events.RunStartEvent)
run: string (events.RunStartEvent)
```

### run_end

```text presence:run_end
run: required
tickets: optional
failureClass: optional
```

```text paths:RunEndEvent
schemaVersion: 2 (events.RunEndEvent)
time: string (events.RunEndEvent)
type: "run_end" (events.RunEndEvent)
run: string (events.RunEndEvent)
tickets: list | null (events.RunEndEvent)
tickets[]: object
tickets[].ticket: number
tickets[].outcome: string
failureClass: string | null (events.RunEndEvent)
```

### ticket_start

```text presence:ticket_start
run: required
execution: required
ticket: required
owner: required
```

```text paths:TicketStartEvent
schemaVersion: 2 (events.TicketStartEvent)
time: string (events.TicketStartEvent)
type: "ticket_start" (events.TicketStartEvent)
run: string (events.TicketStartEvent)
execution: string (events.TicketStartEvent)
ticket: number (events.TicketStartEvent)
owner: object (events.TicketStartEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
```

### ticket_end

The Execution's end: its end state (`outcome`), its diff, and its full Terminal Reason `{ decidedBy, outcome, rule,
text }`, the same as the record's (`record.md`). `rule` is the rule identity exactly when a table row or a fixed row
decided the Outcome, and null for a hold, an abandonment or a fault (request 3.3). `interrupted` is the reason of a
Terminal a fault interrupted.

```text presence:ticket_end
run: required
execution: required
ticket: required
owner: required
outcome: optional
diffStats: optional
terminalReason: optional
error: optional
interrupted: optional
```

```text paths:TicketEndEvent
schemaVersion: 2 (events.TicketEndEvent)
time: string (events.TicketEndEvent)
type: "ticket_end" (events.TicketEndEvent)
run: string (events.TicketEndEvent)
execution: string (events.TicketEndEvent)
ticket: number (events.TicketEndEvent)
owner: object (events.TicketEndEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
outcome: string | null (events.TicketEndEvent)
diffStats: object | null (events.TicketEndEvent)
diffStats.files: number (events.DiffStats)
diffStats.insertions: number (events.DiffStats)
diffStats.deletions: number (events.DiffStats)
diffStats.testFiles: number (events.DiffStats)
diffStats.testInsertions: number (events.DiffStats)
terminalReason: object | null (events.TicketEndEvent)
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
error: string | null (events.TicketEndEvent)
interrupted: object | null (events.TicketEndEvent)
interrupted.terminal: string
interrupted.terminalReason: object
interrupted.terminalReason.decidedBy: record.DecidedByHold | record.DecidedByHoldInVisit | record.DecidedByLabel | record.DecidedByLabelInVisit | record.DecidedByAction | record.DecidedByHuman (record.TerminalReason)
interrupted.terminalReason.decidedBy<record.DecidedByHold>.hold: string | null (record.DecidedByHold)
interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.hold: string | null (record.DecidedByHoldInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.vertex: string (record.DecidedByHoldInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.visit: number | null (record.DecidedByHoldInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByHuman>.human: string (record.DecidedByHuman)
interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.action: string | null (record.DecidedByHoldInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByHoldInVisit>.recovery: number (record.DecidedByHoldInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByLabel>.label: string (record.DecidedByLabel)
interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.label: string (record.DecidedByLabelInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.vertex: string (record.DecidedByLabelInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.visit: number | null (record.DecidedByLabelInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.action: string | null (record.DecidedByLabelInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByLabelInVisit>.recovery: number (record.DecidedByLabelInVisit)
interrupted.terminalReason.decidedBy<record.DecidedByAction>.vertex: string (record.DecidedByAction)
interrupted.terminalReason.decidedBy<record.DecidedByAction>.visit: number | null (record.DecidedByAction)
interrupted.terminalReason.decidedBy<record.DecidedByAction>.action: string | null (record.DecidedByAction)
interrupted.terminalReason.decidedBy<record.DecidedByAction>.recovery: number (record.DecidedByAction)
interrupted.terminalReason.outcome: string | null (record.TerminalReason)
interrupted.terminalReason.rule: object | null (record.TerminalReason)
interrupted.terminalReason.rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
interrupted.terminalReason.rule.row: string | number | null (visit.RuleIdentity)
interrupted.terminalReason.text: string (record.TerminalReason)
```

### label_failed

A label write gg could not make, logged and not retried. Not scoped to one Execution.

```text presence:label_failed
ticket: required
change: required
error: required
run: optional
```

```text paths:LabelFailedEvent
schemaVersion: 2 (events.LabelFailedEvent)
time: string (events.LabelFailedEvent)
type: "label_failed" (events.LabelFailedEvent)
ticket: number (events.LabelFailedEvent)
change: object (events.LabelFailedEvent)
change.add?: list (github.LabelChange)
change.add[]: string
change.remove?: list (github.LabelChange)
change.remove[]: string
error: string (events.LabelFailedEvent)
run: string | null (events.LabelFailedEvent)
```

### visit_end

A Visit that took an Edge: its Outcome and rule, the Vertex it routes to (`next`), the bounded Edge's traversal key and
count (`edge`, `count`, null for an unbounded route), and each Bound it passed because it was spent (#335).

```text presence:visit_end
run: required
execution: required
ticket: required
owner: required
vertex: required
visit: required
outcome: required
rule: required
next: required
edge: required
count: required
spent: required
```

```text paths:VisitEndEvent
schemaVersion: 2 (events.VisitEndEvent)
time: string (events.VisitEndEvent)
type: "visit_end" (events.VisitEndEvent)
run: string (events.VisitEndEvent)
execution: string (events.VisitEndEvent)
ticket: number (events.VisitEndEvent)
owner: object (events.VisitEndEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
vertex: string (events.VisitEndEvent)
visit: number (events.VisitEndEvent)
outcome: string (events.VisitEndEvent)
rule: object (events.VisitEndEvent)
rule.table: "fixed" | "stopped" | "passed" | "failed" (visit.RuleIdentity)
rule.row: string | number | null (visit.RuleIdentity)
next: string (events.VisitEndEvent)
edge: string | null (events.VisitEndEvent)
count: number | null (events.VisitEndEvent)
spent: list (events.VisitEndEvent)
spent[]: {edge} | {vertex}
spent[]<{edge}>.edge: string
spent[]<{vertex}>.vertex: string
```

### config_change

A resumed Execution's Config Hash, from the one it last ran under (`from`) to the Run's (`to`), at the Vertex entry
that moved it (#368).

```text presence:config_change
run: required
execution: required
ticket: required
owner: required
vertex: required
visit: required
from: required
to: required
```

```text paths:ConfigChangeEvent
schemaVersion: 2 (events.ConfigChangeEvent)
time: string (events.ConfigChangeEvent)
type: "config_change" (events.ConfigChangeEvent)
run: string (events.ConfigChangeEvent)
execution: string (events.ConfigChangeEvent)
ticket: number (events.ConfigChangeEvent)
owner: object (events.ConfigChangeEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
vertex: string (events.ConfigChangeEvent)
visit: number (events.ConfigChangeEvent)
from: string (events.ConfigChangeEvent)
to: string (events.ConfigChangeEvent)
```

### ticket_resolved

A person resolved the Ticket by hand with `gg work done` (L12, #133): its end `done`, `human` their gh login. A
person's verb runs outside a Run, so `run` is absent.

```text presence:ticket_resolved
run: optional
execution: required
ticket: required
owner: required
human: required
```

```text paths:TicketResolvedEvent
schemaVersion: 2 (events.TicketResolvedEvent)
time: string (events.TicketResolvedEvent)
type: "ticket_resolved" (events.TicketResolvedEvent)
run: string | null (events.TicketResolvedEvent)
execution: string (events.TicketResolvedEvent)
ticket: number (events.TicketResolvedEvent)
owner: object (events.TicketResolvedEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
human: string (events.TicketResolvedEvent)
```

### ticket_resumed

A person handed the Ticket back with `gg work resume --at <vertex>` (L12, #133): `human` their gh login, `vertex` the
Vertex it re-enters at a new Visit, `head` the branch tip it took as the baseline Reconciliation checks from, and
`superseded` the Action Markers of the open write-ahead intents it marked finished with nothing found. It is saved
before the Run that resumes the Ticket starts it, so `run` is absent.

```text presence:ticket_resumed
run: optional
execution: required
ticket: required
owner: required
human: required
vertex: required
head: required
superseded: required
```

```text paths:TicketResumedEvent
schemaVersion: 2 (events.TicketResumedEvent)
time: string (events.TicketResumedEvent)
type: "ticket_resumed" (events.TicketResumedEvent)
run: string | null (events.TicketResumedEvent)
execution: string (events.TicketResumedEvent)
ticket: number (events.TicketResumedEvent)
owner: object (events.TicketResumedEvent)
owner.kind: "ticket" | "epic" (record.Owner)
owner.number: number (record.Owner)
human: string (events.TicketResumedEvent)
vertex: string (events.TicketResumedEvent)
head: string (events.TicketResumedEvent)
superseded: list (events.TicketResumedEvent)
superseded[]: string
```

## Failure Classes

The set is closed: a new class needs a new ADR and a version bump. An Action Event's `failureClass`, a Harness
Result's `signals.harnessResult.failureClass` and `run_end.failureClass` hold one of these; `record.md` gives each
source's classes.

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

## Reserved

Shapes later tickets land without a version bump; the landing ticket moves each into the declarations, treating it as
optional when absent.

- **#135, cost and quota reports (J13).** The agent Action Event's `quota`: `null` or `{ plan, windows: [{ limit,
  windowMinutes, resetsAt, usedPercent: { first, last } }], credits: { balance, unit } | null }`, the snapshots the
  Harness saw during the Attempt. It is an agent field, declared optional. The Execution Record's `owner`, `flow` and
  `configHash`, the Event `time` and the `configs` table already key the per-Ticket, per-Epic and per-configuration
  totals.
- **#335, the escaped-defect report (F5).** The Lifecycle Event `ticket_escaped { run?, execution, ticket, owner,
  defect, human }`, `defect` the defect's issue number and `human` the login that records it.
