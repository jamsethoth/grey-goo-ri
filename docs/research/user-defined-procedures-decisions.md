# User-defined Procedures, Actions and Outcomes: decisions

The running record of the planning session. The research behind it is in
[user-defined-procedures.md](user-defined-procedures.md).

## Reading guide: later decisions that amend earlier ones

Decisions are recorded in the order they were made; a later one wins. In particular:

| Earlier | Amended or replaced by |
|---|---|
| D4, Q3b: Declared Commands in `AGENTS.md` | Main: the repository Layer's `commands` (ADR 0013) |
| Every "step id" | S1: **Action id** |
| Q3: tokens over several Phases; Q3d's per-Phase reading | R2: one agent step per Procedure, one Claim per Visit |
| Q3a: commit `requires` | S2 (commit runs on the claimed token's fresh required Checks) and R1b (freshness by tree) |
| Q3b: `immutability` as a declarable Check kind | R3: Test Immutability is in gg's fixed integrity row |
| Q3b, Q3d: `onFail` | R14a: dropped |
| Q3b: `recover` reruns only its own Check | R1a: every Check of the Vertex runs again after recovery |
| Q3g: the publishing fence on routes to publishing Terminals | R11d: publishing Actions require fresh passing Checks in their own Vertex; R11e |
| Q3e, Q6, Q3f: routes to Terminals `done`, `needs-human`, `replan` | R11a: `end: ready-for-qa / needs-human / needs-replan`; R12: routing rules |
| Q4: no-match default | S3 (the token, `passed` table only) and R12 (unrouted Outcomes) |
| Q4b: overlap by testing boundary values | R8: exact box subtraction |
| Q6: `misscoped` as its own stop token | R9: one `blocked` token with a `reason` |
| Q7: `visits: all` | R14b: dropped |
| Q8: "no version bump" | R7: versions stay fixed before the freeze and bump after it |
| R6: Action identity with "step" | S1: Action id |
| Q3b `recover` per Check, R1d ordering, R8b `runs` | T4: Vertex-level `recover`, `pass`, no per-Check `runs` |
| Q3g fence; R11d tree check against the current worktree | T1: against the tree of the commit being published |
| R9b "routes to `replan`" | T3: the Outcome `misscoped`, routed by the Flow's default `routes` |
| R12e: push and pr-upsert only in `publish` | T2: `implement` and `fix` keep push and a draft pr-upsert |
| Q7: `from` names one source | T6: `from` may name a list; the latest Visit across it wins |
| R14a: an unmatched `failed` table falls to "the routing default" | T7: the engine Outcome `failed` |
| Q1: the read-only `gg doctor` warning | T11: dropped |
| Q4: "a missing input holds the Ticket" | T10: required inputs only; an absent optional input is the value `absent` |
| R3e: where `testPaths`' default lives | T12: in code, `DEFAULT_TEST_GLOBS` |
| R12e: the shipped Flow | T8, T9, T13 and step 2's rewrite |
| Q3e, R12b: `onFail` values among a Vertex's Outcomes | R14a (fixed in R12b in place) |
| D3, R12e, T3: shipped defaults-Layer Procedures and the shipped Flow | P1: no default Flow; the example Flow |
| P1 (open): a library of shipped Procedures | P3: no library; `gg init` writes the whole example |
| R3e, T12: `testPaths` defaults to `DEFAULT_TEST_GLOBS` | P4: `testPaths` is required |
| R4a: one condition per `response` Check | P5d: `all-of` |
| R4b: the review's `ok` requires `review-pass` | P5a: `ok` requires nothing; a `passed` row decides |
| Q7: Briefs and templates read `inputs` | U1: plus gg's own context, by name only |
| R9a: `reason` enum | U3: gains `none` |
| R5a, R5b: rescue by the route's target | U5: by the effective target, after exhaustion |
| R11a, S5: end comment and stop template | U6: the stop template replaces the end comment |
| Q3c: a Vertex option may remove a Check from `requires` | U7: dropped; declare a second Procedure |
| R10a: rule tables in any Layer | P2: Flows and Procedures in the repository Layer only |
| Round-1 review S7: `session: fresh \| resume` on agent Phases | T4a: recovery always resumes the agent's Session; no field |

## Step 1: use cases and users (2026-10-21)

- D1. Use cases a–g are all in scope: (a) a QA stage whose agent may commit only test changes; (b) merge on done
  (grey-goo-ri issue #89); (c) deploy a preview and post its URL; (d) a lint, size or scope gate; (e) red and green on
  separate Vertices; (f) a Slack or webhook notification; (g) a custom review shape.
- D2. Extensions are written by the repository owner. Sharing means the owner copies config and trusts it as their
  own: no packaging, registry or signing.
- D3. No privileged built-in Procedures. If `tdd`, `fix` and `review` ship, they are ordinary default-Layer
  definitions, and their names are not reserved. The interpreter special-cases no Procedure or Phase name.

## Step 2: what must stay true (2026-10-21)

- I1–I5 accepted without objection: crash safety, replay pinning, everything bounded, validation before any agent runs,
  and agents cannot change what gg runs with its credentials.
- Q1. An agent Phase that can change the worktree needs an orchestrator-run Check. A read-only Phase may advance on its
  Claim alone, with a `gg doctor` warning.
- Q2. Integrity Assertions can never be switched off by a user.

## Approach (2026-10-21)

- D4. Build Option 1 (Procedures as data over gg-owned primitives) with Option 2's rules folded into its outcome rows:
  typed Claim fields as inputs, a strict hit policy, and a missing input holds the Ticket. Then build Option 3 (user
  Actions and Checks as executables behind a durable protocol). Durable-step code modules are rejected.
- Until Option 3 lands, a user can define Procedures, but only from gg's own Actions. That covers use cases a, d, e
  and g. Use cases b, c and f (new kinds of side effect) wait for Option 3. The owner accepts that gap.
- A Check that runs a Declared Command (`AGENTS.md` `## Commands`) is a gg primitive, so a user can already add a
  command-based verifier, such as a type check or a lint, under Option 1.
- Option 3's config shape is designed with Option 1, so `do: <name>` resolves to a gg primitive or a declared Action
  without a grammar change.

## Step 3: outcome rules (2026-10-21)

- Q4. User outcome rows are first match, checked at admission:
  - A row that can never fire, because earlier rows cover every case it matches, is an error.
  - A partial overlap is a warning naming the input combinations where an earlier row wins; `gg doctor` prints them.
  - With no row matching and no `otherwise`, the Outcome is the Claim token (amended under Q3e). A missing input holds
    the Ticket (D4).
- Q4a. A row may match only enum, boolean and integer fields:
  - gg's own facts: Check state, harness status and failure class.
  - The user's own vocabulary: Claim tokens, Check ids, and typed fields in the user's response schemas (later, a user
    Action's output schema).
  - gg reads the user's schemas at admission. Matching a free-text field, or naming a value the schema does not allow,
    fails admission.
- Q4b. Integers compare with `<`, `<=`, `>`, `>=` and `=` against constants only, so the overlap check stays exact by
  testing each row's boundary values. Comparing two fields to each other is not allowed.

- Q3. Claim tokens (revised 2026-10-21; the earlier advance/route/stop roles are replaced). Each Claim token a
  Procedure declares is either `{ requires: [<check ids>] }` or `{ stop: true }`:
  - A Check the claimed token requires blocks it. While that Check has recovery left, its `recover` Phase runs.
    Remaining Actions run. `requires: []` is what a review's `changes` used to be.
  - A `stop` token records its Phase's Checks, skips the remaining Actions and ends the Visit.
  - Nothing compares against literal tokens any more. The shipped `tdd` is `{ ok: { requires: [red, green] },
    blocked: { stop: true }, misscoped: { stop: true } }` (Check ids illustrative).
- Q3a. A commit Action declares `requires: [<check ids>]`. Admission rejects a commit reachable after a write-access
  agent step unless it requires at least one Check that ran after that step. When a required Check failed, the commit
  is skipped and the Ticket holds with the work uncommitted.
- Q3b. A Check step has an `id`, a kind (option 1: `command`, `tests-fail`, `changes`, `immutability`, `repeat`), the
  kind's parameters, an optional `recover: { phase, max }` and an optional `onFail` Outcome. It records `state`
  (`passed` or `failed`) and `runs` (an integer). There is no `gate` setting: whether a Check blocks depends on the
  claimed token's `requires`.
- Q3c. `relaxed` and `exhausted` are dropped as Check states. Rules see a Check only after recovery has finished, so
  `failed` is final; a rule that cares how many times it ran matches `runs` (Q4b). A Vertex option may remove a Check
  from a token's `requires` (today's `requireTestPass: false`); `gg doctor` warns loudly when it does. Integrity
  Assertions are never removable (Q2).
- Q3d. The Outcome order (2026-10-21):
  1. gg's fixed rows, at each agent Attempt: integrity, harness failure, parse. They can end the Visit there.
  2. A `stop` token's Outcome. Its Phase's Checks are still recorded.
  3. One split: did every Check the claimed token requires pass (after recovery)?
     - Yes: the `passed` table (first match), then `otherwise`, then the token itself.
     - No: the `failed` table (first match), then `otherwise`, then the first failing Check's `onFail` in step order,
       then `needs-human`.
  - Once a required Check has failed for good, the current Phase's remaining Checks still run, so the `failed` table
    sees every Check of the work that was done. Further recovery Phases, later agent Phases and effect Actions
    (commit, push, comment, pr-upsert) are skipped. A Check that could not run records `not-run` with `runs: 0`.
  - Check states are therefore `passed`, `failed` and `not-run` (amends Q3b). Admission includes `not-run` when it
    enumerates combinations (Q4) and warns on a rule that references a Check always `not-run` in that table.
- Q3g. The publishing fence (closes the empty-`requires` question). An Outcome that routes directly to a publishing
  Terminal can only come from the `passed` table, or its default, of a token that requires at least one Check.
  Admission rejects a `failed` rule routed to a publishing Terminal, and `ok: { requires: [] }` routed to one.
  Publishing Terminals are a named set: `done` today, and any later Terminal that publishes or cannot be undone, such
  as merge (grey-goo-ri issue #89). An Outcome may route to another Vertex freely, since that Vertex is held to the
  same rules.
- Q3e. Admission lists every Outcome a Procedure can produce (tokens, `onFail` values, rule Outcomes, `otherwise`) and
  rejects any that has no route on the Vertex and is not a Terminal.

- Q6. A `stop` token's Outcome is routable, defaulting to `needs-human`. A third first-match table, `stopped`, may
  refine it; it reads only the Claim and its typed fields, since the remaining Actions never ran. The shipped
  `misscoped -> replan` becomes an ordinary route in the shipped Flow, not a default in `edge()`.
- Q3f. Harness exhaustion is routable through three gg-named Outcomes, each defaulting to `needs-human`:
  `harness-timeout`, `harness-transient` and `harness-unparsed`. Integrity violations and run-stop classes (`auth`,
  `quota`, `budget`) are never routable.
- Both Q6 and Q3f Outcomes are fenced from publishing Terminals (Q3g), and each target Vertex needs its own bound (I3).

- Q7. Data between Vertices uses explicit `inputs` on the consuming Vertex: `{ from: <vertex>.<step id>.<field> }`.
  - `visits` defaults to the producer's latest completed Visit; `visits: all` gives a list across Visits.
  - A required input must come from a step on every path from the entry to the consuming Vertex; otherwise admission
    fails, unless the input is marked `optional`.
  - Briefs and Check parameters read `inputs.<name>`. `gg doctor` prints each Vertex's inputs and their sources.
  - Agent Sessions stay inside a Vertex; no Session is resumed across Vertices.
  - Open for step 5: `pr-upsert` and `comment` bodies become templates over `inputs` and the Vertex's own outputs,
    replacing the hard-coded `render.prBody`.

## Validation (2026-10-21)

- V1. Static first: everything checkable from the definition is checked from the definition; only facts that need
  execution (a test result, an agent's answer, a remote call) are runtime errors.
  - One validator module produces the Resolved Flow plus errors and warnings. `gg doctor` and `gg run` admission
    both call it, so a config cannot pass one and fail the other. `gg doctor` prints each Vertex's effective
    Procedure, Checks, rule tables and reachable Outcomes, and exits non-zero on any error.
  - It checks: syntax and name resolution; strict response schemas whose Claim enum equals the declared tokens, with
    no case-only differences; the Procedure rules (Q1, Q3, Q3a, Q2); the rule tables (Q4, Q3d, Q6); the graph (every
    Outcome routed, the publishing fence, every cycle and escalation chain bounded, inputs produced on every path,
    unreachable Vertices warned); and trust and harness admission (I5, `validate`).
- V2. Scenario runs are backlogged as grey-goo-ri issue #98: scripted Claims and Check results run through the real
  interpreter offline on the fake harness, to show every branch is reachable and behaves as intended.

## Effects (option 3 contract, 2026-10-21)

- Q5. An effect Action may declare `confirm`: a command that reads the effect's real state by its Action Marker and
  answers `present`, `absent`, `conflicting` or `unknown`. It confirms the intended effect exists; it does not judge
  whether the effect is good.
  - Recovery uses it when an intent has no evidence: `present` saves the evidence, `absent` redoes the effect,
    `conflicting` holds, `unknown` retries the read on the Action's budget and then holds.
  - It may also run after a successful `run`; there `absent` or `conflicting` is a fault, as push's origin check is
    today. gg's own GitHub Actions confirm at recovery only, to spare the rate limit; push keeps its check.
  - With no `confirm`, an interrupted effect holds for a human by default. `onInterrupt: rerun` must be declared
    explicitly, and `gg doctor` warns about it.
  - gg passes the Action Marker to every effect as an idempotency key.
  - `retryable: true` from `run` asserts the effect did not land or is safe to repeat; gg's normal retry budget and
    cooldown then apply.
  - `irreversible: true` (for example merge, grey-goo-ri issue #89) brings in the publishing fence (Q3g) and a
    human-override check immediately before launch.
- Q5a. Naming: gg's internal finders become Confirmation. Proposed glossary entry: **Confirmation**, the read of an
  effect's real state by its Action Marker, after the effect and at Reconciliation. `verify` and `check` are avoided,
  since Checks verify the agent's work.

## Delivery and the freeze (2026-10-21)

- Q8. Option 1 in full (data-defined Procedures, Claim tokens and `requires`, Check settings, the outcome tables,
  Vertex `inputs`, routable stop and harness Outcomes, the publishing fence, the validator, and the shape changes they
  bring) is built now, before grey-goo-ri issue #23. #23 then freezes the final shapes, with no version bump and no
  readers for old markers.
- Option 3 (user-defined Actions) comes after the freeze. #23 reserves what it needs, as it reserves `rescue` for
  grey-goo-ri issue #68: `intent.action` as an open string, `confirm` evidence in the evidence slot, and `onInterrupt`.
- Settled inside the tickets that need them: PR body and comment templates over `inputs` (replacing `render.prBody`),
  the option-reference syntax, and where Layer Briefs, schemas and Personas live (lifting the "shipped Personas only"
  shortcut in `lib/config.mjs`).
- grey-goo-ri PR #92 (Node to Agent) merges first.

## Review round 1 (2026-10-21)

The merged review is [user-defined-procedures-review.md](user-defined-procedures-review.md). Main has moved: Declared
Commands now come from the repository Layer's `commands` key (grey-goo-ri PR #99, ADR 0013), so references above to
"`AGENTS.md` `## Commands`" read "the repository Layer's `commands`", and this design's ADR is 0014.

- R1. Fresh Check results after recovery:
  - (a) After a recovery Phase, every Check of the Phase it recovered runs again, in step order.
  - (b) Each Check result records the worktree tree it checked (`integrity.snapshot`). A commit and the `passed` table
    count a required Check only if its tree equals the current tree; a stale one counts as failed. This replaces the
    step-order inference in Q3a.
  - (c) Results of earlier Phases' Checks stand as history (the Red Check proved the tests failed before green).
  - (d) With several recoverable Checks, the first failing one in step order recovers first, each within its own
    `max`; the total stays bounded.
  - Limit, to note in ADR 0014: the tree covers tracked and staged content, not untracked ignored files.

- R2. One agent step per Procedure; multi-step work is Vertex composition (replaces the multi-Phase proposal):
  - (a) A Procedure has at most one agent step, plus its recovery Phases. Zero agent steps is a deterministic Vertex
    (a gate, a publish, later an effect).
  - (b) Multi-step work is composed from Vertices. The shipped Flow becomes red, then green, then the reviewer and fix
    loop, then done; `red` commits the tests and `green` reads them through `inputs`.
  - (c) `resumeGreen` is dropped. Resuming a Session across Vertices waits for a use case.
  - (d) A passing write Vertex leaves its work committed, and a write Vertex starts only on a clean worktree or one gg's
    own records explain. This replaces the literal `phase === 'red'` dirty-worktree guard.
  - (e) Rule tables may match typed `inputs` under the Q4a field rules.
  - (f) Parallel Vertices (fan-out and join) are a possible future capability, outside this design.
  - (g) The shipped Flow routes a review's `changes` by a typed reviewer field: `needsTest: true` goes to `red` (a
    failing test reproduces the finding first), anything else to `implementer-fix`. `red` reads the findings through
    an `optional` input, absent on its first Visit. `optional` stays.
  - With one Claim per Visit, finding 2 of the review no longer applies; the Q3d gate applies once, at the Visit's end.

- R3. Test Immutability:
  - (a) It is in gg's fixed integrity row, asserted after every agent Attempt of every write Vertex, recovery Attempts
    included. It is not declared, not recoverable and not routable; a violation stops the Ticket (Q2).
  - (b) A Procedure declares how much it may touch tests: `tests: frozen` (the default), `tests: named: <input>` (only
    the test files listed in an input, as `implementer-fix` with the review's findings), or `tests: write` (`red`,
    `qa`). `gg doctor` prints each Vertex's setting.
  - (c) The baseline is the last commit gg made in the Execution, or the Execution's base before any. Every gg commit
    either passed Test Immutability or came from a Vertex allowed to change tests.
  - (d) The reviewer's "test files changed since red" becomes "since the Execution's first test commit", found from
    gg's own commit records.
  - (e) Test paths are a repository-Layer setting, `testPaths`, defaulting to today's `DEFAULT_TEST_GLOBS`, with the
    dependency directories excluded (`lib/checks.mjs:79`). Only the repository Layer may set it, as with `commands`
    (ADR 0013).

- R4. Response and repeat Checks:
  - (a) A `response` Check kind evaluates the agent's recorded response: `{ field, is }` on an enum or boolean field;
    `{ none | any | all: <list>, where: {...} }` over an array of objects' enum or boolean fields; and
    `{ count: <list>, where: {...}, "<=": N }` (integer bounds against constants). Admission checks every referenced
    field against the response schema.
  - (b) The shipped `review-pass` is a `response` Check (`dodMet`, `tddEvidenceOk`, no `blocker` or `major` finding),
    and the review's `ok` requires it, so it may reach `done`.
  - (c) A `repeat` Check kind compares a list's normalised fields (the shipped findings: `file`, `severity`, `issue`
    with whitespace and line numbers stripped) with earlier reviews by the same Vertex in the Execution: `passed` is
    new findings, `failed` a repeat. Not required by `changes`, it is a fact rules route on.
  - (d) The shipped Flow routes `repeat` to a bounded escalation Vertex. This completes the request's repeat routing
    and removes the `shortcut:` in `interpreter.mjs`. The review comment and PR update still run on a repeat.

- R5. The worktree after a failed Vertex:
  - (a) A failed or stopped write Vertex whose Outcome routes to another Vertex rescues its work to a Rescue Ref,
    resets to its Visit's baseline through the write-ahead `reset`, and adds a History item naming the failure and the
    ref. The next Vertex starts clean.
  - (b) One whose Outcome routes to a Terminal leaves the work in place for the human, as today.
  - (c) The rescued work (ref, diff stat, the failing Check's output) is an output later Vertices may take as an input,
    so an escalation sees what failed.
  - (d) A reset touches only changes gg's records prove are the agent's (ADR 0005); anything else holds the Ticket.
  - (e) The Rescue Ref piece of grey-goo-ri issue #68 moves into this work, using ADR 0011's layout
    (`refs/gg/rescue/<digest of the Action Marker>`). #68 keeps rescuing interrupted Attempts and their retry.

- R6. Action identity:
  - (a) An Action's identity is its execution, Vertex, Visit, step id, Recovery Number, Run and Attempt. The Recovery
    Number is 0 on the Vertex's first pass through its steps; each recovery Phase run increments it, and the Checks that
    run again after it carry the new number.
  - (b) The Action Marker keeps eight parts, with `<step>:<recovery>` replacing `<phase>:<ordinal>`:
    `gg:<execution>:<vertex>:<visit>:<step>:<recovery>:<run>:<attempt>`.
  - (c) `rec.retries`, the settled result in `visitState` and the Action Event key on step and Recovery Number;
    `rec.sessions` keys on the agent step, since recovery resumes the same Session.
  - (d) Step ids are unique within a Procedure and contain no `:` and no whitespace (`lib/marker.mjs:14`), checked at
    admission.
  - (e) Glossary: a **Recovery Number** entry ("how many recovery Phases have run in this Visit; 0 before the
    first"), and the Action identity entry rewritten. grey-goo-ri issue #23 freezes it.

- R7. Versions before the freeze (accepted for now; the owner will revisit migration):
  - (a) No version bumps before the freeze: `SCHEMA_VERSION` stays 1 and the Event schema 2 through S1–S6. With no users
    and no State Databases, a bump protects nothing.
  - (b) grey-goo-ri issue #23 sets the first frozen record and Event versions; after it, a change needs an ADR and a
    bump.
  - (c) Between pre-freeze slices, delete any real `.git/gg/gg.db` before upgrading, noted in the epic.
  - (d) No migration code for now; after the freeze, the version check holds old records cleanly.
  - This corrects Q8: versions stay fixed before the freeze, and a change after it bumps them.

- R8. The rule-table analysis (replaces Q4b's "testing boundary values", which misses ranges):
  - (a) Each rule is a box: per-field value sets (enum and boolean subsets, integer intervals; an unmentioned field
    allows every value).
  - (b) A Check's state and runs are one coupled field (`not-run` has `runs` 0; `passed` and `failed` have 1 to
    `max + 1`). Analysis is split per Claim token by its required Checks, and each table's unreachable regions (for
    example a required Check `failed` in the `passed` table) are treated as rules ahead of the first rule.
  - (c) A rule that is unreachable or never fires is an error, computed exactly by subtracting every box above it
    (pattern-match usefulness, as in Maranget and rustc, over DMN-style boxes, as in Calvanese et al.).
  - (d) A partial overlap is a warning with one example input; `gg doctor` can show an example input that falls to the
    default.
  - (e) Hand-written in plain JavaScript, no solver dependency (ADR 0001). Tests cross-check it against brute-force
    enumeration over a finite partition on generated tables.
  - (f) It proves logical consistency over the declared domain, not runtime reachability (grey-goo-ri issue #98).
  - S3 also makes the library survey's deferred `ajv` decision for schema validation.

- R9. One stop token with a reason:
  - (a) The shipped Procedures use one stop token, `blocked`, with a response `reason` enum `misscoped | needs-input |
    environment` and a `diagnosis` field. `misscoped` stops being a token.
  - (b) The shipped `stopped` table routes `reason: misscoped` to `replan` (diagnosis to the Ticket and its Epic);
    anything else falls to `blocked`, which routes to `needs-human`.
  - (c) Every shipped Procedure offers `blocked`, the reviewer included (today its Claim is `ok | changes |
    misscoped`).
  - (d) Users may still declare several stop tokens. The `stopped` table stays (it has a use case now).
- R10. Rule tables and Layers:
  - (a) Rule tables belong to the Procedure. They may be set in any Layer, since a rule only picks an Outcome and the
    fence and admission checks still apply.
  - (b) A later Layer replaces a table whole (arrays replace in the Layer merge), so the effective first-match order
    is always visible in one place. `gg doctor` prints the effective table and the Layer it came from.
  - (c) Per-Vertex differences go through the Vertex's `route`, not per-Vertex rule overrides.

- Review "should change" items, accepted:
  - S1. ADR 0014 amends ADR 0004 (acceptance follows the claimed token's `requires`; stop Outcomes are routable),
    request section 3.4 (Procedures are code; the blocked and misscoped defaults, now R9) and clarifies section 2's
    "Work is code" (a Procedure is composition, an Action is work). Every "step id" above reads **Action id**, since
    the glossary bans "step" for Actions; the marker is `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:
    <attempt>`, and rules write `check.<action id>`.
  - S2. Commit `requires` is dropped. A commit runs only when every Check the claimed token requires has passed and is
    fresh (R1b); admission rejects a write Vertex whose committing token requires no Check. This replaces Q3a.
  - S3. Q4's no-match default (the token) applies to the `passed` table only; Q3d gives the others.
  - S4. Inputs are checked per Outcome (a producer that takes a failed or stop route never runs its later effects);
    `latest` means the latest Visit that produced the value; resolved inputs and their provenance (producer Vertex,
    Visit, Action) are snapshotted at Visit entry.
  - S5. Terminal comments are templates on the stop token (`blocked: { stop: true, comment: blocked.md }`), sharing the
    PR body's template mechanism; the replan diagnosis still goes to the Ticket and its Epic; a `changes` review still
    posts its comment.
  - S6. grey-goo-ri issue #23 also freezes: the Check signal `{ id, kind, state, runs, tree }`; a rule identity
    `{ table, row }`; the inputs snapshot; the Recovery Number; the Procedure definition hash; the Rescue Ref output;
    the Action Event without `requireTestPass`, `repeat` and `exhausted`. An unknown `intent.action` holds rather than
    counting as absent (today `reconcile.findEffect` returns absent). `record.md` gains worked examples of a custom
    effect, its Confirmation and an interrupted run.
  - S7. Carried into slicing: split S2 into the generic model (shipped behaviour unchanged, proved by fixtures) and the
    removal of literal-name special cases; one interpreter-touching ticket in flight (request section 6); each slice
    names its golden-trace regeneration, glossary entries and `gg doctor` output.

- R11. End states and publishing (answers review question 1):
  - (a) An Execution ends with `end: ready-for-qa | needs-human | needs-replan`, the existing State Labels. Reaching it
    sets that label, writes `ticket_end` with the Terminal Reason, and posts the Terminal Reason comment; nothing else
    runs at the end. Terminals stop being a special kind of Vertex: a Vertex routes to a Vertex or to `end`.
  - (b) The set is fixed, since each value is a contract with an outside reader (people, `gg plan --replan`, gg's own
    override logic). Adding one (for example `merged`) is a deliberate change with its label.
  - (c) Publishing (`pr-ready`, later merge) is an Action in an ordinary deterministic Vertex. The shipped Flow gets a
    `publish` Vertex that requires the `test` command.
  - (d) A Vertex containing a publishing Action must require at least one Check, and the Action runs only on fresh
    passing results (R1b). This replaces Q3g's routing fence: whatever path the work took, it is published only after
    passing Checks in the Vertex that publishes it.
  - (e) Every path to `end: ready-for-qa` must run `pr-ready`, checked at admission with the per-Outcome path analysis
    (S4).
  - (f) A Vertex with no agent step has an implicit Claim `ok` that requires all its Checks.
  - (g) Rich blocked and replan reports may be deterministic Vertices before the end.
  - (h) Fault, hold and abandonment keep their engine-owned paths, independent of user config, and end with
    `needs-human`.
  - `needs-replan` ends the Ticket's Execution because replanning changes the Epic's Plan, which belongs to the Epic's
    plan section, not to any one Ticket.

- R12. Routing:
  - (a) `then` is dropped; every route is written in `route`.
  - (b) Every Outcome a Vertex's own config can produce (tokens, rule Outcomes, `otherwise`) must be
    routed, explicitly or by the Vertex's `"*"` catch-all, or admission fails.
  - (c) The engine Outcomes (`harness-timeout`, `harness-transient`, `harness-unparsed`) route to `end: needs-human`
    unless the Vertex routes them.
  - (d) `gg doctor` shows, for each Vertex, which Outcomes fall to `"*"` and which to the engine default.
  - (e) The shipped Flow (Procedure names and input paths illustrative; exact spelling is S3's):

    ```yaml
    agents:                                    # no harness or model in the defaults Layer
      implementer: { persona: implementer.md, access: workspace-write }
      reviewer:    { persona: reviewer.md,    access: read-only }
      senior:      { persona: implementer.md, access: workspace-write }   # meant for a stronger model
    flows:
      default:
        ticket:
          entry: red
          vertices:
            red:
              use: implementer
              procedure: tests-fail            # tests: write
              inputs: { findings: { from: reviewer.review.findings, optional: true } }
              route: { ok: green, "*": { end: needs-human } }
            green:
              use: implementer
              procedure: implement             # tests: frozen; recover: test-fix
              inputs: { tests: { from: red.commit.files }, evidence: { from: red.red-check.evidence } }
              route: { ok: reviewer, "*": { end: needs-human } }
            reviewer:
              use: reviewer
              procedure: review                # ok requires review-pass; repeat Check; needsTest field
              route:
                ok:        publish
                retest:    { to: red,             max: 2, exhausted: senior-dev }
                changes:   { to: implementer-fix, max: 2, exhausted: senior-dev }
                repeat:    senior-dev
                misscoped: { end: needs-replan }
                "*":       { end: needs-human }
            implementer-fix:
              use: implementer
              procedure: fix                   # tests: named: inputs.findings
              inputs: { findings: { from: reviewer.review.findings } }
              route: { ok: reviewer, "*": { end: needs-human } }
            senior-dev:
              use: senior
              procedure: fix
              maxVisits: 1
              exhausted: { end: needs-human }
              inputs:
                findings: { from: reviewer.review.findings }
                previous: { from: implementer-fix.rescue, optional: true }
              route: { ok: reviewer, "*": { end: needs-human } }
            publish:                           # no agent step
              procedure: publish               # requires the test command; push, pr-upsert, pr-ready
              route: { ok: { end: ready-for-qa }, "*": { end: needs-human } }
    ```

  - Notes: Vertex `maxVisits` is in the request (section 3.3) but not built; it lands with routable Outcomes (S6),
    since `senior-dev` depends on it for its bound. `senior` is a new Agent the user must configure; the example
    Layers gain a `senior` entry.

- R13. Nested fields, arrays and inputs:
  - (a) Rules may use dotted paths into nested objects, ending at an enum, boolean or integer field
    (`response.risk.level`). They never index arrays; arrays reach rules only through Check states (R4).
  - (b) Inputs carry any JSON value (scalar, object, list), typed from the producer's schema or gg's own outputs.
  - (c) `pick: <field>` projects a list of objects to a list of one field (`findings` with `pick: file` gives the
    named file paths), replacing the interpreter's hard-coded `findings.map((f) => f.file)`.
  - (d) Only enum, boolean and integer inputs are matchable in rules; lists, objects and free text are for Briefs and
    templates. `tests: named:` requires a list of strings, checked at admission.
  - (e) Every path (rule paths, input `from` paths, `pick` fields, `response` Check fields) is validated against its
    schema at admission.

- R14. Simplifications (closes review question 6):
  - (a) `onFail` is dropped. A `failed` table with no matching rule falls to `otherwise`, then to the routing default
    (R12).
  - (b) `visits: all` is dropped until a use case needs it; inputs read the latest Visit that produced the value (S4).
  - (c) Routing the `harness-*` Outcomes stays as decided (Q3f).
  - (d) One first-match evaluator and one analyser (R8) serve the `passed`, `failed` and `stopped` tables.
  - (e) One resolver and validator handle every reference path (rules, Briefs, templates, Check parameters,
    `tests: named`).

## Review round 2 (2026-10-21)

The merged review is [user-defined-procedures-review2.md](user-defined-procedures-review2.md).

- T1. What is published must be what was checked:
  - (a) A publishing Action (`pr-ready`, later merge) runs only if each required Check's recorded tree equals the tree
    of the commit being published and the worktree is clean at that commit; otherwise the Ticket holds. The target
    commit and its evidence are kept through retries and Reconciliation.
  - (b) A Check must leave the worktree tree unchanged; if it changes it (a formatter, an unignored coverage
    directory), the Check fails with that reason.
  - (c) Admission requires a commit on every passing path of a write Vertex, which makes R2d enforceable.
- T2. The draft PR stays early: `implement` and `fix` keep push and a draft `pr-upsert` after their commit. Only
  `pr-ready` and later merge are publishing Actions under R11d. `publish` re-renders the PR body and marks it ready.
- T3. A Flow declares default `routes` that every Vertex inherits and may override in its own `route`. R12b reads
  "every Outcome is routed by the Vertex or by the Flow's defaults", and `gg doctor` shows which applied. The shipped
  Flow's defaults are `misscoped: { end: needs-replan }` and `"*": { end: needs-human }`, so any agent that finds the
  Ticket misscoped reaches the planner. R9b's Outcome is named `misscoped`.
- T5. Vertex `maxVisits` and the Ticket's Action Cap (in the request and glossary, not on main) are built in the
  option 1 slices, no later than the slice that ships the new Flow, and before grey-goo-ri issue #23. The shipped
  `repeat` edge gets its own bound (`max: 1`).

- T4. Recovery and passes (replaces per-Check `recover`, Q3b, and R1d's ordering rule):
  - (a) Recovery is a Vertex setting, `recover: { max, brief }`. After a pass in which a Check the claimed token
    requires failed in a recoverable way, while recoveries are left, the agent's Session resumes with a recovery Brief,
    then every Check runs again (R1a).
  - (b) Each Check may supply `recoverBrief`; the recovery Brief is the Vertex's `brief` frame plus the section of
    every Check that failed in that pass, with its output. A Check without one gets a default section (its name and
    failing output).
  - (c) Each Check kind declares which failure modes are recoverable (`tests-fail`: tests unexpectedly passed is,
    named tests missing from the output is not; `command`: a non-zero exit is, a timeout or a missing command is
    not). A Check may set `recoverable: false`. Integrity Assertions are never recoverable.
  - (d) A Vertex-level `pass` (Recovery Number + 1) runs from 1 to 1 + `recover.max` and is matchable in rules.
    Checks record only `state` (`passed`, `failed`, `not-run`) from the last pass; per-Check `runs` is dropped, and
    R8b's coupled state-and-runs field with it.
  - (e) A different agent or approach for a failing Check is routing, not recovery: `recoverable: false` plus a
    `failed` rule to another Vertex (R5 rescues the work).
  - (f) The frozen Check signal (S6) is `{ id, kind, state, tree }`.

- T6. `from` accepts one source or a list. With a list, the input takes the value from the latest Visit, in the
  Execution's Visit order, that produced any of the sources. All sources must have the same type, checked at admission;
  the snapshot's provenance (S4) names the source that supplied it. A required list input needs one of its sources on
  every path (Q7). The shipped reviewer's "latest implementation report" reads from `green`, `implementer-fix` and
  `senior-dev`.
- T7. When no `failed` row matches and the table has no `otherwise`, the Outcome is the engine Outcome `failed`, never
  the Claim token. It is routable and defaults to `end: needs-human`, like the `harness-*` Outcomes (R12c). Admission
  lists it among the Vertex's Outcomes unless the `failed` table covers every case (R8).
- T8. Shipped Flow fix: a `tests: named` Procedure reads a list of file paths, so `implementer-fix` and `senior-dev`
  take `testFiles: { from: reviewer.review.findings, pick: file }` and `fix` declares `tests: named: inputs.testFiles`
  (R13c, R13d already require it).
- T9. Admission errors when an `optional` input has no path on which any of its sources is produced (the per-Outcome
  path analysis, S4). The shipped Flow routes `implementer-fix`'s failures to `senior-dev`, so `senior-dev.previous`
  (the rescued work, R5) is produced.
- T10. An absent `optional` input never holds the Ticket; only a missing required input, which admission prevents,
  would. For a matchable optional input, `absent` is a value in the rule domain (R8 includes it), and a condition on a
  field of an absent input does not match. Briefs and templates render it as empty.
- T11. Q1's `gg doctor` warning on a read-only Vertex advancing on its Claim alone is dropped; R11d guards publishing.
  The rest of Q1 stands.
- T12. `testPaths`' default lives in code (`DEFAULT_TEST_GLOBS`), not in `defaults/gg.json`. A `testPaths` key in the
  defaults or user Layer is a load error, as with `commands` (ADR 0013), so the repository's value arrives whole.
- T13. The shipped `failed` and `stopped` tables of `tests-fail`, `implement`, `review`, `fix` and `publish` are written
  out in full with the step 2 rewrite, including review's `review-pass failed -> changes`.
- T14. Wording, fixed in place: R7's closing sentence, R3e (dependency directories are excluded), R12b (no `onFail`),
  R6d (no whitespace in Action ids); the reading guide names the superseded names. The round-1 review's S7 field
  `session: fresh | resume` has no remaining use, since T4a always resumes the agent's Session.

## After round 2 (2026-10-22)

- P1. gg ships no default Flow. A Flow is the repository's own process, so nothing is merged in under it:
  - (a) Without a declared Flow, preflight and `gg doctor` fail, naming `gg init`, as a missing `test` command does.
  - (b) `gg init` writes the example Flow and its Agents into the repository Layer; after that the repository owns them,
    and a gg upgrade never changes them. Improvements to the example reach existing repositories through release notes.
  - (c) The example lives in the docs and in `gg init`'s output. A test proves it passes admission and pins its golden
    trace; every other test uses fixture Flows.
  - (d) Amends D3 (no shipped defaults-Layer Procedures), T3 (the default `routes` are the example's) and R12e (the
    shipped Flow is the example Flow; the step 2 draft keeps its content).
- P2. Flows and Procedures, with their tables, are declared only in the repository Layer. A `flows` or `procedures` key
  in the defaults or user Layer is a load error naming the file, as with `commands` (ADR 0013), so a Flow arrives whole
  and R10's cross-Layer replacement no longer applies. The user Layer keeps per-person settings, such as an Agent's
  harness, model and effort.
- P3. gg ships no library of Procedures, Briefs, Personas or schemas. gg's code holds only its Actions, Check kinds and
  fixed integrity rows; `gg init` writes the whole example (Flow, Agents, Procedures, Briefs, Personas, schemas) into
  the repository. A shipped library would save a few lines in each repository but change behaviour silently on upgrade,
  and hide that Briefs need the template mechanism, which user Procedures need anyway: the example's Briefs prove it
  before the example ships. This lifts the "shipped Personas only" shortcut in `lib/config.mjs`.
- P4. `testPaths` is required in the repository Layer, like `commands.test` (amends R3e and T12). Preflight rejects a
  missing or empty list or a value that is not a glob string, naming the file. `gg init` writes today's
  `DEFAULT_TEST_GLOBS`. Excluding dependency directories stays gg's own rule, in code.
- P5. The example Flow's open questions (step 2 draft):
  - (a) The review's `ok` requires nothing (amends R4b). The `passed` table's first row, `ok` with `review-pass`
    passed, is the only way to `ok`; anything else is a repeat, a retest or `changes`. So an `ok` review that fails
    review-pass still posts its comment and PR update, as today. R11d guards publishing in `publish`; `gg doctor`
    shows if a replaced table drops the row (R10b).
  - (b) With no required Check, the review has no `failed` table; `otherwise: changes` serves the `passed` table.
  - (c) `publish`'s failing `test` ends at `needs-human` through the Flow's `"*"`.
  - (d) A `response` Check may take `all-of: [...]` over R4a's forms, passing when every condition holds; its failing
    output names the conditions that failed, as `reviewPass`'s `reasons` do.

## Review round 3 (2026-10-22)

The merged review is [user-defined-procedures-review3.md](user-defined-procedures-review3.md).

- U1. Briefs and templates have two sources. gg's own context (the Ticket, base, branch diff, Declared Commands,
  History, provenance, Action Marker, and the test files changed since the Execution's first test commit, R3d) is
  available to a Brief or template that names it, never inserted; gg computes a value only when a template names it.
  Everything a Vertex produced comes through `inputs` (Q7). The example's `reviewer`, `publish`, `implementer-fix`
  and `senior-dev` declare `report`, `red` and `green` (T6 lists). Context size stays per Brief, as today.
- U2. "No file under `testPaths` changed since the Visit's baseline" is a non-recoverable `tests-fail` failure (T4c),
  as today's "No tests were written". In the example it is `failed`, routed by the Flow's `"*"` to `needs-human`, on a
  retest Visit too. A `commit` with nothing to commit is a no-op with `files: []`.
- U3. R9a's `reason` enum gains `none`, since strict schemas require every field.
- U4. The review's `passed` table has three intended partial overlaps; the third, `ok` with review-pass passed and
  `needsTest: true`, stays `ok`. The example's admission summary names all three.
- U5. R5a and R5b decide on the effective target, after edge `max` and `maxVisits` exhaustion: a failure whose route
  is exhausted to an end leaves the work in place.
- U6. A stop token's template replaces the end's Terminal Reason comment and must include the reason, so the Ticket
  gets one comment. `end: needs-replan` also posts the diagnosis to the Epic, as fixed end behaviour (R11b).
- U8. Carried into slicing (step 7): working `gg init` and `gg doctor`, repository-Layer Briefs, Personas and schemas,
  and this repository's own Flow, Procedures and `testPaths` land before `agents`, `flows` and `defaults/personas`
  leave the defaults Layer. The slice names the tests that load the shipped Flow and adds `senior` to
  `examples/*.json`.
- U9. One pinned repository `testPaths` value feeds every consumer: Test Immutability, the rollback set,
  `TEST_PATHSPECS`, the review's changed-test list and `events.diffStats` (replacing its own `TEST_PATH` regex). A test
  covers test files outside today's globs.
- U7. Q3c's Vertex option to remove a Check from a token's `requires` is dropped, with its `gg doctor` warning. With
  no shipped library (P3) the repository owns every Procedure and edits `requires` directly; a relaxed variant is a
  second Procedure, visible as such. Integrity Assertions were never in `requires` (R3a).
- U12. A Procedure may declare `access: read-only`, which caps its Agent's access whatever the Agent declares, as
  today's `review`; `gg doctor` shows each Vertex's effective access. The example's `review` declares it.
- U13. A Procedure, Check or later gate names a Declared Command (`command: test`), never a command line, so ADR
  0013's allowlist stays the only source of what runs unsandboxed. The validator (V1) errors on any named command the
  repository Layer does not declare, generalising preflight's `test` rule (`config.commandProblems`); `test` stays
  required.
- U15. P4 is grey-goo-ri issue #96's option 1: a repository adds its test launcher to `testPaths`, and Test
  Immutability, rescue and rollback cover it. ADR 0014 records the limit that `package.json` cannot be listed without
  also freezing dependencies, so `scripts.test` stays exposed unless `test` calls a launcher file; #96 stays open for
  that.
- U14. The Check-to-command binding becomes data. `CHECK_NAMES` and the `checkOutcome` Outcomes `gate-failed(test)`
  and `red-failed` are removed in the slice that ports the Checks: a final failure is whatever the `failed` table says,
  else the engine's `failed` (T7). Which Check failed is in the Check signal (S6), and the Terminal Reason is rendered
  from it. Behaviour is unchanged (both routed to `needs-human` before, and `failed` does through `"*"`); the golden
  traces and Terminal Reason texts change, and ADR 0014 amends request section 3.4's illustrative enums.

## Open

- Step 2 is done: [user-defined-procedures-example-flow.md](user-defined-procedures-example-flow.md).
- Round 3: U10 and U11 on hold (see the merged review).
- Revisit: migration of old records instead of holding them (R7d).
- Step 7: slice option 1 into tickets.
- The ADR draft reversing request section 3.4.
