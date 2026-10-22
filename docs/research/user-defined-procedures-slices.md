# User-defined Procedures: slicing (step 7)

Draft, 2026-10-22, for the owner's review. It slices option 1 as decided in
[user-defined-procedures-decisions.md](user-defined-procedures-decisions.md) and shown in
[user-defined-procedures-example-flow.md](user-defined-procedures-example-flow.md). It replaces the round-1 S1–S6
proposal. Slice ids here (A1, E1, C1) are local to this file. Nothing is filed until the owner approves.

## Shape

Seventeen tickets, sub-issues of one Epic, in three tracks:

- **A, groundwork**: pure modules and config, built and tested against fixtures. Only A1 and A4 touch the interpreter.
- **E, engine**: interpreter tickets, strictly serial (request section 6: one interpreter-touching ticket in flight).
  Each changes main's shipped Flow in place and regenerates the golden traces it names, so the suite is green after
  every ticket and no second engine lives beside the first.
- **C, cutover**: `gg init` writes the example, then the defaults Layer stops shipping a Flow (U8).

The engine order puts the Flow-level changes (red and green Vertices, ends, inputs) before Procedures move into
config, so that when E7 wires the validator into admission the shipped Flow is already in its final shape.

Prerequisite, outside the Epic: ADR 0014 and these research files merge to main first (handoff step 2).

Every ticket follows the existing format (Problem, Goal, In scope, Out of scope, Definition of done, Tests to write
first, QA hints, Notes). The Epic notes R7c: delete any real `.git/gg/gg.db` between slices, since no versions bump
before grey-goo-ri issue #23.

## Order

| Id | Ticket | Interpreter | Depends on |
|---|---|---|---|
| A1 | `testPaths` is required and feeds every consumer | yes, small | none |
| A2 | Rule tables: the first-match evaluator and the analyser | no | none |
| A3 | Response schemas as data: the strict subset and typed reference paths | no | none |
| A4 | Templates for Briefs, the PR body and comments | yes, call sites | none |
| A5 | The Flow shape, its validator and `gg doctor` | no | A2, A3 |
| A6 | Graph analysis: routing, bounds, publishing, commits, inputs | no | A5 |
| E1 | Red and green on separate Vertices | yes | A1 |
| E2 | Action ids and the Recovery Number | yes | E1 |
| E3 | Ends, Flow routes and the `publish` Vertex | yes | E2, A4 |
| E4 | Vertex inputs | yes | E3 |
| E5 | Checks as declared Actions; the engine Outcome `failed` | yes | E4, A2 |
| E6 | Claim tokens, recovery and `pass` | yes | E5 |
| E7 | Procedures come from config; admission runs the validator | yes | E6, A6 |
| E8 | `maxVisits`, the Action Cap and `repeat` routing | yes | E7 |
| E9 | Rescue Refs for work routed to another Vertex | yes | E8 |
| C1 | `gg init` writes the example; this repository gets its own Flow | no | E9 |
| C2 | The defaults Layer ships no Flow | no | C1 |

Serial chain: A1 → A4 → E1 → … → E9 (A4 may go before or after A1). A2, A3, A5 and A6 run beside it. grey-goo-ri
issue #23 is marked blocked by C2.

## Tickets

Each entry lists the decisions it builds, then what it names under S7: golden traces regenerated, glossary entries,
and `gg doctor` output. "Goldens" means the `golden:` cases in `test/interpreter.test.mjs` and the crash-and-resume
traces in `test/reconcile.test.mjs`.

### A1. `testPaths` is required and feeds every consumer

P4, U9, U15, T12, R3e. The repository Layer must declare `testPaths` (non-empty list of glob strings); preflight
rejects a missing, empty or non-glob value naming the file, as `commandProblems` does for `test`. `testPaths` in the
defaults or user Layer is a load error. The value is pinned in the snapshot and Config Hash and feeds Test
Immutability, the rollback set, `TEST_PATHSPECS`, the review's changed-test list and `events.diffStats`, which drops
its own `TEST_PATH` regex. Excluding dependency directories stays in code. This repository's `.agents/gg/gg.json`
gains today's `DEFAULT_TEST_GLOBS`.
- Tests: a test file outside today's globs is covered by Test Immutability, rollback and diffStats; the three
  preflight failures; the user-Layer load error.
