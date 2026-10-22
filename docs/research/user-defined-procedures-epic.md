# User-defined Procedures: Epic and ticket drafts

Draft text for filing, 2026-10-22, from [user-defined-procedures-slices.md](user-defined-procedures-slices.md).
**Filed 2026-10-22** as the Epic grey-goo-ri issue #101 and its sub-issues: A1–A7 are grey-goo-ri issues #102–#108, E0 is #109, E1–E10 are #110–#119, C1 is #120, C2 is #121, C4 is #122 and C3 is #123. The issues are now the
authority for ticket text; this file keeps the drafts as filed. On filing:

- The research files, ADR 0014 and the request amendments merge to main first (a docs PR from this branch), since
  every ticket cites them and ff runs from a checkout of main.
- The Epic gets `ff:epic`; each ticket gets `ff:ticket`, becomes a sub-issue, and is marked blocked by the issues in
  its "Depends on" line. `#EPIC` and the slice ids are replaced by issue numbers.
- grey-goo-ri issue #23 is marked blocked by C2. Issue #68 is rewritten to reuse E9's Rescue Ref (separate approval).

---

## Epic: User-defined Procedures: Procedures are data, and the repository owns its Flow

Option 1 of the user-defined Procedures design (ADR 0014): Procedures become data declared in the repository Layer,
built only from gg's own Actions, Check kinds and fixed integrity rows; red and green become separate Vertices;
Terminals become ends; human approval becomes an Action; and gg stops shipping a Flow, writing an example with
`gg init` instead. The interpreter then names no Procedure, Action or Check.

Read first: `AGENTS.md`, then ADR 0014 (`docs/adr/0014-procedures-are-data.md`), the request
(`docs/requests/node-harness-dag.md`, as amended), `GLOSSARY.md`, and in `docs/research/`:
`user-defined-procedures-decisions.md` (the authority; its reading guide says which decision amends which),
`user-defined-procedures-example-flow.md` (the example `gg init` writes, in full) and
`user-defined-procedures-slices.md` (why the tickets are cut and ordered this way). A ticket that cites a decision id
(R5a, T4, X1) means that entry of the decisions file.

### Decisions taken in planning

- **Order.** One interpreter-touching ticket in flight at a time (request section 6), encoded as dependencies: E0,
  A1, A4, then E1 to E10 in order. A2, A3, A5, A6 and A7 touch no interpreter code and may run beside them. C1, C2,
  C4 and C3 come last.
- **In place.** The interpreter changes in place. Each engine ticket moves main's shipped Flow one step toward the
  example and regenerates the golden traces it names; the suite is green after every ticket.
- **Shapes before the freeze.** Record and Event versions stay at their current values (R7); grey-goo-ri issue #23
  freezes them after C2. Between tickets, delete any real `.git/gg/gg.db` rather than migrate it.
- **No new dependencies.** Schema validation stays hand-rolled over the strict subset Claude and Codex structured
  outputs accept (no `ajv`). Templates use a hand-written Mustache subset (A4).
- **Definition of done for engine tickets.** The golden traces the ticket names are regenerated and reviewed, and
  the glossary entries it names land with it.
- **Code ported ahead of its slice** from feature-flow, with no caller, is deleted rather than kept (C3).

### Out of scope

- Option 3 (user Actions as executables with `confirm`), after grey-goo-ri issue #23.
- Scenario runs (grey-goo-ri issue #98), migration of old records (R7d), plan approval at the Epic level, and
  `gg work approve`.

Tickets are sub-issues of this epic. Run with `ff run <this issue number>`.

---

## A1. `testPaths` is required in the repository Layer and feeds every test-path consumer

Part of #EPIC.

### Problem
What counts as a test file decides what an agent may not change, but gg holds two disagreeing lists:
`checks.DEFAULT_TEST_GLOBS` (Test Immutability, rollback) covers `fixtures/` and not `spec/`, while
`events.diffStats`' own `TEST_PATH` regex covers `spec/` and not `fixtures/`, and only the regex ignores case (audit
finding 4). An agent can change `spec/*.mjs` without tripping Test Immutability. A repository cannot state its own
test paths at all.

### Goal
The repository Layer declares `testPaths`, required like `commands.test`, and that one pinned value feeds every
consumer (P4, U9, U15, T12).

### In scope
- `testPaths`: a non-empty list of glob strings in `<repo>/.agents/gg/gg.json`. A `testPaths` key in the defaults or
  user Layer is a load error naming the file, as `commands` is (ADR 0013).
- Preflight rejects a missing or empty list or a non-string entry, naming the repository Layer file, beside
  `commandProblems`.
- The value is pinned with the Visit snapshot and enters the Config Hash.
- Consumers: Test Immutability, the rollback set and `TEST_PATHSPECS`, the review's changed-test list, and
  `events.diffStats`, whose `TEST_PATH` regex goes. Matching follows one case rule everywhere.
- Excluding dependency directories (`node_modules`, `site-packages`) stays in code.
- This repository's `.agents/gg/gg.json` declares today's `DEFAULT_TEST_GLOBS`.

