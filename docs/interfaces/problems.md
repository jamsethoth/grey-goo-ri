# Problem codes

Each error or warning the Flow validator reports (`gg doctor`, and `gg run`'s admission) is a Problem: a `code` naming
the rule it breaks, `at`, the configuration path it is about, `params`, the values its sentence names, and `message`,
the sentence (`lib/validate/report.ts`).

## The promise

Problem codes are stable, as Node's `error.code` is (owner, 2026-11-07):

- A code keeps its meaning.
- Adding a code needs no ADR.
- Renaming or removing a code, or changing what it means, needs a new ADR under `docs/adr/`.
- `at` stays a plain configuration path, and a code's `params` keys keep their meaning.
- `message` wording may change at any time, so no code reads it: code that needs the kind of a Problem reads `code`.

Nothing persists a Problem, so it has no version constant. `test/unit/freeze.test.ts` holds both blocks below to
`PROBLEM_CODES` and `ProblemParams`.

## Every code

`PROBLEM_CODES`, in its order:

```text list:PROBLEM_CODES
empty-list
not-a-boolean
not-a-list
not-a-positive-integer
not-a-string
not-an-object
null-value
required-key-missing
unknown-key
invalid-name
reserved-name
exhausted-without-max
human-only-end
malformed-route-target
max-without-exhausted
no-flow-declared
no-vertex-declared
undeclared-procedure
unknown-end
unknown-outcome
unknown-vertex
harness-unregistered
harness-unset
undeclared-agent
unknown-permission-intent
unused-agent
vertex-needs-agent
vertex-takes-no-agent
unsupported-agent-field
unenforceable-permission-intent
session-resume-unsupported
agent-action-not-first
await-approval-not-last
await-approval-with-agent
check-after-effect
claim-enum-mismatch
claim-tokens-missing
claim-tokens-without-agent-action
commit-type-unnamed
file-not-named
invalid-comment-target
invalid-otherwise
invalid-procedure-access
access-conflict
invalid-reuse
invalid-tests-setting
malformed-claim-token
malformed-recover
needs-agent-action
pr-ready-without-checks
repeated-action-id
repeated-decision
second-agent-action
undeclared-check
undeclared-command
unknown-action-kind
unknown-check-kind
schema-not-strict
schema-unreadable
template-unreadable
malformed-reference
not-a-list-of-objects
not-a-list-of-strings
reference-into-list
source-types-differ
undefined-reference
unknown-item-field
condition-value-mismatch
invalid-condition-field
malformed-all-of
malformed-condition
malformed-count
invalid-rule-condition
invalid-rule-field
malformed-row
never-firing-row
overlapping-rows
rule-condition-mismatch
rule-table-too-large
table-never-applies
undeclared-rule-field
unreachable-row
commit-without-check
exhausted-loop
optional-input-unsure
pr-ready-skippable
required-input-unsure
unbounded-cycle
unreachable-vertex
unrouted-outcome
write-without-commit
repository-labels-missing
repository-labels-unread
harness-preflight-failed
repository-unread
state-database-missing
invalid-command-line
invalid-glob
unknown-flow
```

The rule each code names:

| Code | The rule it names |
| --- | --- |
| `empty-list` | a list that must hold at least one item is empty |
| `not-a-boolean` | a value must be `true` or `false` |
| `not-a-list` | a value must be a list |
| `not-a-positive-integer` | a value must be a positive integer |
| `not-a-string` | a value must be a string |
| `not-an-object` | a value must be an object |
| `null-value` | `null` is never a value in a configuration file: set a value or leave the key out |
| `required-key-missing` | a required key is left out |
| `unknown-key` | a key that is not declared where it is |
| `invalid-name` | a name breaks its form |
| `reserved-name` | a name gg reserves is taken |
| `exhausted-without-max` | a route names `exhausted` without `max` |
| `human-only-end` | a route names the human-only end `done` |
| `malformed-route-target` | a route target is not a Vertex id, `{ end }` or `{ to, max?, exhausted? }` |
| `max-without-exhausted` | a route with `max` names no `exhausted` target |
| `no-flow-declared` | a source declares no Flow |
| `no-vertex-declared` | a Flow declares no Vertex |
| `undeclared-procedure` | a Vertex names a Procedure that is not declared |
| `unknown-end` | an end is not one of gg's end states |
| `unknown-outcome` | a route is keyed by an Outcome its Vertex cannot produce, or a Flow route by one no Vertex produces |
| `unknown-vertex` | a route names a Vertex that is not declared |
| `harness-unregistered` | an Agent names a Harness that is not registered |
| `harness-unset` | an Agent sets no Harness |
| `undeclared-agent` | a Vertex uses an Agent that is not declared |
| `unknown-permission-intent` | an `access` is not a Permission Intent |
| `unused-agent` | a declared Agent is used by no Vertex (warning) |
| `vertex-needs-agent` | a Vertex whose Procedure has an agent Action names no Agent |
| `vertex-takes-no-agent` | a Vertex whose Procedure has no agent Action names an Agent |
| `unsupported-agent-field` | an Agent lists a field its Harness declares unsupported |
| `unenforceable-permission-intent` | an Agent's `access` or `network` is one its Harness declares `hint` or `unsupported`, so it cannot enforce it |
| `session-resume-unsupported` | a Vertex's Procedure declares `recover` on a Harness that cannot resume a Session |
| `agent-action-not-first` | the agent Action is not a Procedure's first Action |
| `await-approval-not-last` | `await-approval` is not its Procedure's last Action |
| `await-approval-with-agent` | `await-approval` sits in a Procedure with an agent Action |
| `check-after-effect` | a Check comes after an effect Action |
| `claim-enum-mismatch` | the Claim tokens and the response schema's `claim` enum differ |
| `claim-tokens-missing` | a Procedure with an agent Action declares no `claimTokens` |
| `claim-tokens-without-agent-action` | a Procedure with no agent Action declares `claimTokens` |
| `commit-type-unnamed` | a `commit` Action names no commit `type` |
| `file-not-named` | a key that names a file is not a file name |
| `invalid-comment-target` | a `comment` Action's `target` is not `pr` or `ticket` |
| `invalid-otherwise` | a Claim token's `otherwise` is not one it may name |
| `invalid-procedure-access` | a Procedure's `access` is not `read-only` |
| `access-conflict` | a Vertex's Agent asks for workspace-write on a read-only Procedure: set `"access": "read-only"` on the Vertex |
| `invalid-reuse` | a Check's `reuse` is not `tree` |
| `invalid-tests-setting` | `tests` is not `frozen`, `write` or `{ named }` |
| `malformed-claim-token` | a Claim token is not of its declared shape |
| `malformed-recover` | `recover` is not `{ max, brief }` |
| `needs-agent-action` | a `commit` carries the agent Action's summary in a Procedure that has none |
| `pr-ready-without-checks` | `pr-ready` publishes under a Claim token that requires no Check |
| `repeated-action-id` | an Action id is repeated in a Procedure |
| `repeated-decision` | a Decision is repeated |
| `second-agent-action` | a Procedure declares a second agent Action |
| `undeclared-check` | a Claim token requires a Check its Procedure does not declare |
| `undeclared-command` | a Check names a command the repository does not declare |
| `unknown-action-kind` | an Action's `do` is not an Action kind |
| `unknown-check-kind` | a Check's `kind` is not a Check kind |
| `schema-not-strict` | a response schema is outside gg's strict subset |
| `schema-unreadable` | a response schema cannot be read |
| `template-unreadable` | a template cannot be read |
| `malformed-reference` | a reference path is not of the reference form |
| `not-a-list-of-objects` | a reference that must read a list of objects reads another type |
| `not-a-list-of-strings` | a reference that must read a list of strings reads another type |
| `reference-into-list` | a reference path reads into a list's items |
| `source-types-differ` | an input's sources have different types |
| `undefined-reference` | a reference path reads a field nothing defines |
| `unknown-item-field` | a `where` names a field a list's items do not have |
| `condition-value-mismatch` | a condition's value does not fit its field's type |
| `invalid-condition-field` | a condition names a field of a type it cannot test |
| `malformed-all-of` | `allOf` is not a non-empty list of conditions, alone |
| `malformed-condition` | a condition is not of a condition's forms |
| `malformed-count` | a `count` is not an operator with an integer |
| `invalid-rule-condition` | a Rule Table condition is not one its field can take |
| `invalid-rule-field` | a Rule Table names a field of a type a rule cannot test |
| `malformed-row` | a Rule Table row is not `{ when, outcome }` |
| `never-firing-row` | a Rule Table row can never fire (warning) |
| `overlapping-rows` | earlier rows partly take a Rule Table row (warning) |
| `rule-condition-mismatch` | a Rule Table condition does not fit its field's type |
| `rule-table-too-large` | a Rule Table's analysis passes the work limit |
| `table-never-applies` | a Rule Table never applies, since no Claim token reaches it (warning) |
| `undeclared-rule-field` | a Rule Table names a field its Procedure does not declare |
| `unreachable-row` | a Rule Table row is unreachable |
| `commit-without-check` | a writing Vertex's committing Claim token requires no Check |
| `exhausted-loop` | `exhausted` targets form a loop no Vertex leaves |
| `optional-input-unsure` | no route is sure to produce an optional input's sources (warning) |
| `pr-ready-skippable` | an Outcome reaches `ready-for-qa` on a route that may skip `pr-ready` |
| `required-input-unsure` | a route may not produce a required input's sources (warning) |
| `unbounded-cycle` | a cycle has no Edge or Vertex with `max` |
| `unreachable-vertex` | a Vertex is not reachable from the entry (warning) |
| `unrouted-outcome` | an Outcome is routed by neither its Vertex nor the Flow |
| `write-without-commit` | a writing Vertex does not commit on every passing path |
| `repository-labels-missing` | the repository lacks labels the Flows can request (warning) |
| `repository-labels-unread` | the repository's labels could not be read (warning) |
| `harness-preflight-failed` | a Vertex's Harness failed its preflight |
| `repository-unread` | the repository's GitHub `owner/name` could not be read |
| `state-database-missing` | the repository has no State Database: run `gg init` |
| `invalid-command-line` | a Declared Command is not a valid command line |
| `invalid-glob` | a `testPaths` glob is one gg's readers do not read alike |
| `unknown-flow` | an Execution Record a Run would resume names a Flow that is gone |

## What one run cannot report

`gg doctor` reports every failure it can in one run. These wait until another error is fixed, since the value they read
is unknown until then:

1. A Vertex's `unknown-outcome` and `unrouted-outcome`, while its Procedure has an error (in the user's directory, a
   command the repository does not declare among them), or the Vertex itself has one apart from its route targets: its
   Outcomes may be short. `unrouted-outcome` also waits while the Flow's `vertices` or `routes` is malformed: whether
   an Outcome is routed is unknown.
