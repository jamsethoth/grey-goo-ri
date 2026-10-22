# User-defined Procedures: slicing (step 7)

Draft, 2026-10-22; the owner accepted its approach and the audit folds the same day. It slices option 1 as decided in
[user-defined-procedures-decisions.md](user-defined-procedures-decisions.md) and shown in
[user-defined-procedures-example-flow.md](user-defined-procedures-example-flow.md). It replaces the round-1 S1–S6
proposal. Slice ids here (A1, E1, C1) are local to this file. Nothing is filed until the owner approves.

## Shape

Twenty-two tickets, sub-issues of one Epic, in three tracks:

- **A, groundwork**: pure modules and config, built and tested against fixtures. Only A1 and A4 touch the interpreter.
- **E, engine**: E0 fixes and splits the interpreter first (from the 2026-10-21 audit, below); then interpreter tickets, strictly serial (request section 6: one interpreter-touching ticket in flight).
  Each changes main's shipped Flow in place and regenerates the golden traces it names, so the suite is green after
  every ticket and no second engine lives beside the first.
- **C, cutover**: `gg init` writes the example, then the defaults Layer stops shipping a Flow (U8); C4 adds `--flow`
  (X2); C3 then clears the rest of the 2026-10-21 audit.

The engine order puts the Flow-level changes (red and green Vertices, ends, inputs) before Procedures move into
config, so that when E7 wires the validator into admission the shipped Flow is already in its final shape.

Prerequisite, outside the Epic: ADR 0014 and these research files merge to main first (handoff step 2).

Every ticket follows the existing format (Problem, Goal, In scope, Out of scope, Definition of done, Tests to write
first, QA hints, Notes). The Epic notes R7c: delete any real `.git/gg/gg.db` between slices, since no versions bump
before grey-goo-ri issue #23.

## Order

| Id | Ticket | Interpreter | Depends on |
|---|---|---|---|
| A1 | `testPaths` is required and feeds every consumer | yes, small | E0 |
| A2 | Rule tables: the first-match evaluator and the analyser | no | none |
| A3 | Response schemas as data: the strict subset and typed reference paths | no | none |
| A4 | Templates for Briefs, the PR body and comments | yes, call sites | A1 |
| A5 | The Flow shape, its validator and `gg doctor` | no | A2, A3 |
| A6 | Graph analysis: routing, bounds, publishing, commits, inputs | no | A5 |
| A7 | The approval protocol: Approval Request, timeline read and consumption | no | none |
| E0 | Audit fixes, then split the retry engine and Terminals out of the interpreter | yes | none |
| E1 | Red and green on separate Vertices | yes | A4 |
| E2 | Action ids and the Recovery Number | yes | E1 |
| E3 | Ends, Flow routes and the `publish` Vertex | yes | E2, A4 |
| E4 | Vertex inputs | yes | E3 |
| E5 | Checks as declared Actions; the engine Outcome `failed` | yes | E4, A2 |
| E6 | Claim tokens, recovery and `pass` | yes | E5 |
| E7 | Procedures come from config; admission runs the validator | yes | E6, A6 |
| E8 | `maxVisits`, the Action Cap and `repeat` routing | yes | E7 |
| E9 | Rescue Refs for work routed to another Vertex | yes | E8 |
| E10 | The `await-approval` Action | yes | E9, A7 |
| C1 | `gg init` writes the example; this repository gets its own Flow | no | E10 |
| C2 | The defaults Layer ships no Flow | no | C1 |
| C4 | `gg run --flow` selects a declared Flow | no | C2 |
| C3 | Audit cleanup: copies, dead code, names and test hygiene | yes | C4 |

Serial chain: E0 → A1 → A4 → E1 → … → E10, encoded as dependencies. A2, A3, A5, A6 and A7 run beside it. grey-goo-ri
issue #23 is marked blocked by C2. C4 and C3 change no record or Event shape, so they do not block #23; but it touches the
interpreter and so does not run while #23 is in flight.

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
- Tests: a test file outside today's globs is covered by Test Immutability, rollback and diffStats; Test Immutability
  and diffStats agree on every path, case included (audit 4: today `spec/` and `fixtures/` disagree, and only the
  stats regex ignores case); the three preflight failures; the user-Layer load error.
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

