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
| R4b, T13: the review's `ok` requires `review-pass`; its `failed` table | P5a: `ok` requires nothing; a `passed` row decides |
| Q7: Briefs and templates read `inputs` | U1: plus gg's own context, by name only |
| R9a: `reason` enum | U3: gains `none` |
| R5a, R5b: rescue by the route's target | U5: by the effective target, after exhaustion |
| R11a, S5: end comment and stop template | U6: the stop template replaces the end comment |
| Q3c: a Vertex option may remove a Check from `requires` | U7: dropped; declare a second Procedure |
| Q7, R12e: `<vertex>.<action>.<field>` with the response implied | W2: `response` is named |
| T2, R12e: `draft: true` on `pr-upsert` | W4: no flag; `pr-upsert` never changes draft state |
| T4a, T4b, T4d: `recover` as a Vertex setting | W1: a Procedure setting, applying per Visit |
| R10a: rule tables in any Layer | P2: Flows and Procedures in the repository Layer only |
| Round-1 review S7: `session: fresh \| resume` on agent Phases | T4a: recovery always resumes the agent's Session; no field |
| Request 3.3: the `approval` vertex as its own kind | X1: an `await-approval` Action in a Procedure with no agent step |
| U2: "no test file changed" is non-recoverable | K7: recoverable once, then `failed` |
| K2: the example's `actionCap: 40` | V2: 128 |
| I3, request 3.3: the Action Cap bounds a cycle; every Vertex has `maxVisits` | V3: a cycle needs an edge `max` or a `maxVisits`; `maxVisits` is optional |
| R8c: box subtraction | V5: enumeration over the finite partition |
| ADR 0011: a change after the last heartbeat is not the agent's and holds | V9: no heartbeat rule; the Rescue Ref keeps every change |
| V9: rescue verification catches a surviving writer | N1: reset only after confirmed termination; uncontained holds |
| T4c, K7: named tests missing from the output are not recoverable | N5: recoverable |
| U11: `red`'s `no-test` falls to `"*"` | N6: routes to `green`; the reviewer judges it |
| P5c: `publish`'s failed test ends at `needs-human` | N4: re-runs once first |
| N6: the reviewer judges a no-test claim when `red` is absent | N10: when `redReport.reason` is `no-test-needed` |
| V2: the example's `actionCap: 128` | M3: 160 |
| R3a, V6: a wrong red test reaches a human through green's failures | M2: green stops with `bad-test`; red rewrites once |

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
    new findings, `failed` a repeat. Not required by `changes`, it is a fact rules route on. It matches only exact
    repeats: a reworded finding counts as new, and the `changes` edge's `max` is the backstop (N8).
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
    passing Checks in the Vertex that publishes it. The example's `publish` re-runs a suite that already passed on the
    same tree on purpose: publishing never depends on which Vertex ran before it, for one extra suite run per Ticket
    (M4).
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
  retest Visit too. A `commit` with nothing to commit is a no-op with `files: []`. Amended by K7: the failure is
  recoverable, and `failed` follows only after recovery.
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
- U10. R5b stands for every Vertex, `red` included: a failure routed to an end leaves the work in the worktree, with no
  Rescue Ref and no reset. Today a failed red is discarded (`lib/interpreter.mjs:523`). Rescue Refs are written only
  for an interrupted Attempt (ADR 0011, grey-goo-ri issue #68) and for R5a.
- U11. `retest` exhausted goes to a `senior-red` Vertex: `tests-fail` with the `senior` Agent, `maxVisits: 1`, routing
  `ok` to `green`, so the stronger model writes the failing test and the red-before-green proof holds. `senior-dev`
  keeps `tests: named`, since a Vertex that must make tests pass must not also be free to edit them (R3c). The `reason`
  enum of `tests-fail`'s schema gains `no-test-needed`; its `stopped` table maps it to the Outcome `no-test`, which
  `senior-red` routes to `senior-dev` (rescued and reset, R5a) and `red` leaves to `"*"` (no review exists on its
  first Visit, S4). `green`'s inputs and `senior-dev.previous` become lists across `red`/`senior-red` and
  `implementer-fix`/`senior-red` (T6).

## Review round 4 (2026-10-22)

The merged review is [user-defined-procedures-review4.md](user-defined-procedures-review4.md).

- W1. `recover: { max, brief }` is a Procedure setting, like `tests` and `access`, applying per Visit of any Vertex
  that uses the Procedure. Every Vertex using a Procedure gets its budget; a different budget is a second Procedure (U7).
  T4's semantics stand: one budget and one Session resume per pass, every failing Check's section in the recovery
  Brief, every Check rerun. Amends T4a's "a Vertex setting" and T4b/T4d's "Vertex-level".
- W2. One reference form: `<vertex>.<action id>.<field>`, where an agent Action's output is `response`
  (`reviewer.review.response.findings`, `green.green.response`); a Vertex's own outputs omit the Vertex
  (`test.evidence`). R13e validates every reference in this form.
- W3. `<vertex>.rescue` is the one Vertex-level output, `{ ref, diffStat, output }`, written by gg when R5a rescues
  the Vertex's work; T6's same-type check compares it across Vertices.
- W4. `pr-upsert` creates the PR as a draft and never changes its draft state, as `upsertPr` does today
  (`lib/github.mjs:93-101`); it has no `draft` flag. Only `pr-ready` makes a PR ready (R11d).
- W5. The `comment` Action takes `target: pr | ticket`; the review's comment targets the PR, as today
  (`lib/interpreter.mjs:823`). A stop token's comment always goes to the Ticket (U6).
- W6. U1's gg context adds the Terminal Reason and the end's name, for stop templates. The example's `blocked.md`
  reads `summary` and `diagnosis`, which every response schema has, and each Brief tells a blocked agent to explain in
  `diagnosis` (today's blocked comment reads `notes`, which the review schema lacks).
- W7. `implementer-fix` declares `previous` optional too, since the shared `fix.md` reads it.
- W8. Stale text: T13 joins the R4b → P5a reading-guide row; the example's Brief note says `red` also reads `findings`.
- W9. `end: needs-replan` posts the same rendered stop-token comment to the Epic as to the Ticket; no response field is
  reserved (D3). This settles U6's "fixed end behaviour".
- W10. `green` declares `findings: { from: reviewer.review.response.findings, optional: true }`, so after a retest it
  sees the review's other findings; absent on the first Visit (T10).

## After ADR 0014 (2026-10-22)

- X1. A human approval inside a ticket Flow is a gg Action, not a kind of Vertex (D3):
  - (a) `do: await-approval` with `decisions: [<outcome>, ...]` (request 3.3's default is `approved` and `rejected`),
    each matching `[a-z][a-z0-9-]*`. It is the last Action of a Procedure with no agent Action; Checks before it run
    first, and a failed one gives `failed` as usual (R11f), so the human is never asked about work that failed.
  - (b) Reaching it writes the Approval Request (ADR 0003, request 3.5: Pending Instance, digest of branch HEAD, ticket
    body revision and full config hash, the Await Label, one comment) as write-ahead Actions, and ends the run for
    that Ticket, which is Awaiting, not Stuck.
  - (c) A later run consumes exactly one authorised Decision as in request 3.5. The Decision is the Visit's Outcome,
    routed like any other: by the Vertex, the Flow's `routes`, or `"*"`. A stale digest, a missing record or two
    surviving Decisions retire and re-request without ending the Visit.
  - (d) The validator treats `decisions` as the Procedure's Outcomes (R12b); every Decision label the Flow can request
    must exist in the repository (request 3.3's label check).
  - (e) Built inside the option 1 Epic, before grey-goo-ri issue #23, so #23 freezes the Pending Instance and
    consumption record fields with everything else.
  - (f) Plan approval at the Epic level stays with `gg plan` and `gg publish` and is not part of this design.
  - Glossary, with its slice: Approval Vertex becomes "a Vertex whose Procedure ends in an `await-approval` Action";
    Vertex loses its three kinds.
- X2. Choosing a Flow per run joins the Epic, so a repository can run a lighter Flow (a small bug fix) as soon as
  option 1 lands, without waiting for request slice 5:
  - (a) `gg run <n> --flow <name>` selects a Flow the repository Layer declares; without it, `default` runs. An
    unknown name fails preflight, listing the declared Flows. The chosen name is pinned with the record, and a
    resumed Execution keeps its Flow whatever `--flow` says.
  - (b) A Flow declares `plan` explicitly, `null` when it has no Epic-level planning; a missing key is a validation
    error, since nothing a repository configures is silently defaulted. The example writes `plan: null`.
  - (c) Per-ticket Flow choice inside one Epic (for example by label) is not part of this design.
  - (d) Until Epic planning is designed (request slice 7), `plan` must be `null`. A non-null value is a validation
    error saying Epic planning is not built yet, so nothing unvalidated is accepted.

## For request slice 7: planning Flows (owner requirement, 2026-10-22; not yet designed)

- X3. The owner wants to define a planning Flow that engages several agents to research and evaluate the plan's
  details, with a review after each round of interactive planning. In option 1's terms that reads as a bounded
  loop at the Epic level, for example:

  ```text
  draft (interactive planner) -> research (one or more agents) -> evaluate -> review
  review: changes -> draft (next round, findings in its Brief; bounded edge), ok -> approve (await-approval, X1)
  approve: approved -> publish tickets, needs-changes -> draft
  ```

  What option 1 already gives it: Procedures as data, inputs between Vertices, rule tables, bounded back edges,
  `await-approval`. What it would still need, to design in slice 7:
  - (a) An interactive agent Action: the Session ends when the human finishes the round (`gg plan --finish`), and
    its output is the plan document rather than a Claim.
  - (b) Executions owned by an Epic. Today an Execution belongs to a ticket: its id is `<ticket>.<hex>`
    (`record.createExecution`) and `ticket_start`/`ticket_end` require `ticket` (`lib/events.mjs`).
  - (c) Where the plan lives between rounds (a branch and worktree, or the Epic Record), and a
    `publish-tickets` Action for what `gg publish` does.
  - (d) Research by several agents at once is fan-out, deferred (request section 7, R2f); sequential Vertices work
    without it.
  - Decided (owner, 2026-10-22): (b) touches the record and Event schemas grey-goo-ri issue #23 freezes, so #23
    names an Execution's owner generically, `{ kind: ticket | epic, number }`, and slice 7 needs no version bump.

## Review of the filed Epic (2026-10-22)

Round 5 ([merged](user-defined-procedures-review5.md)) reviewed the Epic grey-goo-ri issue #101 as filed. The owner
accepted Y1–Y4 and Y7–Y15 as recommended, and the issues were edited to match.

- Y6. The `changes` Check kind is deferred: ADR 0014 and request 3.4 name it as built after option 1, and the Epic's
  Out of scope lists it. It has no decided parameters, and the example does not use it.
- Y5. The validator is a new module, `lib/validate.mjs` (issues #106 and #107), with its own Resolved Flow, so it
  stays parallel to the engine work. `resolveFlow` in `lib/flow.mjs` stays the interpreter's loader, changed only by
  the serial engine tickets (#112, #113), until #116 switches admission to the validator and deletes it; #117 then
  extends the validator's Resolved Flow (Y16).
- Round 5b: the owner accepted Y16–Y21 as recommended, and the issues were edited to match.
- Y18. End, hold and fault reporting Actions keep the end's name in the Vertex slot and get fixed Action ids
  `<report>-<step>` with Recovery Number 0 (issue #111): `<report>` is `end`, `hold` or `fault`; `<step>` is
  `comment`, `epic-comment` or `label` (and `pr-ready` until issue #112). One shared id such as `hold` would give a
  hold's comment and label one marker, so the label would find the comment's evidence and never be set. Example:
  `gg:142.4f9e21:needs-human:1:hold-comment:0:<run>:1`. Issue #23 freezes these ids.
- Y22. A Vertex id may not equal an end name (`ready-for-qa`, `needs-human`, `needs-replan`), so a Vertex's Action
  markers never collide with end reporting's (issue #106).

## Review round 6 (2026-10-22)

Round 6 ([merged](user-defined-procedures-review6.md)) reviewed all 25 issues with fresh reviewers. The owner accepted K3–K6 and K8–K14 as recommended,
and the issues were edited to match. K7 was decided after research.

- K1. `approvers` is an optional top-level list of GitHub logins in the repository Layer, like `testPaths` a load
  error elsewhere; without it only write permission or higher counts (request 3.5). Issue #119 also extends the
  validator for `decisions`, has `ensureLabels` create the Await and Decide Labels, and adds the `gh` timeline and
  permission verbs.
- K2. The Action Cap stays, as a required Flow key `actionCap` (a positive integer counting every Attempt in the
  Execution, request 3.3); the example writes 40. Comparable systems all add one run-wide bound over per-step limits
  (LangGraph `recursion_limit`, OpenAI Agents `max_turns`, OpenHands `max_iterations`, Step Functions' history limit).
  A spend budget (tokens or cost) is a later ticket. It sums gg's own `usage.delta` (request 3.7); `claude -p
  --max-budget-usd` is only a per-Attempt fuse, since spend restored on `--resume` does not count toward it and spend
  can pass it (M6).
- K7. U2 is built, and its first part is now recoverable. An agent that judges no test needed already has the stop
  reason `no-test-needed` (U11); a red that claims `ok` with no test file changed is a Claim its evidence
  contradicts. Agentic TDD tools answer that with feedback and a bounded retry, then escalation (TDD Guard and
  pi-red-green keep the agent in red with the reason; bounded-repair pipelines cap retries, then escalate; TDFlow,
  EACL 2026, finds test writing the hardest step, so a miss is ordinary). So:
  - Issue #113: every `commit` records `files`; nothing to commit makes no commit and records `files: []`, since
    #113's Flow reads `red.commit.files` and runs before #114.
  - Issue #114: the `tests-fail` failure "no file under `testPaths` changed since the Visit's baseline", where any
    path in the baseline-to-worktree diff counts (added, modified, deleted, either side of a rename), replaces the
    commit Action's special case.
  - Issue #115: that failure is recoverable within red's `recover` budget (T4c gains it); after it, `failed` is
    routed by the Flow, `"*"` → `needs-human` in the example. Named tests missing from the output stay
    non-recoverable.

## Review round 7 (2026-10-22)

Round 7 (Fable and Astra, fresh reviewers briefed to judge the Epic's intent against online research on comparable
agentic tooling) found every major design choice sound: Procedures as data over fixed Actions (GitHub Agentic
Workflows' safe outputs, Step Functions' closed step kinds), test-first gating with K7 (TDD Guard, pi-red-green,
TDFlow), Claims, Checks and first-match tables (Step Functions, Temporal, Camunda DMN), Session recovery (Aider,
Claude Code's Stop hook), routing to ends (Step Functions Catch, Copilot's draft PR), run-wide bounds (LangGraph,
OpenAI Agents, OpenHands), approval as an Action (LangGraph interrupts) and publishing a checked tree (branch
protection). The owner accepted the findings below, and the issues were edited to match.

- V1. Reaching the Action Cap stops the Flow's Actions; engine reporting (`end-*`, `hold-*`, `fault-*`) still runs,
  with its own retry, and its Attempts are traced. A restart after exhaustion resumes only that reporting (Astra A1;
  LangGraph reports `GraphRecursionError` outside the exhausted graph). Issue #117.
- V2. The example's `actionCap` is 128 (Astra A2). At 40, two `retest` loops (13 Attempts each pass) used 39 before
  `senior-red` started, so the example could not finish its own escalation. Issues #117, #120.
- V3. Every cycle contains an edge with `max` or a Vertex with `maxVisits`; the Action Cap is not a cycle's bound,
  since it is required and would make the rule vacuous (Fable F2). `maxVisits` is optional, as the example has it;
  request 3.3 is amended. Issue #107.
- V4. Engine Outcome names are reserved: no Claim token, table `outcome`, `otherwise` or `await-approval` decision
  may equal `failed` or an end name, or start with `harness-` (Fable F1; Step Functions reserves `States.*`).
  Issues #106, #119.
- V5. The rule-table analyser enumerates the finite partition of each table's domain (enum and boolean values,
  `absent`, `pass` 1 to `max + 1`, integer intervals cut at the table's constants) instead of subtracting boxes;
  findings are unchanged. Amends R8c; R8e's brute-force cross-check becomes the analyser (Fable F3). Issue #103.
- V6. `green`'s `failed` routes to a `senior-green` Vertex (`implement`, `senior`, `maxVisits: 1`), which reads the
  rescued work as `previous`, as `implementer-fix` escalates to `senior-dev` (T9). A failed `green` means the normal
  Agent could not pass the tests after its recovery; the senior Agent had not implemented (Fable F6). Issue #120.
- V7. A stop token still runs every Check, as request 3.4's table has it: the output is evidence for the human who
  reads the stop comment (Fable F4; reason recorded, no change).
- V8. `tests-fail` checks for a changed test file before running the command and skips the run when none changed,
  so one failure is reported and recovered (Fable F5). Issue #114. `fix.md` and `green.md` tell the agent to read
  rescued work with `git diff HEAD <ref>` (Fable F7). Issue #120.
- V9. The heartbeat ownership rule goes (Astra A3). The heartbeat is saved about every 60 s, so the agent can write
  after the last one; on Ctrl+C, a closed console, a tree kill or power loss no process survives to record the kill
  time; and on POSIX the agent's process group does not die with gg. The rule mostly turned ordinary crashes into
  holds. Since the Rescue Ref keeps every change, a human edit made between the crash and the resume moves into the
  ref, which the History names, and is not lost. ADR 0011 and issue #68 are amended; the heartbeat remains #67's
  liveness signal.
- Noted, no ticket: a per-Attempt turn cap (`claude -p --max-turns`) for the Claude Harness slice (Fable F8).

## Review round 8 (2026-10-23)

Round 8 (fresh Astra and Fable, the round 7 brief) again found the design sound against comparable tooling. The owner
accepted the findings below after a research pass, and the issues were edited to match.

- N1. An Interrupted Attempt's worktree is reset only after its writers are confirmed gone (Astra A1). The call
  intent records the containment (`job`: a Windows job object with kill-on-close; `none` otherwise) and the job
  helper's process id and start time. At resume a `job` helper still running (same id and start time) is killed and
  confirmed gone, then rescue, reset and retry; `none` (POSIX, or a helper that failed to start) is rescued and held,
  never reset. Research: Linux children outlive their parent unless a cgroup is killed (`cgroup.kill`, kernel 5.14);
  `PR_SET_PDEATHSIG` is per thread and not inherited; a job object with `BREAKAWAY_OK` loses only processes that
  explicitly break away (an accepted residual risk); fencing tokens need a store that checks them, which a
  filesystem is not. Linux cgroup containment is backlogged as grey-goo-ri issue #128. Issues #68, #118, #23 (which
  reserves the fields) and ADR 0011.
- N2. The rule-table analyser keeps V5's enumeration, with a work limit computed before it starts: points (the product
  of each mentioned field's partition size) times rows, an admission error above 10 million naming the table and its
  largest fields, never sampled (Astra A2). Exact analysis is NP-complete in general (SAT reduces to exhaustiveness,
  per rustc's pattern analysis), so box subtraction would not avoid the limit; rustc and `match-lang` likewise count
  work and report "too complex". #103 measures the analyser on a complex fixture Flow to set the limit and to show
  how often admission can afford to run it. Issue #103.
- N3. An unknown `intent.action` holds at Reconciliation; recognised Actions with no finder that are safe to repeat
  (`pr-upsert`, `pr-ready`) are listed and replay (Astra A3, completing round 6's K4). Issue #118.
- N4. The example's `publish` routes `failed` back to itself once (`max: 1`, then `needs-human`): its suite re-runs
  on a tree that already passed, so a failure there is most likely a flake (Fable F1). A rescue with nothing to
  rescue makes no ref and no reset. Issues #120, #107, #118.
- N5. "Named tests missing from the output" is a recoverable `tests-fail` failure, with its own section asking for
  the names as the runner prints them; a timeout or a missing command stays not (Fable F2; amends T4c and K7).
  Reading structured per-test results, with no format prescribed by gg, is backlogged as grey-goo-ri issue #126;
  it records the frozen Check signal and evidence shapes, so the freeze does not block it. Issue #115.
- N6. The example routes `red`'s `no-test` to `green` (rescued and reset, R5a). `tests` and every `red` evidence
  input are optional; the review Brief judges a no-test claim and sends it back with `needsTest: true` (`retest`,
  bounded by `max: 2` then `senior-red`); the PR body says when no failing test exists (Fable F3, option b; amends
  U11's routing). Issue #120.
- N7. The slices doc's #107 summary now says the Action Cap is not a cycle's bound (Fable F4, V3).
- N8. R4c records that `repeat` matches only exact repeats (Fable F5). A reviewer-marked repeat is backlogged as
  grey-goo-ri issue #127; the field lives in the repository-owned response, which #23 documents as opaque.
- N9. A Check's `evidence` output is produced only when the Check passed, as today (`lib/interpreter.mjs:733`). A
  failing Check's output still reaches the recovery Brief (T4b), the rescue's `output` (R5c) and the Check signal, but
  is never read as proof by a later Vertex or the PR body. Issue #114.
- N10. Correction to N6: inputs read the latest Visit that produced a value (S4), so after a `retest`, a red Visit that
  stops with `no-test-needed` leaves the earlier Visit's `tests` and `red` evidence in place, and "`red` absent" would
  not show the claim. Green, `senior-green` and every `&impl` reader take `redReport: { from: [red.red.response,
  senior-red.red.response] }`, required, since an agent Action responds on every Visit, stops included; the Briefs and
  the PR body show red's no-test notes whenever `redReport.reason` is `no-test-needed`. `no-test` still routes to
  `green` as N6 decided. Issue #120.

## Review round 9 (2026-10-23)

Round 9 (fresh Astra and Fable, the same brief) found the design sound; Astra saw no reason to reopen the
architecture. The owner accepted every finding.

- M1. `pr-ready` reads the PR's head (repository, ref and commit) fresh before every launch and retry and compares it
  with the checked target; a mismatch or a failed read holds (Astra A1). Without it, a push to the remote branch after
  gg's push would be marked ready on an unchecked commit: `viewPr` reads no `headRefOid` (`lib/github.mjs:104`) and
  `markReady` takes only the number (`:128`). Residual: the read and GitHub's ready call are not atomic, so a push
  between them cannot be excluded, as with GitHub's own required checks. Issue #112.
- M2. A green Vertex that finds red's test wrong stops with `reason: bad-test` (`implement.schema.json`'s enum gains
  it), which the `implement` Procedure's `stopped` table maps to the Outcome `bad-test`. The example routes it from
  `green` and `senior-green` to `red` with `max: 1`, then `needs-human`; the work is rescued and reset (R5a); `red`
  reads `previous: { from: [green.green.response, senior-green.green.response], optional: true }` and `red.md` shows
  its `diagnosis` when `reason` is `bad-test` (Fable F1). Green still cannot edit tests (R3a); a different agent
  judges the claim. TDFlow (EACL 2026) finds bad tests its main failure with no correction path, and ImpossibleBench
  found an explicit abort option cut test gaming from 54% to 9%. Issues #104, #120.
- M3. The example's `actionCap` is 160, since M2's detours lengthen the longest bounded path to about 155 Attempts
  with one recovery per agent Visit. Issues #117, #120.
- M4. R11d records why `publish` re-runs a suite that passed on the same tree (Fable F2).
- M5. The example's `tests-fail` comment lists N5's recoverable failure (Astra A2, Fable F4).
- M6. K2 records that a spend budget sums gg's `usage.delta`; `--max-budget-usd` is a per-Attempt fuse (Fable F5).
- Backlog: an opt-in `gg init --diff` showing how a repository's Flow differs from the current example (Fable F3),
  grey-goo-ri issue #130; P1b's no-silent-change rule stands.

## Review round 10 (2026-10-23)

Round 10 (fresh Astra and Fable) found the architecture sound. The owner's decisions:

- L1. The example starts at an optional `baseline` Vertex with no Agent (Procedure `base-check`: the `test` Check),
  `ok` → `red`, `failed` → `"*"` → `needs-human` naming `baseline.test` (Fable F1). It costs one suite run per
  Execution; a repository with a slow suite can drop it. Without it a red base fails every implementation Visit
  (about 11 Attempts and two senior calls) and ends at `needs-human` blaming the implementation; the example-flow doc
  records the trace. SWE-bench likewise takes its must-keep-passing tests from a base run. Reading the base's CI result
  instead was considered: GitHub's check-run, status and rollup APIs can disagree, CI may run another command, and a
  pending result says nothing. Issues #120, #107 (an agentless entry Vertex is admitted).
- L2. Every `pr-upsert` binds `redReport`, and `senior-red` declares the optional `previous` that the shared `red.md`
  reads (Astra A2: N10 and M2 were wired incompletely; #113 rejects an undeclared template name). Issue #120.
- L3. `.github/workflows/` and `.github/actions/` are Protected Files (Fable F2): gg pushes agent commits under the
  owner's identity, so an edited workflow would run with repository secrets before a human looks. Copilot's coding
  agent likewise holds its workflow runs for a person's approval. Never configurable (Q2). Issue #102, ADR 0014.
- L4. `review.md` reads the History, so a reviewer learns of a `bad-test` detour (Fable F3). History items are a kind
  and a sentence each, a few hundred tokens even near the Action Cap. Issue #120.
- L5. "Write or higher" means the REST collaborator `permission` field is `admin` or `write` (maintain folds into
  write, triage into read) (Fable F4). Issue #108.
- Noted: an Execution is time-bounded by per-call timeouts and the Action Cap together (Fable F5); no change.
- L6. Every process gg runs in a worktree kills its leftovers when it returns, and names them (Astra A1, extending N1
  to calls that return normally). Today the Windows helper leaves a finished command's background children running
  (`lib/winjob.ps1:115`), so a background writer could write after a rescue's verification or into the next
  Vertex's worktree. Windows keeps kill-on-close through cleanup; POSIX kills the process group and the observed
  descendants and confirms the group is empty; a process that starts its own session or explicitly breaks away is an
  accepted residual risk (Linux cgroups, grey-goo-ri issue #128, close it). Practice: the GitHub Actions runner kills
  a job's orphan processes at job end; hosted agents (OpenHands, SWE-agent, Copilot) discard the whole environment;
  Claude Code and Codex CLI users report leaked children as bugs, and Codex moved to killing the process group.
  #23's harness contract says a call returns only once its processes are gone, or reports that it could not
  confirm it, which holds a reset. Issues #118, #23.

## Open

- Step 2 is done: [user-defined-procedures-example-flow.md](user-defined-procedures-example-flow.md).
- Round 4 is decided (W1–W10).
- Revisit: migration of old records instead of holding them (R7d).
- Step 7 is done: filed as the Epic grey-goo-ri issue #101.