2. `unknown-outcome` at the Flow's default `routes`, while any Vertex waits as in 1, or the Flow's `vertices` or
   `routes` is malformed: the union of its Vertices' Outcomes is unknown.
3. Every other check over a Flow's route map (`write-without-commit`, `commit-without-check`, `unbounded-cycle`,
   `exhausted-loop`, `pr-ready-skippable`, `required-input-unsure`, `optional-input-unsure` and `unreachable-vertex`),
   while the Flow, or a section every Flow reads, has any error other than an `unknown-outcome` (H6). #449 narrows
   this.

## Their params

`ProblemParams`: each code's `params`, as its sentence names them. A code not listed names none. One line per path, as
in `record.md`: `[]` a list's item, `<form>` a union's form, `?` a key a Problem may leave out.

```text paths:ProblemParams
required-key-missing: object (report.ProblemParams)
required-key-missing.key: string
required-key-missing.id?: unknown
required-key-missing.field?: unknown
required-key-missing.values?: list
required-key-missing.values[]: string
required-key-missing.file?: string
empty-list: object (report.ProblemParams)
empty-list.file?: string (report.InSourceFile)
unknown-key: object (report.ProblemParams)
unknown-key.key: string
unknown-key.file?: string
not-a-positive-integer: object (report.ProblemParams)
not-a-positive-integer.file?: string (report.InSourceFile)
not-a-string: object (report.ProblemParams)
not-a-string.file?: string (report.InSourceFile)
invalid-name: object (report.ProblemParams)
invalid-name.name?: unknown
invalid-name.index?: number
invalid-name.file?: string
reserved-name: object (report.ProblemParams)
reserved-name.name: string
reserved-name.file?: string
unknown-vertex: object (report.ProblemParams)
unknown-vertex.vertex: unknown
unknown-end: object (report.ProblemParams)
unknown-end.end: unknown
unknown-outcome: object (report.ProblemParams)
unknown-outcome.outcome: string
unknown-outcome.outcomes: list
unknown-outcome.outcomes[]: string
undeclared-procedure: object (report.ProblemParams)
undeclared-procedure.procedure: unknown
harness-unregistered: {agent,harness} | {vertex,harness} (report.ProblemParams)
harness-unregistered<{agent,harness}>.agent: string
harness-unregistered<{agent,harness}>.harness: string
harness-unregistered<{vertex,harness}>.vertex: string
harness-unregistered<{vertex,harness}>.harness: string
harness-unset: {agent} | {vertex} (report.ProblemParams)
harness-unset<{agent}>.agent: string
harness-unset<{vertex}>.vertex: string
undeclared-agent: object (report.ProblemParams)
undeclared-agent.agent: unknown
unknown-permission-intent: object (report.ProblemParams)
unknown-permission-intent.access: unknown
unused-agent: object (report.ProblemParams)
unused-agent.agent: string
vertex-needs-agent: object (report.ProblemParams)
vertex-needs-agent.procedure: string
vertex-takes-no-agent: object (report.ProblemParams)
vertex-takes-no-agent.procedure: string
unsupported-agent-field: object (report.ProblemParams)
unsupported-agent-field.field: string
unsupported-agent-field.harness: string
unenforceable-permission-intent: object (report.ProblemParams)
unenforceable-permission-intent.field: string
unenforceable-permission-intent.harness: string
unenforceable-permission-intent.capability: string
session-resume-unsupported: object (report.ProblemParams)
session-resume-unsupported.procedure: string
session-resume-unsupported.harness: string
access-conflict: object (report.ProblemParams)
access-conflict.procedure: string
access-conflict.agent?: string
check-after-effect: object (report.ProblemParams)
check-after-effect.id?: unknown
check-after-effect.effect: string
check-after-effect.effectId?: unknown
claim-enum-mismatch: object (report.ProblemParams)
claim-enum-mismatch.schema: string
claim-enum-mismatch.enum?: list
claim-enum-mismatch.enum[]: string
claim-enum-mismatch.tokens: list
claim-enum-mismatch.tokens[]: string
file-not-named: object (report.ProblemParams)
file-not-named.key: string
pr-ready-without-checks: object (report.ProblemParams)
pr-ready-without-checks.token: string
repeated-action-id: object (report.ProblemParams)
repeated-action-id.id: string
undeclared-check: object (report.ProblemParams)
undeclared-check.check: unknown
undeclared-command: object (report.ProblemParams)
undeclared-command.id?: unknown
undeclared-command.command: unknown
unknown-action-kind: object (report.ProblemParams)
unknown-action-kind.kind: unknown
unknown-check-kind: object (report.ProblemParams)
unknown-check-kind.kind: unknown
schema-not-strict: object (report.ProblemParams)
schema-not-strict.schema: string
schema-not-strict.reason: string
schema-unreadable: object (report.ProblemParams)
schema-unreadable.schema: string
schema-unreadable.reason: string
template-unreadable: object (report.ProblemParams)
template-unreadable.template: string
template-unreadable.reason: string
template-unreadable.flow?: string
template-unreadable.vertex?: string
malformed-reference: object (report.ProblemParams)
malformed-reference.path: unknown (report.Reference)
malformed-reference.template?: string (report.Reference)
malformed-reference.flow?: string (report.Reference)
malformed-reference.vertex?: string (report.Reference)
not-a-list-of-objects: object (report.ProblemParams)
not-a-list-of-objects.path: unknown
not-a-list-of-objects.template?: string
not-a-list-of-objects.flow?: string
not-a-list-of-objects.vertex?: string
not-a-list-of-objects.type: unknown
not-a-list-of-strings: object (report.ProblemParams)
not-a-list-of-strings.path: unknown
not-a-list-of-strings.template?: string
not-a-list-of-strings.flow?: string
not-a-list-of-strings.vertex?: string
not-a-list-of-strings.type: unknown
reference-into-list: object (report.ProblemParams)
reference-into-list.path: unknown
reference-into-list.template?: string
reference-into-list.flow?: string
reference-into-list.vertex?: string
reference-into-list.list: string
source-types-differ: object (report.ProblemParams)
source-types-differ.sources: list
source-types-differ.sources[]: unknown
undefined-reference: object (report.ProblemParams)
undefined-reference.path: unknown
undefined-reference.template?: string
undefined-reference.flow?: string
undefined-reference.vertex?: string
undefined-reference.missing: string
unknown-item-field: object (report.ProblemParams)
unknown-item-field.field: unknown
unknown-item-field.flow?: string
unknown-item-field.vertex?: string
condition-value-mismatch: object (report.ProblemParams)
condition-value-mismatch.field: unknown
condition-value-mismatch.value?: unknown
condition-value-mismatch.values?: list
condition-value-mismatch.values[]: string
invalid-condition-field: object (report.ProblemParams)
invalid-condition-field.field: unknown
invalid-condition-field.type: unknown
invalid-rule-condition: object (report.ProblemParams)
invalid-rule-condition.field: string (report.RuleField)
invalid-rule-condition.flow?: string (report.RuleField)
invalid-rule-condition.vertex?: string (report.RuleField)
invalid-rule-field: object (report.ProblemParams)
invalid-rule-field.field: string
invalid-rule-field.flow?: string
invalid-rule-field.vertex?: string
invalid-rule-field.type: unknown
never-firing-row: object (report.ProblemParams)
never-firing-row.table: string (report.RuleRow)
never-firing-row.flow?: string (report.RuleRow)
never-firing-row.vertex?: string (report.RuleRow)
never-firing-row.row: number (report.RuleRow)
never-firing-row.outcome: string (report.RuleRow)
overlapping-rows: object (report.ProblemParams)
overlapping-rows.table: string
overlapping-rows.rows: [number, number]
overlapping-rows.earlier: list
overlapping-rows.earlier[]: [number, number]
overlapping-rows.more: number
overlapping-rows.from: number | null
overlapping-rows.fields: list
overlapping-rows.fields[]: string
overlapping-rows.example: keyed
overlapping-rows.example.*: unknown
overlapping-rows.conditions: list
overlapping-rows.conditions[]: object
overlapping-rows.conditions[].row: number
overlapping-rows.conditions[].when: keyed
overlapping-rows.conditions[].when.*: unknown
overlapping-rows.flow?: string
overlapping-rows.vertex?: string
rule-condition-mismatch: object (report.ProblemParams)
rule-condition-mismatch.field: string
rule-condition-mismatch.flow?: string
rule-condition-mismatch.vertex?: string
rule-condition-mismatch.condition: unknown
rule-condition-mismatch.type: unknown
rule-table-too-large: object (report.ProblemParams)
rule-table-too-large.table: string
rule-table-too-large.flow?: string
rule-table-too-large.vertex?: string
rule-table-too-large.work: number
rule-table-too-large.limit: number
rule-table-too-large.largest: list
rule-table-too-large.largest[]: [string, number]
undeclared-rule-field: object (report.ProblemParams)
undeclared-rule-field.table: string
undeclared-rule-field.flow?: string
undeclared-rule-field.vertex?: string
undeclared-rule-field.fields: list
undeclared-rule-field.fields[]: string
unreachable-row: object (report.ProblemParams)
unreachable-row.table: string (report.RuleRow)
unreachable-row.flow?: string (report.RuleRow)
unreachable-row.vertex?: string (report.RuleRow)
unreachable-row.row: number (report.RuleRow)
unreachable-row.outcome: string (report.RuleRow)
commit-without-check: object (report.ProblemParams)
commit-without-check.vertex: string
commit-without-check.token: string
not-a-list: object (report.ProblemParams)
not-a-list.table?: string
not-a-list.value?: unknown
not-a-list.file?: string
not-an-object: object (report.ProblemParams)
not-an-object.value?: unknown
not-an-object.file?: string
invalid-command-line: object (report.ProblemParams)
invalid-command-line.command: string
invalid-command-line.file: string
invalid-glob: object (report.ProblemParams)
invalid-glob.glob: unknown
invalid-glob.file: string
harness-preflight-failed: object (report.ProblemParams)
harness-preflight-failed.vertex: string
harness-preflight-failed.harness: string
harness-preflight-failed.reason: string
repository-unread: object (report.ProblemParams)
repository-unread.path: string
repository-unread.reason: string
state-database-missing: object (report.ProblemParams)
state-database-missing.path: string
unknown-flow: object (report.ProblemParams)
unknown-flow.name: string
unknown-flow.declared: list
unknown-flow.declared[]: string
unknown-flow.ticket?: number
table-never-applies: object (report.ProblemParams)
table-never-applies.table: string
optional-input-unsure: object (report.ProblemParams)
optional-input-unsure.input: string
optional-input-unsure.vertex: string
required-input-unsure: object (report.ProblemParams)
required-input-unsure.input: string
required-input-unsure.vertex: string
unreachable-vertex: object (report.ProblemParams)
unreachable-vertex.vertex: string
repository-labels-missing: object (report.ProblemParams)
repository-labels-missing.labels: list
repository-labels-missing.labels[]: string
repository-labels-unread: object (report.ProblemParams)
repository-labels-unread.reason: string
exhausted-loop: object (report.ProblemParams)
exhausted-loop.loop: list
exhausted-loop.loop[]: string
pr-ready-skippable: object (report.ProblemParams)
pr-ready-skippable.outcome: string
unbounded-cycle: object (report.ProblemParams)
unbounded-cycle.cycle: list
unbounded-cycle.cycle[]: string
unrouted-outcome: object (report.ProblemParams)
unrouted-outcome.outcome: string
write-without-commit: object (report.ProblemParams)
write-without-commit.vertex: string
write-without-commit.procedure: string
```