V1, R13a, R13c, R13e; carries the owner's decision: no `ajv`. `briefs.assertStrict` and
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
byte-identical output, except that `FIX ROUND` becomes `FIX VISIT` (audit 19) and `blockedComment` and
`diagnosisComment` become one template (audit 10). The syntax is a Mustache subset (question 3): `{{name}}`,
`{{#x}}…{{/x}}` (once per item, or once if present), `{{^x}}…{{/x}}` (absent or empty); no HTML escaping, partials or
helpers. Truncation, JSON, numbering and redaction happen in gg before a value reaches a template. `briefs.styleBlock`
(the writing-style section, called today only by tests) is decided here: template text in the example's Briefs, a
named context value, or deleted with its tests.
- Tests: byte-identical output for every ported builder; a context value not named is never computed.
- Goldens: unchanged. Glossary: none. Doctor: none yet.

### A5. The Flow shape, its validator and `gg doctor`

V1, U13, R6d, R13e, W2, W3, T6, U7, U12, R3b, W1, P5d. `lib/flow.mjs` validates the final shape (Agents, Procedures
with Action ids, `do:` kinds, Check kinds and parameters, Claim tokens, `tests`, `access`, `recover`, the three tables
and `otherwise`; Flows with `plan` (required, `null` for none, X2b), `entry`, `routes`, Vertices, `inputs`, `route`, `maxVisits`, `exhausted`) and produces the
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

### A7. The approval protocol: Approval Request, timeline read and consumption

X1, ADR 0003, request 3.5. `lib/approval.mjs` builds the Pending Instance and the Approval Digest (branch HEAD, ticket
body revision, full config hash), reads the issue's event timeline for the Await Label event and the Decide Label
events after it, checks each actor's permission (write or higher, or the optional `approvers` list) and returns one
of: consume (exactly one authorised Decision, matching digest), stale, ambiguous, or missing. No interpreter change.
- Tests: a decision before the request is ignored; an undone decide label is ignored; a triage-only actor is ignored;
  two surviving decisions are ambiguous; a changed branch HEAD, ticket body or config hash is stale.
- Goldens: none. Glossary: none (the approval terms exist). Doctor: none.

### E0. Audit fixes, then the interpreter split

Audit findings 1, 2, 14 and 5, all checked on main. (1) The plain `record.save` path (`lib/record.mjs:139`) wraps its
error in `RecordSaveError`, so a failed busy or idle save is fatal and never saved again; `saveRetry` goes. (2)
`lockGuard` checks `runState.stop` as `cooldown` already does (#85), so a remote write waiting for the repo lock does
not write after a run stop. (14) The test GitHub fake keys labels by issue, so a sibling's needs-human no longer looks
like a human override. (5) Then, with no behaviour change, the retry engine (`reserveRetry` through `sideEffect`)
moves to `lib/effects.mjs` and `hold`, `abandon`, `fault`, `decide` and the Terminal functions to `lib/terminal.mjs`,
both added to the AGENTS.md Layout table.
- Tests: a failed busy or idle save stops saving (beside `test/interpreter.test.mjs:1670`); a sibling's run stop during
  a lock wait ends the Ticket at needs-human with no GitHub write.
- Goldens: unchanged. Glossary: none. Doctor: none.

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
marker. From the audit: one `actionKeyOf(at)` replaces the three ways the retry key is built and `outcome.resolve`
returns the retry kind (6); the PR's provenance table counts one call per Attempt from each Attempt's `usage.delta`,
so a resumed Session is not counted twice (3); the copied `markerOf` test helper moves to `test/support/` (16).
- Goldens: every trace (markers). Glossary: Action id, Action identity, Recovery Number. Doctor: none.

### E3. Ends, Flow routes and the `publish` Vertex

R11, R12, T1a, T2, T3, U6, W4, W5, W9, P5c, Q3f, Q6. `end: ready-for-qa | needs-human | needs-replan` replaces the
Terminals; `then` goes; the Flow's default `routes` and `"*"`; `harness-timeout`, `harness-transient` and
`harness-unparsed` become routable, defaulting to `end: needs-human`; a stop token's comment template replaces the end
comment and goes to the Epic too at `needs-replan`; `misscoped` reaches the planner through the Flow's default route.
A `publish` Vertex (code Procedure: the test Check, `pr-upsert`, `pr-ready`) replaces `done`; `pr-ready` runs only if
the Check's tree equals the published commit's and the worktree is clean, with the target kept through retries and
Reconciliation. `comment` takes `target`. The `TERMINALS` copies in `interpreter.mjs` and `reconcile.mjs` become
one definition of the end states (audit 8).
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
rendered from the Check signal. A failed red ending at an end leaves its work in place (U10). The two integrity
rollback blocks in `runVisit` become one (audit 7).
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
`{ ref, diffStat, output }`. Anything gg's records do not prove is the agent's holds. First, `crashFs` picks its
crash by path rather than by call count (audit 20), so reordering a restore cannot silently move a crash test.
- Goldens: a failed fix rescued into an escalation Vertex; the same failure left in place once the escalation is
  exhausted. Glossary: Rescue Ref output. Doctor: unchanged (A6 already prints it). #68 is rewritten to reuse this.

### E10. The `await-approval` Action

X1. `do: await-approval` with `decisions`, last in a Procedure with no agent Action. Reaching it writes the Approval
Request (Pending Instance to the record, earlier await and decide labels removed, the Await Label, one comment) as
write-ahead Actions and ends the run for the Ticket, which is Awaiting. A later run, under the ticket lock, consumes
the Decision through A7 as a write-ahead Action (record first, then the decide label removed); the Decision is the
Visit's Outcome. Stale, ambiguous or missing retire and re-request. Reconciliation resumes a crash at every step
without reading the timeline twice. A5 and A6 treat `decisions` as Outcomes and check that their labels exist.
- Goldens: the request posted and the run ended; an approval consumed and routed onward; a `rejected` routed back;
  a stale digest re-requested; crashes before and after the decide label's removal (request 3.5's list).