- Goldens: unchanged (fixtures pin `DEFAULT_TEST_GLOBS`). Glossary: none. Doctor: the preflight messages.

### A2. Rule tables: the first-match evaluator and the analyser

R8, R14d, Q4, Q4a, R13a, T10. One module: first-match evaluation over enum, boolean and integer fields with dotted
paths and the value `absent`; the exact box analysis (unreachable or never-firing row is an error; partial overlap is
a warning with one example input; an example input that falls to the default). Hand-written, no solver (ADR 0001).
New module, added to the AGENTS.md Layout table.
- Tests: brute-force enumeration over a finite partition cross-checks the analysis on generated tables; the example's
  review `passed` table yields exactly its three intended warnings (U4).
- Goldens: none. Glossary: rule table. Doctor: the error and warning text A5 prints.

### A3. Response schemas as data

V1, R13a, R13c, R13e; makes the library survey's deferred `ajv` decision. `briefs.assertStrict` and
`validateResponse` accept any repository schema within a declared strict subset and reject other keywords at load;
a Claim-enum check (the enum equals the declared tokens, no case-only differences); `fieldType(schema, path)` types
a reference path for rules, `pick`, `response` Check fields and inputs.
- Tests: a schema with an unsupported keyword fails naming it; every example schema passes; path typing over nested
  objects and arrays of objects.
- Goldens: none. Glossary: none. Doctor: schema errors naming file and path.

### A4. Templates for Briefs, the PR body and comments

U1, Q7, S5, T10, W6. One template mechanism: a name resolves to gg's own context (computed only when named), the
Vertex's own outputs, or `inputs`; an absent value renders empty. Today's Brief builders, the nudge, `render.prBody`,
the review comment and the blocked and replan comments become template files beside the shipped Personas, with
byte-identical output. The syntax is settled here (see question 3).
- Tests: byte-identical output for every ported builder; a context value not named is never computed.
- Goldens: unchanged. Glossary: none. Doctor: none yet.

### A5. The Flow shape, its validator and `gg doctor`

V1, U13, R6d, R13e, W2, W3, T6, U7, U12, R3b, W1, P5d. `lib/flow.mjs` validates the final shape (Agents, Procedures
with Action ids, `do:` kinds, Check kinds and parameters, Claim tokens, `tests`, `access`, `recover`, the three tables
and `otherwise`; Flows with `entry`, `routes`, Vertices, `inputs`, `route`, `maxVisits`, `exhausted`) and produces the
Resolved Flow. Named commands must be declared (U13). Every reference is typed through A3; tables are analysed
through A2. `gg doctor` prints each Vertex's effective Procedure, access, `tests`, Checks, tables, reachable Outcomes
and inputs with their sources, and exits non-zero on any error. Not yet called by admission (E7).
- Tests: fixture Flows for each error; the example Flow from the docs passes.
- Goldens: none. Glossary: Resolved Flow updated. Doctor: the output above, pinned for the example.

### A6. Graph analysis

R12b, T3, R12c–d, I3, R11d–e, T1a (admission part), S2, T1c, S4, Q7, T9, U5. Every Outcome routed by the Vertex or
the Flow's `routes`; the engine Outcomes default to `end: needs-human`; every cycle bounded by an edge `max`,
`maxVisits` or the Action Cap; publishing Actions only in Vertices requiring a Check, and every path to
`end: ready-for-qa` running `pr-ready`; a commit on every passing path of a write Vertex whose committing token
requires a Check; inputs produced on every path per Outcome, and an optional input produced on some path;
unreachable Vertices warned.
- Tests: one fixture per rule; the example's admission summary (example-flow "What admission sees") reproduced.
- Goldens: none. Glossary: none. Doctor: which Outcomes fall to `"*"` and which to the engine default (R12d); where
  each failure's work goes (rescued or left in place, on the effective target).

### E1. Red and green on separate Vertices

