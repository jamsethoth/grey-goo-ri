# User-defined Procedures: design review, merged

Two independent read-only reviews of `user-defined-procedures-decisions.md` (at 9f28d27) and the proposed slicing
S1–S6, 2026-10-21:

- [user-defined-procedures-review-astra.md](user-defined-procedures-review-astra.md): Codex gpt-6-astra, high effort.
  Verdict: request changes.
- [user-defined-procedures-review-fable.md](user-defined-procedures-review-fable.md): Fable 5.1, high effort.

Findings are merged where both reviews raised them, and checked against `main` at bd60df9. **Both** marks a finding
both reviewers raised independently. **Mine** marks an error in examples or wording I wrote during the planning
session.

## Changes on main since the decisions were written

- grey-goo-ri PR #92 (Node to Agent) is merged as f4daf19.
- grey-goo-ri PR #99 (issue #95) is merged as bd60df9: Declared Commands now come from the repository Layer's
  `commands` key, not `AGENTS.md`, and a user Layer may not set them. Its ADR is 0013, so this design's ADR is 0014.
  The decisions' references to "`AGENTS.md` `## Commands`" (D4, Q3b) must read "the repository Layer's `commands`".
  This strengthens I5: a command Check can only run a command the repository itself declares.

## Blocking: decide before slicing

**R1. After a recovery Phase, which Checks run again? (Both.)** Q3b and Q3d say a failing required Check runs its
`recover` Phase, but not which Checks run afterwards. If only the recovering Check re-runs, earlier results go stale.
Example: `pass` requires `suite` and `scope`; `scope` passes, `suite` fails; the recovery agent edits `src/`; only
`suite` re-runs and passes. Both look passed and the commit lands non-test changes. Today recovery re-runs the whole
Check, Test Immutability included (`interpreter.mjs:719`). Proposed fix: after a recovery Phase, every Check of the
Phase it recovers runs again, and a commit or acceptance reads only results newer than the last write step.

**R2. Which Claim controls a multi-Phase Procedure? (Astra; mine.)** My shipped example `tdd.ok: { requires: [red,
green] }` cannot work. After the red Phase, green is necessarily `not-run`, so applying Q3d at that point stops before
green runs. A Procedure with several agent Phases (red, green; with recovery Phases) needs: a Claim per agent Phase,
whose tokens require that Phase's Checks; Q3d applied at each Phase's end (a stop or a final required failure ends the
Visit there); and the final tables run once at the end of the Procedure with the last Phase's Claim. Today a non-ok
decision is carried across later Actions (`interpreter.mjs`, `state.decided`).