- Glossary: Approval Vertex redefined, Vertex loses its kinds. Doctor: each approval Vertex's decisions and routes.

### C1. `gg init` writes the example; this repository gets its own Flow

P1b–c, P3, U8, R9, U3, U11, W6–W10. `gg init` writes the example (Flow, Agents with `senior`, Procedures, Briefs,
Personas, schemas, `testPaths`) into `.agents/gg/`, refusing to overwrite an existing Layer. `examples/*.json` gain
`senior`. `checks.DEFAULT_TEST_GLOBS` is what `gg init` writes, so the audit's unused-export cleanup keeps it. One test proves the example passes admission and pins its golden trace; the tests that load the shipped
Flow today (`config`, `defaults`, `flow`, `procedures` and `run` tests) move to fixture Flows. This repository's
`.agents/gg/gg.json` gets its Flow from `gg init`. The example writes `plan: null` explicitly (X2b).
- Goldens: the example's trace. Glossary: none. Doctor: the example printed in full.

### C2. The defaults Layer ships no Flow

P1a, P2, P3. `defaults/gg.json` loses `agents`, `flows` and `procedures`; `defaults/personas` and the template files
go. `flows` or `procedures` in the defaults or user Layer is a load error naming the file. Without a Flow, preflight
and `gg doctor` fail naming `gg init`.
- Goldens: none. Glossary: none. Doctor: the missing-Flow failure.

### C4. `gg run --flow` selects a declared Flow

X2. `gg run <n> --flow <name>` runs a Flow the repository Layer declares, else `default`; an unknown name fails
preflight listing the declared Flows; a resumed Execution keeps the Flow pinned in its record. The `shortcut:` in
`lib/run.mjs` that tells a standalone Ticket to edit the default Flow's `plan` names a null-plan Flow to pass with
`--flow` instead.
- Goldens: none. Glossary: none. Doctor: lists the declared Flows.

### C3. Audit cleanup: copies, dead code, names and test hygiene

The audit findings no earlier slice absorbs, each re-checked against main when the ticket starts, since the E slices
rewrite much of the cited code. No behaviour change.
- Copies (8): one `sha256`, one default `clock`, one `git` stdout-trim wrapper; `gh.postComment` returns `{ id, url }`
  from the API's JSON, dropping the comment-id regex; one needs-human cursor, if E3 left any.
