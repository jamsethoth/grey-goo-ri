# User-defined Procedures, Actions and Outcomes: decisions

The running record of the planning session. The research behind it is in
[user-defined-procedures.md](user-defined-procedures.md).

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

## Open

- Step 7: slice option 1 into tickets.
- The ADR draft reversing request section 3.4.
