# User-defined Procedures: design review round 3, Fable (raw)

Fable, effort high, read-only (2026-10-22). Checked against the decisions, example Flow, round-2 review and handoff in
the worktree, and main at bd60df9.

## Blocking

**F1. The PR body and review Brief have no inputs to render from.** `fix`, `review` and `publish` all run `pr-upsert`
with `pr-body.md` (example-flow.md:88, 119, 142), and `publish` declares no `inputs` at all. Today's body carries the
implementation report, Red Evidence and Green Evidence on every re-render (`lib/render.mjs:110-146`,
`lib/interpreter.mjs:835-838`), and the review Brief carries both evidences (`lib/interpreter.mjs:616-617`). Under Q7
templates read `inputs.<name>` and the Vertex's own outputs, so as written `publish` renders an empty body and
`fix`/`review` lose Red Evidence. Fix: add `red: { from: red.red-check.evidence }` to `implementer-fix`, `senior-dev`,
`reviewer` and `publish`, and give `publish` the T6 list inputs `report` and `green` that `reviewer` has; or decide the
PR body renders from gg-kept record outputs and say so (that contradicts Q7's "replacing `render.prBody`").

**F2. "No tests were written" is no longer caught, and `commit` on an empty tree is undefined.** Today a red commit
with nothing staged ends `red-failed` and discards (`lib/interpreter.mjs:756, 777-782`); a fix with no edits skips the
commit (`:771-773`). In the example `tests-fail` passes whenever a named test fails (`lib/checks.mjs:45`), including a
pre-existing failure the agent names without writing anything; `commit` then has nothing to commit, `red.commit.files`
is empty and `green`'s Brief lists no tests. T1c only requires the Action to exist. Fix: define `commit` with nothing
to commit as a no-op producing `files: []`, and give `tests-fail` a required `changes` Check over `testPaths`,
`recoverable: false`, or fold "no file under `testPaths` changed" into `tests-fail`'s non-recoverable failures (T4c).

## Should change

**F3. R9a's `reason` enum breaks strict schemas.** Every property is required (`lib/briefs.mjs:2, 8`), so an `ok`
Claim must still pick from `misscoped | needs-input | environment`. Add a `none` value.

**F4. The review `passed` table has three partial overlaps, not two.** Row 1/row 3 (`claim: ok`, `review-pass`
passed, `needsTest: true` → `ok`) is not named. Name it and confirm an `ok` asking for a test is meant to be ignored.
P5a itself holds.

**F5. R5a rescues on the declared target, not the effective one.** `implementer-fix` `failed → senior-dev`, but when
`senior-dev`'s `maxVisits: 1` is spent the effective end is `needs-human`; R5a would rescue and reset, so the human
finds a clean worktree, against R5b's intent. Fix: R5a/b decide on the target after Edge `max`/`maxVisits` exhaustion.

**F6. Where the Epic diagnosis comment comes from.** R11a: reaching `end` posts the Terminal Reason comment and
"nothing else runs"; S5/R9b keep the replan diagnosis on the Ticket and its Epic (`lib/interpreter.mjs:931-947`). The
example's only stop template is `blocked.md` on the Ticket. State that `end: needs-replan` posts `response.diagnosis`
to the Epic as fixed end behaviour, or add an Epic target to the stop template.

**F7. Q3c's removable-Check option is dead text.** Removing `test` from `implement`/`fix`'s `ok` leaves a committing
token requiring nothing, which S2/T1c reject. Add a reading-guide row (Q3c → S2).

**F8. P1/P3/P4 delivery order and breakage to name in step 7.** `lib/doctor.mjs` is empty on main, so `gg init` must
exist before `flows`, `agents` and `defaults/personas` leave `defaults/`, or no repository passes preflight, this one
included (`.agents/gg/gg.json` holds only `commands`). Tests that load the shipped Flow: `test/defaults.test.mjs:8`,
`test/flow.test.mjs` (`loadDefaults`), `test/config.test.mjs:48, 86`, the golden traces in `test/interpreter.test.mjs`
and `test/run.test.mjs`, `test/personas.test.mjs`. P4 turns `TEST_PATHSPECS` (`lib/checks.mjs:82`, used at
`lib/interpreter.mjs:630` and in `rollbackSet`) into a per-repository value. `examples/*.json` need the `senior` entry.

## Questions for the owner

**Q1.** Today a failed red discards the agent's changes (`lib/interpreter.mjs:523`); under R5b a failed `red` ending
at `needs-human` leaves them in place. Intended?

**Q2.** `retest` exhausted goes to `senior-dev`, which runs `fix` with `tests: named: testFiles`, so the senior cannot
write the new failing test a `needsTest` review asked for. Intended, or `needs-human` / a `tests: write` Vertex?

**Q3.** The branch diff and R3d's changed test files are in today's review Brief (`lib/interpreter.mjs:608-611`); the
example declares neither. Which values does the Brief/template mechanism provide implicitly (ticket, diff, History,
provenance) versus by `inputs`? One sentence settles F1 too.

**Q4.** Today `review` forces `read-only` whatever the Agent says (`lib/procedures.mjs:63`, `lib/interpreter.mjs:619`).
In the example that comes from the Agent only; a user could give `reviewer` `workspace-write` with `requires: []`.
Does admission reject that, and is it a validator check (V1)?

## Confirmed

Every Outcome of every Vertex has a route; `review` cannot produce `failed`. All loops are bounded; `reviewer` sees at
most six Visits before the Action Cap. The tables evaluate as intended; no row is unreachable or never fires; the
`stopped` tables refine `blocked` to `misscoped` correctly. Required inputs have producers on every path per Outcome;
`pick: file` yields a list of strings (T8); the optional inputs each have a producing path (T9/T10). Commits sit on
every passing write path (T1c, S2); `pr-ready` runs only in `publish` after its own `test` (R11d, T1a); only `publish`
reaches `ready-for-qa` (R11e); `implementer-fix` failed → `senior-dev` rescues (R5). Versus today's flow, the review
comment, draft PR at green, push after each commit, still-green/test-fix recovery and the `fix` test baseline (R3c)
are preserved; the only silent losses found are F1, F2 and Q1. The reading guide covers every amendment traced.
Unverified: `all-of` and `repeat` Check semantics, since neither exists on main. Skipped: the R8 box analysis beyond
the overlaps, and `lib/reconcile.mjs` for T1a.
