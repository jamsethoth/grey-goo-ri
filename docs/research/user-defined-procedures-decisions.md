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
- Q3d. **Under review.** The Outcome order (gg's fixed rows; a `stop` token; a required Check failed after recovery
  gives its `onFail`, skipping user rules; user rules; `otherwise`; the token) is to be revisited in detail, together
  with whether a token that can lead to `done` may have `requires: []`.
- Q3e. Admission lists every Outcome a Procedure can produce (tokens, `onFail` values, rule Outcomes, `otherwise`) and
  rejects any that has no route on the Vertex and is not a Terminal.

## Open

- Q3d. The Outcome order, and empty `requires` on a token that can reach `done`.
- Q3f. Whether harness exhaustion (timeout, transient, unparsed) is a routable gg-named Outcome; integrity and
  run-stop never are.
- Q5. An effect Action with no `find`.
- Q6. Whether stop Claims are routable.
- Q7. Data between Vertices for use case e.
- Q8. Whether grey-goo-ri issue #23 waits for this design.