- One "keep the last whole lines" cutter with a fallback option, serving `checks.evidence` and `render.publicTail` (9).
- The `?? 'gg'` and `= 'gg'` label prefix fallbacks go, except the one in `labels()` (11).
- `addWorktree` compares paths with `paths.pathKey`, so only Windows ignores case (12).
- Code with no caller in `lib/`, `bin/` or `scripts/` is deleted with the tests that exist only for it (13). The
  owner's rule: code ported from feature-flow ahead of its slice is of doubtful use, so `gg work`, `publish` and
  `plan` port what they need when they land. That is `github.openPrs`, `closePr`, `createIssue` and
  `inProgressSince`; `git.deleteRemoteBranch`, `commitAll`, `discardChanges`, `ticketBranches`, `discardBranch` and
  `cleanupMerged`, with `isDirty`, `hasUnpushed`, `removeWorktree` and the `git.mjs` → `github.mjs` import that only
  they use; `render.ticketBody` and `epicBody`. Unused `export`s are dropped, `DEFAULT_TEST_GLOBS` excepted (C1).
  `record.createEpicRecord` is gg's own (Epic Record, request 3.5), not a port, and stays for planning.
- Fixtures restore the previous GitHub transport after `setGh` (15).
- The copied test helpers (`sh`, `loadTicket`, `newExecution`, the bare-origin and clone setup, the fake `a + b`
  runner) move to `test/support/` (16).
- `admit()`'s corrupt-record branch becomes its own function, and `runTicket` reuses `admit`'s skipped-but-needs-human
  logic (17).
- One exec timeout-note helper; `[ff: …]`, `FF_CMD` and `FF_TEST_*` become `gg` names (18). `Feature-Flow-Stage:`
  stays (request doc line 479).
- `record.proof` takes a glossary name; the JSON-key sorter in `config.mjs` stops sharing `canonical` with
  `paths.canonical` (19).
- Fixtures in `git.test.mjs`, `fake-harness.test.mjs` and `harnesses-contract.test.mjs` remove their temp directories
  (20).
- The left-out items: `record.load`, `record.save` and `reconcile.humanOverride` lose `async` if still synchronous;
  one rule for an error with an empty message; one reader for the GitHub `?.nodes` shape.
- Tests: the existing suite, plus one case for `addWorktree` on a case-sensitive platform and one that a second
  fixture's `setGh` does not reach the first.
- Goldens: unchanged. Glossary: the name chosen for `record.proof`, if new. Doctor: none.

## What is not sliced here

- ADR 0014 (handoff step 2) and the grey-goo-ri issue #23 additions (step 4) are planning work, done before filing
  and when #23 is next touched.
- Option 3, V2 scenario runs (grey-goo-ri issue #98), migration of old records (R7d).

## Decided (2026-10-22)

1. **Engine strategy**: the interpreter changes in place, one serial ticket at a time, regenerating goldens each time.
2. **`ajv` (A3)**: no `ajv`. Validation stays hand-rolled over the strict subset Claude and Codex structured outputs
   accept.
3. **Template syntax (A4)**: the Mustache subset described in A4, hand-written.

## The 2026-10-21 audit

`C:\dev\ff-review-work\grey-goo-ri-audit-2026-10-21.md` read `ccfe163`. Every finding was re-checked on main at
`bd60df9` on 2026-10-22; all hold, with these corrections:

- 2: `cooldown` already checks `runState.stop` (#85); only `lockGuard` does not.
- 5: `interpreter.mjs` is 967 lines, not 911.
- 13: `interpreter.PROTECTED_PATHS` is imported by `test/interpreter.test.mjs:2451`; `DEFAULT_TEST_GLOBS` and
  `DEFAULTS_DIR` are used inside their own modules, so only their `export` is unused. `DEFAULT_TEST_GLOBS` stays
  exported for C1.
- 17: `admit()` is about 110 lines now (`lib/run.mjs:214`).

Where each finding goes:

| Findings | Where |
|---|---|
| 1, 2, 5, 14 | E0 |
| 4 | A1 |
| 10, 19 (`FIX ROUND`) | A4 |
| 3, 6, 16 (`markerOf`) | E2 |
| 8 (`TERMINALS`) | E3 |
| 7 | E5 |
| 20 (`crashFs`) | E9 |
| 8 (rest), 9, 11, 12, 13, 15, 16 (rest), 17, 18, 19 (rest), 20 (temp dirs), the three left-out items | C3 |