**R3. Test Immutability can be left out. (Both.)** Q3b lists `immutability` as an ordinary Check kind, so a Procedure
that lists no `immutability` step lets an agent rewrite committed tests, pass, commit and publish. The glossary counts
Test Immutability among the Integrity Assertions, which Q2 says can never be switched off. Proposed fix: it joins the
fixed integrity row, asserted before any Check or commit of every write Phase once a test baseline exists, and is
never declarable or recoverable. Its baseline becomes a gg-kept record fact ("the last commit that passed Test
Immutability", today `rec.outputs.testBaseline ?? red.sha`), and the files a review names are passed as an `except`
list.

**R4. `review-pass` and repeat routing have no home. (Both.)** The Q3b Check kinds omit `review-pass`, which today is
deterministic code over the Structured Response: `dodMet`, `tddEvidenceOk` and every finding's severity
(`checks.mjs:102`). Scalar rules (Q4a) cannot express "no finding is blocker or major" over an array, and an
agent-supplied summary boolean would weaken it. Without it the shipped review's `ok` has `requires: []`, which Q3g
forbids from routing to `done`. Proposed fix: keep `review-pass` as a gg primitive with explicit field references.
Separately, repeat routing is still a shortcut on main ("repeat is flagged but routes as changes until repeat routing
lands"); decide whether this work completes it.

**R5. What happens to the worktree when the `failed` table routes to another Vertex? (Fable.)** Q3a leaves the work
uncommitted. If the `failed` table routes to Vertex B, B starts on a dirty worktree. After a crash, admission's
dirty-state check holds the Ticket as changes gg did not make (`run.mjs`, `reconcile.dirtyState`), and the shipped
dirty-worktree guard is the literal `phase === 'red'` test that D3 removes (`interpreter.mjs:478`). Options: (i) the
failed branch resets to the Visit's first baseline through the write-ahead `reset`, as `red-failed` does today, and
routes with a History item; (ii) it commits the work as a marked work-in-progress commit first; (iii) a failed Outcome
may route only to a Terminal. (i) is the smallest and keeps ADR 0005.

**R6. A recovery Phase that runs twice reuses its marker. (Fable.)** With `recover: { max: 2 }`, the second run has
the same step id and Attempt 1 as the first, so `sideEffect` finds the first run's proof and returns its evidence
(`interpreter.mjs:282`). Today each recovery Phase has its own name and runs at most once. The marker, and the keys of
`rec.sessions` and `rec.retries`, must carry a recovery iteration, and grey-goo-ri issue #23 must freeze it.

**R7. Records in flight when the shapes change. (Both.)** Records are accepted by `schemaVersion` alone
(`record.mjs`), and markers have exactly seven parts (`marker.mjs`). S1 changes outputs, markers and keys. Under the
same version an old record loads and faults on `rec.outputs.red`, or a comment whose completion was lost is not
recognised and is posted again. Proposed fix: bump `SCHEMA_VERSION` in S1 and in each later shape change, so an old
record holds cleanly as unreadable; operationally, finish or hold every Execution before upgrading. "No version bump"
applies after the freeze, not before it. **Mine:** Q8's wording implied otherwise.

**R8. The overlap check algorithm. (Both; mine.)** "Testing each row's boundary values" is wrong for ranges. Rows
`x = 0`, `x = 10`, then `0 <= x <= 10`: testing 0 and 10 marks the third row never-fires, though `x = 1` reaches it.
Exact analysis needs a partition from all rows' constants (each constant, plus one value from every interval between
and outside them), combined across fields, with each row checked against the union of the rows before it. It must
enumerate only combinations Q3d can produce for that table (in `passed`, no required Check is `failed` or `not-run`;
in `failed`, later Phases are `not-run`; `not-run` implies `runs = 0`). It proves logical consistency over that
domain, not that an agent or command will ever produce a combination; that is V2's job.

## Should change

- **S1. The ADR must amend more than §3.4. (Both.)** Token-dependent `requires` changes ADR 0004's "acceptance means
  every declared Check passed", and routable stop tokens (Q6) reverse ADR 0004's "a blocked claim stops the ticket"
  and request §3.4's "blocked → needs-human, misscoped → replan". Name all three in ADR 0014, and the glossary's Action
  identity ("Phase and ordinal"), which reserves "step" as an avoided word.
- **S2. Drop commit `requires`. (Fable; Astra Q3.)** It duplicates the token's `requires` and the two can disagree.
  When an option removes `green` from `ok.requires`, the commit still requires it, so the Visit advances but skips its
  commit, and `pr-upsert` faults. The token list alone covers QA's `defects` case: `defects` requires only `scope`, so
  the commit runs while `suite` fails. Rule: a commit runs only when every Check the claimed token requires passed, and
  admission requires a token-required Check after the last write step.
- **S3. The no-match default is stated twice. (Fable.)** Q4 says the token; Q3d's `failed` branch says `otherwise`,
  `onFail`, then `needs-human`. Reword Q4 to the `passed` branch only.
- **S4. Inputs need Action-level analysis and fixed Visit semantics. (Both.)** A producer Vertex that takes a failed
  or stop route never produces its later steps, so "on every path" must be per Outcome. Define "latest" as the latest
  Visit that produced the step, not the latest Visit. Snapshot the resolved inputs and their provenance at Visit entry.
- **S5. Terminal reporting needs templates too. (Both.)** The blocked comment and the replan diagnosis to ticket and
  epic are chosen by literal Outcome names (`interpreter.mjs`) and read literal response fields. A stop token skips
  the remaining Actions, so a Procedure cannot post them itself. Proposed: `blocked: { stop: true, comment: <template> }`,
  folded into S5's templates; decide whether a rejected review still posts its comment before routing.
- **S6. The grey-goo-ri issue #23 reservations are short. (Both.)** Add: the generic Check signal `{ id, kind, state,
  runs }` and removal of `requireTestPass`, `repeat`, `exhausted` from the Action Event; a rule identity
  `{ table, row }`; the resolved-inputs snapshot; the recovery iteration (R6); the definition hash. For option 3: an
  unknown `intent.action` must hold, not default to absent as `reconcile.findEffect` does today (`?? ABSENT`); add
  record and event examples for a custom effect, its Confirmation and an interrupted run.
- **S7. Slicing.** Split S2 into S2a (the generic model, with the shipped Procedures behaving exactly as today, proved
  by fixtures) and S2b (removing the literal special cases). Serialize every interpreter-touching slice: request §6
  allows one interpreter-touching ticket in flight, so S4 and S5 are not parallel. Name in each slice its golden trace
  regeneration, its glossary entries and its `gg doctor` output. Add `session: fresh | resume: <step id>` on agent
  steps to S2a (still-green resumes red, test-fix resumes green, a missing transcript falls back to fresh).

## Questions for the owner

1. **Can a later Vertex drop a failed requirement? (Astra.)** Vertex A's required `suite` fails; A routes to B; B
   requires only `lint`, passes and routes to `done`. Every local rule holds, yet the suite still fails. Carry
   unresolved requirements with the work to `done`, or let B's own Checks decide?
2. **What replaces `then`, and which defaults need no explicit route? (Astra.)** `then` today means "the route for
   `ok`". Q3e rejects unrouted Outcomes, while stop and harness Outcomes default to `needs-human`.
3. **Does this work complete repeat routing? (Astra.)** See R4.
4. **May rules and inputs reach into arrays and nested fields? (Fable.)** Needed for the review's named test files and
   R3's `except` list.
5. **In-flight Executions at the upgrade (R7):** finish or hold them by hand before upgrading?
6. **Simplifications Fable proposes, each reversing a decision you made:** drop `onFail` (the `failed` table's
   `otherwise` defaults to `needs-human`); drop the `stopped` table until a use case needs it; drop `visits: all` and
   `optional` until one needs them; keep the `harness-*` Outcome names but defer routing them. Astra proposes one
   evaluator for the three tables and one resolver for Briefs and templates, which costs nothing either way.

## Confirmed sound by both

- D3/D4: data-defined Procedures over gg-owned primitives fit the architecture and ADR 0001.
- The fixed integrity, harness and parse rows first, never routable to a publishing Terminal.
- Q3g as stated stops `failed` rows and `requires: []` tokens from publishing directly.
- Q5's Confirmation contract mirrors today's finders and lookup budget; `unknown` never counts as absent.
- Pinning by hashing resolved definitions extends `rec.snapshot` without a new mechanism.
- First-match tables with a never-fires error and overlap warnings, as data, with no expression language.
- One validator shared by `gg doctor` and admission; V2 scenario runs as their own ticket.