### Out of scope
- `gg init` writing it (C1). Protecting `package.json` scripts (grey-goo-ri issue #96).

### Definition of done
- [ ] A test file outside today's globs, listed in `testPaths`, is covered by Test Immutability, rollback and
  `diffStats`.
- [ ] Test Immutability and `diffStats` classify every path the same way, case included.
- [ ] Missing, empty and malformed `testPaths` fail preflight naming the file; a user-Layer `testPaths` is a load error.
- [ ] Golden traces unchanged.
- [ ] `npm test` passes.

### Tests to write first
- test/config.test.mjs: `a testPaths key in the user Layer is a load error naming the file`;
  `testPathsProblems names a missing, empty or malformed testPaths`.
- test/checks.test.mjs: `test immutability covers a declared test path outside the default globs`.
- test/events.test.mjs: `diffStats counts exactly the files Test Immutability treats as tests`.
- test/run.test.mjs: `preflight rejects a repository Layer without testPaths`.

### Notes
Depends on E0 (serial interpreter work). Glossary: none.

---

## A2. Rule tables: a first-match evaluator and an exact analyser

Part of #EPIC.

### Problem
Procedures decide their Outcome through first-match rule tables (Q4, R8). Admission must prove a table has no
unreachable or never-firing row and warn on partial overlaps, exactly, without a solver.

### Goal
One pure module evaluates a table against an input and analyses a table over its declared domain.

### In scope
- Fields: enum, boolean and integer, by dotted path (R13a); the value `absent` for an absent optional input (T10).
  Integer conditions compare with `<`, `<=`, `>`, `>=`, `=` against constants.
- Evaluation: first match, returning the row index or none.
- Analysis (R8): each row is a box of per-field value sets; subtract every box above a row. Empty remainder: an
  error (unreachable or never fires). Partial overlap with an earlier row: a warning with one example input. Report
  one example input that falls to the default.
- Hand-written, no dependency (ADR 0001). A new module, added to the AGENTS.md Layout table.

### Out of scope
- Reading schemas or configs (A3, A5); runtime reachability (grey-goo-ri issue #98).

### Definition of done
- [ ] Analysis agrees with brute-force enumeration on generated tables.
- [ ] The example review `passed` table (example-flow doc) yields exactly its three intended overlap warnings (U4).
- [ ] `npm test` passes.

### Tests to write first
- test/rules.test.mjs: `first match picks the earliest matching row`; `an absent input matches no condition on its
  fields`; `a row covered by earlier rows is an error`; `a partial overlap is a warning with an example input`;
  `analysis agrees with brute force on generated tables`; `the example review table warns three times`.

### Notes
Depends on nothing. Glossary: Rule Table.

---

## A3. Response schemas as data: the strict subset and typed reference paths

Part of #EPIC.

### Problem
Response schemas are constants in `lib/briefs.mjs`. User Procedures bring their own schemas, and admission must type
every reference into them (rule fields, `pick`, `response` Check fields, inputs; R13e).

### Goal
gg accepts any repository schema inside a declared strict subset, and can type a dotted path through it.

### In scope
- `assertStrict` accepts only the subset: `object` with every property required and `additionalProperties: false`,
  `array` with `items`, `string`, `boolean`, `integer`, `enum`. Any other keyword is an error naming the file and path.
- `validateResponse` covers the same subset.
- A Claim-enum check: the schema's `claim` enum equals the declared tokens, with no case-only differences (V1).
- `fieldType(schema, path)`: the kind at a dotted path (enum with its values, boolean, integer, string, list of a
  kind, object), or an error.
- No `ajv` (owner's decision).

### Out of scope
- Loading schema files from a Layer (E7).

### Definition of done
- [ ] Each schema in the example (example-flow doc) passes; one with an unsupported keyword fails naming it.
- [ ] `npm test` passes.

### Tests to write first
- test/briefs.test.mjs: `a schema keyword outside the strict subset is rejected with its path`;
  `the claim enum must equal the declared tokens`; `fieldType types nested objects and arrays of objects`.

### Notes
Depends on nothing. Glossary: none.

---

## A4. Templates for Briefs, the PR body and comments

Part of #EPIC.

### Problem
Briefs, the PR body and comments are built in code (`briefs.*Brief`, `render.prBody`, `render.blockedComment`,
`render.diagnosisComment`). A repository that owns its Procedures must own their Briefs (P3), so these become files.

### Goal
One template mechanism renders every Brief, the PR body and every comment from files, with output identical to
today's builders except the named changes.

### In scope
- Syntax, a hand-written Mustache subset: `{{name}}`; `{{#x}}…{{/x}}` renders once per list item, or once when `x` is
  present and not empty; `{{^x}}…{{/x}}` renders when `x` is absent or empty. Dotted names; inside a list section,
  an item's fields. No HTML escaping, partials or helpers.
- Names resolve to gg's own context (the Ticket, base, branch diff, Declared Commands, History, provenance, Action
  Marker, changed test files, Terminal Reason, end name; U1, W6), computed only when a template names it; the
  Vertex's own outputs; and `inputs` (wired in E4). An absent value renders empty.
- Truncation, JSON rendering, numbering and redaction happen in gg before a value reaches a template.
- Today's builders become template files beside the shipped Personas: red, green, still-green, test-fix, fix,
  review, the nudge, the PR body, the review comment, and one stop comment replacing `blockedComment` and
  `diagnosisComment` (audit finding 10). `FIX ROUND` becomes `FIX VISIT` (finding 19).
- `briefs.styleBlock` (called today only by tests): becomes template text in the Briefs, or a named context value,
  or is deleted with its tests. Decide here.

### Out of scope
- Brief files in the repository Layer (E7). Recovery Brief composition (E6).

### Definition of done
- [ ] Every ported template renders byte-identical to its builder for the existing fixtures, except the named changes.
- [ ] A context value no template names is never computed.
- [ ] Golden traces unchanged apart from `FIX VISIT`.
- [ ] `npm test` passes.

### Tests to write first
- test/render.test.mjs: `a section renders once per list item`; `an inverted section renders for an absent value`;
  `an unnamed context value is not computed`; `the stop comment renders the blocked and replan cases`.
- test/briefs.test.mjs: `each Brief template matches its builder's output`.

### Notes
Depends on A1 (serial interpreter work: the Brief call sites change). Glossary: none.

---

## A5. The Flow shape, its validator and `gg doctor`

Part of #EPIC.

### Problem
`lib/flow.mjs` expands Agents and checks two names. Admission must check everything decidable from the
configuration before any agent runs (V1), and `gg doctor` is not implemented.

### Goal
One validator turns the final configuration shape into a Resolved Flow plus errors and warnings, and `gg doctor`
prints it.

### In scope
- The shape (example-flow doc): `agents`; `procedures` with Action ids, `do:` kinds, Check kinds and parameters,
  Claim tokens, `tests`, `access`, `recover`, the three tables and `otherwise`; `flows` with `plan` (required,
  and `null` until Epic planning lands; X2b, X2d), `entry`, `routes`, Vertices (`use`, `procedure`, `inputs`, `route`, `maxVisits`, `exhausted`).
- Checks: syntax and name resolution; Action ids unique per Procedure with no `:` or whitespace (R6d); Claim enum
  equals tokens (A3); every named command declared (U13); every reference path typed through A3 (R13e, W2, W3); list
  `from` sources of one type (T6); `tests: named` reads a list of strings (R13d); tables through A2; `access:
  read-only` caps the Agent (U12).
- `gg doctor` prints, per Vertex: effective Procedure, access, `tests`, Checks, tables, reachable Outcomes, inputs
  and their sources. It exits non-zero on any error.
- Not yet called by `gg run` (E7).

### Out of scope
- Graph checks (A6). The `await-approval` decisions (E10).

### Definition of done
- [ ] Each check has a failing fixture Flow with its message.
- [ ] The example Flow passes, and its `gg doctor` output is pinned.
- [ ] `npm test` passes.

### Tests to write first
- test/flow.test.mjs: `an undeclared command is an error naming the Check`; `a reference to a field the schema lacks
  is an error`; `a list input with sources of different types is an error`; `an Action id with a colon is an error`;
  `the example Flow resolves with no errors`.
- test/doctor.test.mjs: `gg doctor prints each Vertex's Procedure, Checks, tables and Outcomes`;
  `gg doctor exits non-zero on an error`.

### Notes
Depends on A2 and A3. Glossary: Resolved Flow updated.

---

## A6. Graph analysis: routing, bounds, publishing, commits and inputs

Part of #EPIC.

### Problem
The validator (A5) checks each Vertex alone. The rules that make a Flow safe are about paths: every Outcome routed,
every cycle bounded, nothing published unchecked, every input produced.

### Goal
The validator checks the graph, per Outcome, and `gg doctor` prints where each Outcome goes.

### In scope
- Every Outcome a Vertex can produce is routed by the Vertex or the Flow's `routes`, `"*"` included (R12b, T3); the
  engine Outcomes (`failed`, `harness-*`) default to `end: needs-human` (R12c).
- Every cycle is bounded by an edge `max`, a `maxVisits` or the Action Cap (I3).
- `pr-ready` only in a Vertex requiring a Check (R11d); every path to `end: ready-for-qa` runs `pr-ready` (R11e).
- A write Vertex commits on every passing path, and its committing token requires a Check (S2, T1c).
- A required input is produced on every path to its consumer, per Outcome (Q7, S4); an optional one on some path (T9).
- Unreachable Vertices are warned.
- `gg doctor` shows which Outcomes fall to `"*"` and which to the engine default (R12d), and where each failure's
  work goes, rescued or left in place, by the effective target (U5).

### Out of scope
- Runtime reachability (grey-goo-ri issue #98).

### Definition of done
- [ ] One failing fixture per rule.
- [ ] The example's admission summary ("What admission sees" in the example-flow doc) is reproduced.
- [ ] `npm test` passes.

### Tests to write first
- test/flow.test.mjs: `an unrouted Outcome is an error`; `an unbounded cycle is an error`; `a path to ready-for-qa
  without pr-ready is an error`; `a passing write path without a commit is an error`; `a required input missing on
  one path is an error`; `an optional input produced on no path is an error`.

### Notes
Depends on A5. Glossary: none.

---

## A7. The approval protocol: Approval Request, timeline read and consumption

Part of #EPIC.

### Problem
A human approval inside a Flow (X1) needs ADR 0003's protocol: a request bound to a digest, and a Decision read from
the issue's event timeline, which no one can edit. `lib/approval.mjs` is an empty stub.

### Goal
A pure module builds Approval Requests and reads a timeline into exactly one verdict.

### In scope
- The Pending Instance id (execution, vertex, visit, nonce) and the Approval Digest (branch HEAD, ticket body
  revision, full config hash), as request 3.5 says.
- Reading the timeline: the Await Label event matching the instance is the request time; Decide Label events after
  it that no later unlabel undid; each actor's permission is write or higher, or the actor is in `approvers`.
- The verdict: consume (one authorised Decision, matching digest), stale (digest differs), ambiguous (more than one),
  missing (no record or instance), or waiting.

### Out of scope
- Labels, comments and the record (E10). Plan approval at the Epic level.

### Definition of done
- [ ] Each verdict has a fixture timeline.
- [ ] `npm test` passes.

### Tests to write first
- test/approval.test.mjs: `a decision before the request is ignored`; `an undone decide label is ignored`; `a
  triage-only actor is ignored`; `two surviving decisions are ambiguous`; `a changed branch HEAD makes the request
  stale`; `one authorised decision with a matching digest is consumed`.

### Notes
Depends on nothing. Glossary: none (the approval terms exist).

---

## E0. Audit fixes, then split the retry engine and Terminals out of the interpreter

Part of #EPIC.

### Problem
The 2026-10-21 audit (`C:\dev\ff-review-work\grey-goo-ri-audit-2026-10-21.md`, re-checked on main 2026-10-22) found
two correctness bugs in the code every later ticket builds on:
- A plain `record.save` (`lib/record.mjs:139`) throws the raw SQLite error, so `bracket()` treats a failed busy or
  idle save as non-fatal and saves the same record again (finding 1).
- `lockGuard` does not check `runState.stop`, so a remote write waiting for the repo lock still writes after another
  Ticket stops the run (finding 2; `cooldown` already checks it, #85).
The test GitHub fake keeps one label set for every issue, which can hide the second (finding 14). And
`lib/interpreter.mjs` is 967 lines doing five jobs (finding 5).

### Goal
Both bugs are fixed with regression tests, then the retry engine and the Terminal code move to their own modules
with no behaviour change.

### In scope
- The plain save wraps its error in `RecordSaveError`; `saveRetry` goes.
- `lockGuard` checks `runState.stop` and ends normal work at needs-human; Terminal reporting stays exempt.
- `fakeGh` keys labels by issue number.
- Then: `reserveRetry` through `sideEffect` move to `lib/effects.mjs`; `hold`, `abandon`, `fault`, `decide` and the
  Terminal functions to `lib/terminal.mjs`. Both join the AGENTS.md Layout table. Split by job only.

### Out of scope
- The audit's other findings (A1, A4, E2, E3, E5, E9, C3).

### Definition of done
- [ ] A failed busy or idle save is fatal and nothing more of the record is saved.
- [ ] A sibling's run stop during a lock wait ends the Ticket at needs-human with no GitHub write.
- [ ] Golden traces unchanged.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `a failed busy or idle save saves nothing more of that record`;
  `a run stop during a repo-lock wait makes no GitHub write`.
- test/effects.test.mjs and test/terminal.test.mjs: one case each importing the moved functions (`await import()`).

### Notes
Depends on nothing. Glossary: none.

---

## E1. Red and green on separate Vertices

Part of #EPIC.

### Problem
`tdd` runs two agent steps in one Visit, and the interpreter special-cases `phase === 'red'` for its dirty-worktree
guard. ADR 0014 allows one agent step per Procedure (R2).

### Goal
The shipped Flow runs red and green as two Vertices, with behaviour per Vertex unchanged.

### In scope
- `tdd` splits into code Procedures `tests-fail` (red, still-green, commit tests) and `implement` (green, test-fix,
  commit, push, PR). The shipped Flow becomes red → green → reviewer ⇄ implementer-fix.
- `resumeGreen` goes (R2c).
- The dirty-worktree guard becomes R2d: a write Vertex starts only on a clean worktree or one gg's records explain.
- Green keeps reading red's outputs from the record (E4 makes them inputs).

### Out of scope
- Procedures as data (E5 to E7). Ends (E3).

### Definition of done
- [ ] Golden traces regenerated: the five `golden:` cases in `test/interpreter.test.mjs` and the crash-and-resume
  traces in `test/reconcile.test.mjs`.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `golden: a first-visit pass runs red then green as two Vertices`; `a write Vertex on a
  dirty worktree gg's records do not explain is held`.

### Notes
Depends on A4 (after E0 and A1; serial interpreter work). Request section 7 no longer defers this. Glossary: none.

---

## E2. Action ids and the Recovery Number

Part of #EPIC.

### Problem
Action identity is `(phase, ordinal)`, tied to code Phases that ADR 0014 removes. The PR's provenance table
double-counts a resumed Session's tokens and counts one call per Phase however many Attempts ran (audit finding 3).
The retry key is built three ways (finding 6).

### Goal
Identity is the Action id and the Recovery Number (R6, S1), and provenance counts each Attempt once.

### In scope
- The marker becomes `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>`; the cursor,
  `rec.retries`, the settled result and the Action Event key on Action id and Recovery Number; `rec.sessions` on the
  agent Action. Reconciliation parses the new marker.
- The code Procedures get Action ids; still-green and test-fix count as Recovery Numbers until E6 removes them.
- One `actionKeyOf(at)`; `outcome.resolve` returns the retry kind.
- Provenance counts one call per Attempt from each Attempt's `usage.delta`.
- The copied `markerOf` test helper moves to `test/support/`.

### Out of scope
- Removing the Phases (E6).

### Definition of done
- [ ] Every golden trace regenerated (markers).
- [ ] A resumed Session and a retried Attempt are counted correctly in the PR's provenance table.
- [ ] `npm test` passes.

### Tests to write first
- test/marker.test.mjs: `a marker carries the action id and recovery number`.
- test/render.test.mjs: `provenance counts one call per Attempt and a resumed Session once`.

### Notes
Depends on E1. Glossary: Action id, Action identity, Recovery Number.

---

## E3. Ends, Flow routes and the `publish` Vertex

Part of #EPIC.

### Problem
Terminals (`done`, `needs-human`, `replan`) are built into the interpreter: `done` marks the PR ready, `misscoped`
defaults to `replan` inside `edge()`, and `then` is a second way to route.

### Goal
A Vertex routes to a Vertex or to `end: ready-for-qa | needs-human | needs-replan`, and publishing is an Action in a
Vertex that requires a Check (R11, R12).

### In scope
- `end:` replaces the Terminals; `then` goes; the Flow's default `routes`, `"*"` included (T3).
- `harness-timeout`, `harness-transient` and `harness-unparsed` become routable Outcomes, defaulting to
  `end: needs-human` (Q3f).
- A stop token's comment template replaces the end comment and goes to the Ticket, and to the Epic at
  `end: needs-replan` (U6, W9). `misscoped` reaches the planner through the Flow's default route.
- A `publish` Vertex (code Procedure: the test Check, `pr-upsert`, `pr-ready`) replaces `done`. `pr-ready` runs only
  if the Check's tree equals the published commit's tree and the worktree is clean; the target commit survives
  retries and Reconciliation (T1a, T2).
- `comment` takes `target: pr | ticket` (W5).
- The copied `TERMINALS` lists become one definition of the end states (audit finding 8).

### Out of scope
- Bounds (E8).

### Definition of done
- [ ] Golden traces regenerated: every case that ended at `done`, and the blocked and replan cases.
- [ ] A changed tree between the Check and `pr-ready` holds the Ticket.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `golden: a first-visit pass ends at ready-for-qa through publish`; `pr-ready holds when
  the published tree differs from the checked tree`; `an unrouted harness-timeout ends at needs-human`; `a stop
  comment replaces the end comment and reaches the Epic at needs-replan`.

### Notes
Depends on E2, A4. Glossary: end state, publishing Action.

---

## E4. Vertex inputs

Part of #EPIC.

### Problem
Data passes between Vertices through hard-coded record fields (`rec.outputs.red`) and code such as
`findings.map((f) => f.file)`.

### Goal
A Vertex declares `inputs`, resolved and snapshotted at Visit entry (Q7, S4).

### In scope
- `from` names `<vertex>.<action id>.<field>` (W2), or a list where the latest Visit wins (T6); `optional`, with
  `absent` (T10); `pick` (R13c).
- The snapshot records each value's producer Vertex, Visit and Action.
- Briefs, templates, Check parameters and `tests: named` read inputs.
- The shipped Flow declares green's tests and red evidence, the reviewer's report and both evidences, and the fix
  Vertex's findings and `testFiles`.

### Out of scope
- `<vertex>.rescue` (E9).

### Definition of done
- [ ] Golden traces regenerated where the record's Visit snapshot changes.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `green reads red's committed tests through an input`; `a list input takes the latest
  Visit across its sources`; `an absent optional input renders empty in the Brief`; `pick projects findings to file
  paths`.

### Notes
Depends on E3. Glossary: Vertex input.

---

## E5. Checks as declared Actions, and the engine Outcome `failed`

Part of #EPIC.

### Problem
Checks are bound to code (`CHECK_NAMES`, `checkOutcome`) and fail with special Outcomes (`red-failed`,
`gate-failed(test)`). A failed red discards its work even when routed to an end.

### Goal
Checks are Actions with ids and kinds, results are fresh only on the tree they checked, and a final failure is the
`failed` table's Outcome or the engine Outcome `failed` (R1, R4, T7, U14).

### In scope
- Check kinds `command`, `tests-fail`, `response` (with `all-of`, P5d) and `repeat`, with parameters; a command
  Check names a Declared Command.
- Each result records `{ id, kind, state, tree }`. A commit and the `passed` table count only results on the current
  tree. A Check that changes the tree fails (T1b).
- `review-pass` becomes a `response` Check and the review's first `passed` row, evaluated through A2 (P5a). `repeat`
  is a recorded fact; its route is E8.
- `CHECK_NAMES`, `checkOutcome`, `gate-failed(test)` and `red-failed` go; the Terminal Reason is rendered from the
  Check signal.
- A failed red ending at an end leaves its work in place (U10). The two integrity rollback blocks in `runVisit`
  become one (audit finding 7).

### Out of scope
- Claim tokens and recovery (E6).

### Definition of done
- [ ] Golden traces regenerated: failed red, test-fix exhausted, review `ok` without evidence.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `a failed red at an end leaves its work in place`; `a final test failure is the Outcome
  failed naming the Check`; `a Check result on an older tree does not count`; `a Check that changes the tree fails`.
- test/checks.test.mjs: `a response Check with all-of names each failed condition`.

### Notes
Depends on E4, A2. Glossary: Signal gains the Check signal.

---

## E6. Claim tokens, recovery and `pass`

Part of #EPIC.

### Problem
Stop tokens are a code list (`STOP_CLAIMS`), recovery is a Phase per failure (still-green, test-fix) with `WHEN`
conditions and `lineage`, and `requireTestPass` relaxes a Check by option.

### Goal
Claim tokens declare `requires` or `stop`, recovery is one per-Visit budget, and the Outcome is decided in one fixed
order (Q3, Q3d, T4, W1).

### In scope
- Tokens `{ requires: [...] }` or `{ stop: true }` replace `STOP_CLAIMS` and the claim rows of `outcome.mjs`; the
  fixed integrity, harness and parse rows stay.
- `recover: { max, brief }` replaces the recovery Phases, `WHEN`, `lineage` and their options. After a pass in which
  a required Check failed recoverably, the agent's Session resumes with the recovery Brief plus each failing Check's
  section, and every Check runs again. Each kind declares its recoverable failures; `recoverable: false` opts out.
- `pass` (Recovery Number + 1) is matchable in rules.
- Decision order: fixed rows; `stopped` table, else the token; `passed` or `failed` table; `otherwise`; the token or
  `failed`.
- `requireTestPass` goes from Procedures and Events (U7).

### Out of scope
- Procedures from config (E7).

### Definition of done
- [ ] Golden traces regenerated: still-green, test-fix, blocked after recovery; the `requireTestPass` case deleted.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `recovery resumes the Session with every failing Check's section`; `every Check runs
  again after recovery`; `a stop token after recovery stops`; `pass is matchable in the passed table`.
- test/outcome.test.mjs: `the decision order is fixed rows, stopped, passed or failed, otherwise`.

### Notes
Depends on E5. Glossary: pass, Claim token `requires`.

---

## E7. Procedures come from config, and admission runs the validator

Part of #EPIC.

### Problem
Procedures are still a table in `lib/procedures.mjs`, Personas resolve only against the shipped defaults (a
`shortcut:` in `config.mjs` and `interpreter.mjs`), and `gg run` does not run the validator.

### Goal
Procedures are configuration, their files load from the Layer that declares them, and `gg run` rejects exactly what
`gg doctor` rejects (D3, V1).

### In scope
- Procedures in the A5 shape, held for now by the defaults Layer (the one exception to P2, removed in C2).
- Briefs, schemas and Personas load from the Layer that declares them, with bytes and hashes pinned.
- `tests:` and `access:` replace the remaining literal checks; Test Immutability stays a fixed row (R3).
- Admission calls A5 and A6.
- The interpreter names no Procedure, Action or Check.

### Out of scope
- Removing the defaults' Flow (C2).

### Definition of done
- [ ] Golden traces show unchanged behaviour (the Config Hash inputs change).
- [ ] `gg doctor` prints the shipped Flow with no errors.
- [ ] `npm test` passes.

### Tests to write first
- test/run.test.mjs: `gg run rejects a Flow gg doctor rejects, with the same message`.
- test/interpreter.test.mjs: `the interpreter names no Procedure, Action or Check`; `a Persona from the repository
  Layer is pinned with its hash`.

### Notes
Depends on E6, A6. Glossary: Procedure updated.

---

## E8. `maxVisits`, the Action Cap and `repeat` routing

Part of #EPIC.

### Problem
Only back edges carry bounds. Vertex `maxVisits` and the Ticket's Action Cap are in the request but not built, and a
repeated review routes as `changes` (a `shortcut:` in the interpreter).

### Goal
Every escalation is bounded, and `repeat` routes on its own (T5, R4d).

### In scope
- Vertex `maxVisits` with `exhausted`; the Action Cap over Attempts; request 3.3's counting rules.
- The effective target of a route after edge and Visit exhaustion (U5).
- The shipped review routes `repeat` with an edge `max: 1`.

### Out of scope
- Rescue (E9).

### Definition of done
- [ ] New golden traces: a repeat routed to an escalation Vertex; a `maxVisits` exhaustion.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `golden: a repeated review escalates`; `maxVisits exhausted takes the Vertex's
  exhausted target`; `the Action Cap ends the Ticket at needs-human`; `a restart at a bound routes the same way`.

### Notes
Depends on E7. Glossary: Action Cap updated.

---

## E9. Rescue Refs for work routed to another Vertex

Part of #EPIC.

### Problem
A failed or stopped write Vertex whose Outcome routes to another Vertex leaves its work in the worktree, so the next
Vertex starts dirty and cannot see what failed.

### Goal
That work is rescued to a Rescue Ref and reset, and later Vertices can read it (R5, U5, W3).

### In scope
- Decided on the effective target (E8): a Vertex target rescues and resets; an end leaves the work in place.
- Rescue to `refs/gg/rescue/<digest of the Action Marker>`, never overwriting (ADR 0011's layout); reset through the
  write-ahead `reset`; a History item naming the failure and the ref.
- `<vertex>.rescue` as `{ ref, diffStat, output }`.
- Anything gg's records do not prove is the agent's holds (R5d).
- First, `crashFs` picks its crash by path rather than call count (audit finding 20).

### Out of scope
- Interrupted Attempts (grey-goo-ri issue #68, which then reuses this).

### Definition of done
- [ ] Golden traces: a failed fix rescued into an escalation Vertex; the same failure left in place once the
  escalation is exhausted.
- [ ] A crash at each step resumes without a second ref or a repeated reset.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `a failure routed to a Vertex is rescued and reset`; `a failure routed to an end is left
  in place`; `the next Vertex reads the rescue output`; `an existing rescue ref is never overwritten`.

### Notes
Depends on E8. Glossary: Rescue Ref output.

---

## E10. The `await-approval` Action

Part of #EPIC.

### Problem
Nothing pauses a ticket Flow for a human decision. The request's approval vertex sat outside Procedures (X1).

### Goal
`do: await-approval` asks for a Decision through ADR 0003's label protocol, and the Decision is the Visit's Outcome.

### In scope
- `await-approval` with `decisions` (default `approved`, `rejected`), last in a Procedure with no agent Action;
  Checks before it run first.
- Reaching it: the Pending Instance to the record, earlier await and decide labels removed, the Await Label, one
  comment, each a write-ahead Action; the run ends for the Ticket, which is Awaiting.
- A later run, under the ticket lock, consumes the Decision through A7: record first, then the decide label removed.
  Stale, ambiguous or missing retire and re-request.
- Reconciliation resumes a crash at every step without reading the timeline twice.
- A5 and A6 treat `decisions` as Outcomes and check their labels exist in the repository.

### Out of scope
- `gg work approve`; plan approval at the Epic level.

### Definition of done
- [ ] Golden traces: the request posted and the run ended; an approval consumed and routed on; `rejected` routed
  back; a stale digest re-requested; crashes before and after the decide label's removal.
- [ ] `npm test` passes.

### Tests to write first
- test/interpreter.test.mjs: `golden: an approval request ends the run and a later approval routes on`; `a rejected
  decision routes back`; `a stale approval is re-requested`; `a crash after consumption is not read twice`.

### Notes
Depends on E9, A7. Glossary: Approval Vertex becomes a Vertex whose Procedure ends in `await-approval`; Vertex loses
its three kinds.

---

## C1. `gg init` writes the example, and this repository gets its own Flow

Part of #EPIC.

### Problem
gg still ships a Flow in its defaults Layer, and `gg init` is not implemented (P1, U8).

### Goal
`gg init` writes the example into a repository, and this repository runs on its own.

### In scope
- `gg init` writes `.agents/gg/gg.json` (Agents with `senior`, Procedures, the Flow, `testPaths`, `commands` without
  `test`, as ADR 0013 says) and the Briefs, Personas and schemas beside it, from the example-flow doc. It refuses to
  overwrite an existing Layer.
- `examples/*.json` gain `senior`.
- One test proves the example passes admission and pins its golden trace; the tests that load the shipped Flow
  (`config`, `defaults`, `flow`, `procedures`, `run`) move to fixture Flows.
- This repository's `.agents/gg/gg.json` gets its Flow from `gg init`.
- The example Flow writes `plan: null` explicitly (X2b).

### Out of scope
- Removing the defaults' Flow (C2).

### Definition of done
- [ ] In an empty temp repository, `gg init` then `gg doctor` succeeds once a `test` command is added.
- [ ] `npm test` passes.

### Tests to write first
- test/doctor.test.mjs: `gg init writes the example and gg doctor accepts it`; `gg init refuses to overwrite a
  Layer`; `golden: the example Flow's first-visit pass`.

### Notes
Depends on E10. Glossary: none.

---

## C2. The defaults Layer ships no Flow

Part of #EPIC.

### Problem
After C1, the defaults Layer's Agents, Flow, Procedures and Personas are a second copy that an upgrade could change
silently (P1, P3).

### Goal
gg ships no Flow, and a repository without one is told to run `gg init`.

### In scope
- `defaults/gg.json` loses `agents`, `flows` and `procedures`; `defaults/personas` and the template files go.
- `flows` or `procedures` in the defaults or user Layer is a load error naming the file (P2).
- Without a Flow, preflight and `gg doctor` fail naming `gg init` (P1a).

### Definition of done
- [ ] A repository without a Flow fails preflight with a message naming `gg init`.
- [ ] `npm test` passes.

### Tests to write first
- test/config.test.mjs: `a flows key in the user Layer is a load error naming the file`; `the shipped defaults
  declare no agents, flows or procedures`.
- test/run.test.mjs: `preflight without a Flow names gg init`.

### Notes
Depends on C1. grey-goo-ri issue #23 is blocked by this ticket. Glossary: none.

---

## C4. `gg run --flow` selects a declared Flow

Part of #EPIC.

### Problem
A repository can declare several Flows, but `gg run` always runs `default` (`lib/run.mjs:94`), so a lighter Flow for
a small bug fix cannot run. A `shortcut:` at `lib/run.mjs:110` tells a standalone Ticket to edit the default Flow
instead.

### Goal
`gg run <n> --flow <name>` runs any Flow the repository Layer declares (X2).

### In scope
- The `--flow` option on `gg run`; without it, `default`.
- An unknown name fails preflight, listing the declared Flows.
- The chosen Flow's name is pinned with the record; a resumed Execution keeps its Flow whatever `--flow` says.
- The standalone-Ticket rejection (request 3.3) names a null-plan Flow to pass with `--flow`, replacing the
  `shortcut:` advice.
- `gg doctor` lists the declared Flows.

### Out of scope
- Choosing a Flow per Ticket inside an Epic (X2c).

### Definition of done
- [ ] A standalone Ticket runs under a named null-plan Flow.
- [ ] `npm test` passes.

### Tests to write first
- test/run.test.mjs: `--flow runs the named Flow`; `an unknown --flow fails preflight listing the declared Flows`;
  `a resumed Execution keeps its pinned Flow`; `a standalone Ticket under a planned Flow is told to pass a null-plan
  Flow`.
- test/opts.test.mjs: `gg run accepts --flow with a value`.

### Notes
Depends on C2. Does not block grey-goo-ri issue #23. Glossary: none.

---

## C3. Audit cleanup: copies, dead code, names and test hygiene

Part of #EPIC.

### Problem
The 2026-10-21 audit's remaining findings (8, 9, 11, 12, 13, 15, 16, 17, 18, 19, 20 and three left-out items; see
`docs/research/user-defined-procedures-slices.md`) are copies, dead code, names and test hygiene. Re-check each on
main first, since the engine tickets rewrite much of the cited code.

### Goal
The remaining findings are fixed with no behaviour change.

### In scope
- One `sha256`, one default `clock`, one `git` stdout-trim wrapper; `gh.postComment` returns `{ id, url }`,
  dropping the comment-id regex; one needs-human cursor if any remain (8).
- One "keep the last whole lines" cutter for `checks.evidence` and `render.publicTail` (9).
- The `?? 'gg'` and `= 'gg'` label prefix fallbacks go, except in `labels()` (11).
- `addWorktree` compares paths with `paths.pathKey` (12).
- Code with no caller in `lib/`, `bin/` or `scripts/` is deleted with the tests that exist only for it (13):
  `github.openPrs`, `closePr`, `createIssue`, `inProgressSince`; `git.deleteRemoteBranch`, `commitAll`,
  `discardChanges`, `ticketBranches`, `discardBranch`, `cleanupMerged`, with `isDirty`, `hasUnpushed`,
  `removeWorktree` and the `git.mjs` → `github.mjs` import; `render.ticketBody`, `epicBody`. Unused `export`s are
  dropped, `DEFAULT_TEST_GLOBS` excepted (C1). `record.createEpicRecord` stays.
- Fixtures restore the GitHub transport after `setGh` (15).
- Copied test helpers move to `test/support/` (16).
- `admit()`'s corrupt-record branch becomes its own function; `runTicket` reuses `admit`'s skipped-but-needs-human
  logic (17).
- One exec timeout-note helper; `[ff: …]`, `FF_CMD` and `FF_TEST_*` become `gg` names; `Feature-Flow-Stage:` stays
  (18).
- `record.proof` takes a glossary name; the JSON-key sorter in `config.mjs` stops sharing `canonical` with
  `paths.canonical` (19).
- Temp directories removed in `git.test.mjs`, `fake-harness.test.mjs` and `harnesses-contract.test.mjs` (20).
- Synchronous functions lose `async`; one rule for an empty error message; one reader for GitHub's `?.nodes` shape.

### Out of scope
- Anything that changes behaviour, records or Events.

### Definition of done
- [ ] Golden traces unchanged.
- [ ] `npm test` passes.

### Tests to write first
- test/git.test.mjs: `addWorktree treats paths differing only in case as different off Windows`.
- test/github.test.mjs: `postComment returns the comment id and url`; `a second fixture's transport does not reach
  the first`.
- test/render.test.mjs: `the line cutter falls back as configured when no line fits`.

### Notes
Depends on C4. Does not block grey-goo-ri issue #23, but touches the interpreter, so it does not run while #23 is in
flight. Glossary: the name chosen for `record.proof`, if new.