R2a–d. `tdd` splits into code Procedures `tests-fail` and `implement`; the shipped Flow becomes red → green →
reviewer ⇄ implementer-fix. `resumeGreen` goes. The dirty-worktree guard becomes R2d (a write Vertex starts on a
clean worktree or one gg's records explain), replacing the literal `phase === 'red'` test. Green still reads red's
outputs from the record; E4 makes that an input.
- Goldens: all five `golden:` cases and the crash-and-resume traces (Vertex names, Visits). Glossary: none.
  Doctor: none.

### E2. Action ids and the Recovery Number

R6, S1. The marker becomes `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>`; the cursor,
`rec.retries`, the settled result and the Action Event key on Action id and Recovery Number; `rec.sessions` on the
agent Action. The recovery Phases count as Recovery Numbers until E6 removes them. Reconciliation parses the new
marker.
- Goldens: every trace (markers). Glossary: Action id, Action identity, Recovery Number. Doctor: none.

### E3. Ends, Flow routes and the `publish` Vertex

R11, R12, T1a, T2, T3, U6, W4, W5, W9, P5c, Q3f, Q6. `end: ready-for-qa | needs-human | needs-replan` replaces the
Terminals; `then` goes; the Flow's default `routes` and `"*"`; `harness-timeout`, `harness-transient` and
`harness-unparsed` become routable, defaulting to `end: needs-human`; a stop token's comment template replaces the end
comment and goes to the Epic too at `needs-replan`; `misscoped` reaches the planner through the Flow's default route.
A `publish` Vertex (code Procedure: the test Check, `pr-upsert`, `pr-ready`) replaces `done`; `pr-ready` runs only if
the Check's tree equals the published commit's and the worktree is clean, with the target kept through retries and
Reconciliation. `comment` takes `target`.
- Goldens: every case ending at `done` (now `publish` then `ready-for-qa`), the blocked and replan cases. Glossary:
  end state, publishing Action. Doctor: none until E7.

### E4. Vertex inputs

Q7, S4, T6, T10, R13b–d, W2, U1. `inputs` with `from` (one source or a list; the latest Visit wins), `optional` and
`absent`, and `pick`, snapshotted with provenance at Visit entry. Briefs, templates, Check parameters and `tests:
named` read them. Replaces the record's `outputs.red` reads and `findings.map((f) => f.file)`. The shipped Flow
declares green's tests and red evidence, the reviewer's report and evidences, and the fix Vertex's findings and
`testFiles`.
- Goldens: the record's Visit snapshot gains the inputs; Events unchanged. Glossary: Vertex input. Doctor: none until
  E7.

### E5. Checks as declared Actions; the engine Outcome `failed`

R1, R4, T1b, T4c, U14, P5a, P5d, S6 (signal), T7, U10. Checks become Actions with ids and kinds `command`,
`tests-fail`, `response` (with `all-of`) and `repeat`, parameters naming a Declared Command. Each records `{ id, kind,
state, tree }`; a commit and the `passed` table count only results whose tree is current; a Check that changes the
tree fails. `review-pass` becomes a `response` Check and the review's first `passed` row, evaluated through A2;
`repeat` is a recorded fact (its route is E8). `CHECK_NAMES`, `checkOutcome`, `gate-failed(test)` and `red-failed`
go: a final failure is the `failed` table's Outcome, else the engine Outcome `failed`, with the Terminal Reason
rendered from the Check signal. A failed red ending at an end leaves its work in place (U10).
- Goldens: failed red, test-fix exhausted, review ok without evidence. Glossary: Signal gains the Check signal. Doctor: none
  until E7.

### E6. Claim tokens, recovery and `pass`

Q3, Q3d, S3, T4, W1, R1a, U7, R9d. Claim tokens are `{ requires }` or `{ stop }`, replacing `STOP_CLAIMS` and the
claim rows of `outcome.mjs` (the fixed integrity, harness and parse rows stay). `recover: { max, brief }` per
Procedure replaces the still-green and test-fix Phases, `WHEN`, `lineage` and their options: the agent's Session
resumes with the recovery Brief and each failing Check's section, then every Check runs again. Recoverable failure
modes per kind and `recoverable: false`; `pass` is matchable. The decision order (fixed rows, `stopped`, then
`passed` or `failed`, `otherwise`, token or `failed`). `requireTestPass` goes from Procedures and Events.
- Goldens: still-green, test-fix, blocked after still-green and after test-fix; the `requireTestPass` case is
  deleted. Glossary: pass, Claim token `requires`. Doctor: none until E7.

### E7. Procedures come from config; admission runs the validator

D3, P3 (partly), R3b, U12, Q2, R3. `lib/procedures.mjs`'s table leaves code: Procedures are config in the shape of
A5, held for now by the defaults Layer (the one interim exception to P2, removed in C2), with their Briefs, schemas and
Personas loaded from the Layer that declares them (lifting the shipped-Personas shortcut in `config.mjs` and
`interpreter.mjs`). `tests:` and `access:` replace the remaining literal checks; Test Immutability stays a fixed row.
`gg run` admission calls A5 and A6, so `gg run` and `gg doctor` reject the same configs. A test asserts the
interpreter names no Procedure or Action.
- Goldens: behaviour unchanged; Config Hash inputs change. Glossary: Procedure updated. Doctor: the shipped Flow
  printed in full, with no errors.

### E8. `maxVisits`, the Action Cap and `repeat` routing

T5, R4d, I3, U5. Vertex `maxVisits` with its `exhausted` target, the Ticket's Action Cap, and the effective target of
a route after edge and Visit exhaustion. The shipped review routes `repeat` (edge `max: 1`), removing the
`shortcut:` in `interpreter.mjs`.
- Goldens: a new trace for a repeat routed to an escalation Vertex, and one for a `maxVisits` exhaustion. Glossary:
  Action Cap updated. Doctor: bounds per cycle.

### E9. Rescue Refs for work routed to another Vertex

R5a, R5c–e, U5, W3; the Rescue Ref piece of grey-goo-ri issue #68 (ADR 0011's layout). A failed or stopped write
Vertex whose effective target is another Vertex rescues its work to `refs/gg/rescue/<digest of the Action Marker>`
(never overwriting), resets through the write-ahead `reset`, adds a History item, and exposes `<vertex>.rescue` as
`{ ref, diffStat, output }`. Anything gg's records do not prove is the agent's holds.
- Goldens: a failed fix rescued into an escalation Vertex; the same failure left in place once the escalation is
  exhausted. Glossary: Rescue Ref output. Doctor: unchanged (A6 already prints it). #68 is rewritten to reuse this.

### C1. `gg init` writes the example; this repository gets its own Flow

P1b–c, P3, U8, R9, U3, U11, W6–W10. `gg init` writes the example (Flow, Agents with `senior`, Procedures, Briefs,
Personas, schemas, `testPaths`) into `.agents/gg/`, refusing to overwrite an existing Layer. `examples/*.json` gain
`senior`. One test proves the example passes admission and pins its golden trace; the tests that load the shipped
Flow today (`config`, `defaults`, `flow`, `procedures` and `run` tests) move to fixture Flows. This repository's
`.agents/gg/gg.json` gets its Flow from `gg init`.
- Goldens: the example's trace. Glossary: none. Doctor: the example printed in full.

### C2. The defaults Layer ships no Flow

P1a, P2, P3. `defaults/gg.json` loses `agents`, `flows` and `procedures`; `defaults/personas` and the template files
go. `flows` or `procedures` in the defaults or user Layer is a load error naming the file. Without a Flow, preflight
and `gg doctor` fail naming `gg init`.
- Goldens: none. Glossary: none. Doctor: the missing-Flow failure.

## What is not sliced here

- ADR 0014 (handoff step 2) and the grey-goo-ri issue #23 additions (step 4) are planning work, done before filing
  and when #23 is next touched.
- Option 3, V2 scenario runs (grey-goo-ri issue #98), migration of old records (R7d).

## Questions for the owner

1. **Engine strategy.** Recommended: change the interpreter in place, one serial ticket at a time, regenerating
   goldens each time (above). The alternative is a second Visit runner for data Procedures beside today's, with a
   switch ticket at the end: fewer golden regenerations, but two marker formats in Reconciliation and a big-bang
   switch.
2. **`ajv` (A3).** Recommended: stay hand-rolled. User schemas are limited to the strict subset Claude and Codex
   structured outputs accept, which gg must type anyway for rule paths; `ajv` would validate more than gg may accept
   and add the first dependency.
3. **Template syntax (A4).** Recommended: a small Mustache subset (`{{name}}`, `{{#list}}…{{/list}}`, `{{^name}}…{{/name}}`
   for absent), no helpers or logic, hand-written. Or leave it to the A4 ticket.
