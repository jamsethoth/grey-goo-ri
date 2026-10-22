# Design review, round 2: user-defined Procedures (decisions at 486babf)

Reviewer: Fable 5.1, read-only. Code references are to main at bd60df9. *(inference)* marks what was not checked against code.

## Blocking

**B1. R11d/R12e: the publishing Vertex checks the worktree but pushes the last commit.** Nothing requires a write Vertex to commit on its passing path. S2 rejects only "a committing token that requires no Check"; R2d says a passing write Vertex "leaves its work committed" but no rule enforces it. Config: Procedure `implement-nocommit` = agent (write) → Check `green` (command test); `ok: { requires: [green] }`; no commit Action. Flow: red → that Vertex → reviewer → publish. Results: the agent fixes the code uncommitted; `green` passes; reviewer ok; `publish`'s `test` Check passes on the worktree (fresh by R1b, since the tree it reads is the current tree); `push` pushes `record.lastCommit(rec).sha` (`lib/interpreter.mjs:747`) = red's test commit; `pr-ready` marks a PR ready whose head fails its tests. Verified work is not what is published. Fix: a publishing or push Action asserts the worktree tree equals the committed tree of the commit it publishes (index and tree clean at `lastCommit`), and R1b's freshness for publishing Actions compares the Check's tree with *that* commit's tree, not "the current tree". Optionally admission also requires a commit Action on every write Vertex's passing path.

**B2. R12e drops the draft PR, so the review comment has no target.** Today `tdd` ends with push and pr-upsert (`lib/procedures.mjs:14-15`) and the review's `comment` is posted on `rec.pr` (`lib/interpreter.mjs:779`); R4d says the review's comment and PR update still run. R12e's `implement` comment lists only `recover: test-fix` and puts push, pr-upsert and pr-ready in `publish`. On the shipped path red → green → reviewer, `rec.pr` is null when the reviewer comments: `gh.comment(null, ...)` faults, and the reviewer's `pr-upsert` cannot create a PR for an unpushed branch. Fix: state that `implement` and `fix` keep push and pr-upsert (draft) after their commit, that pr-upsert of a draft is not a publishing Action under R11d (only `pr-ready` and later merge are), and that `publish` re-renders the body and marks ready. This also decides which Vertices need the PR-body `inputs` (see S3 below).

**B3. R12e: `misscoped` is routed only from the reviewer.** R9b routes `reason: misscoped` to replan, but R10c puts routing in the Vertex's `route`, and `red`, `green`, `implementer-fix` and `senior-dev` have only `ok` and `"*": { end: needs-human }`. An implementer claiming `blocked` with `reason: misscoped` ends at needs-human without the diagnosis to the Epic. Today every implementer Phase's `misscoped` goes to `replan` (`lib/interpreter.mjs:37`; request 3.4). Fix: add `misscoped: { end: needs-replan }` to every agent Vertex in R12e, or let a Procedure's `stopped` table name an `end:` directly as its default.

**B4. R12e before S6 has an unbounded cycle.** `repeat: senior-dev` has no edge bound; `senior-dev`'s only bound is `maxVisits: 1`, which the note defers to S6, and main has no Action Cap or `maxVisits` (no match in `lib/interpreter.mjs`, `lib/run.mjs`, `lib/flow.mjs`). R12e says its spelling lands in S3. Between S3 and S6 reviewer → repeat → senior-dev → reviewer → repeat loops until the harness budget runs out. Fix: give `repeat` an edge bound (`{ to: senior-dev, max: 1, exhausted: { end: needs-human } }`), or adopt R12e only in S6, or build `maxVisits` in S3.

## Should change

**S1. R1b: a Check command that changes the tree stales every earlier Check.** The tree is `git write-tree` over tracked plus untracked files (`lib/integrity.mjs:36`). A `command` Check such as a formatter, or a test run that writes an untracked coverage directory not in `.gitignore`, changes the tree; every Check before it reads as stale, so `failed`, and the Visit goes to needs-human on every Run with no agent at fault. Say when the tree is read (after the command) and assert a Check leaves the tree unchanged, failing the Check with a clear reason otherwise; the research's option 3 already promised that assertion (`reads: worktree`).

**S2. R12e `senior-dev.previous` is dead config.** R5a produces `rescue` only when a failed or stopped Vertex routes to another Vertex; `implementer-fix` routes every non-ok Outcome to `end: needs-human`, and the escalation on `exhausted: senior-dev` fires from the reviewer, after a fix that passed. Either route `implementer-fix`'s failed table to `senior-dev` (then the rescue exists and `previous` is meaningful) or drop the input.

**S3. R12e `publish` needs inputs the grammar cannot name.** The PR body reads the latest implementation report and Green Evidence across `green`, `implementer-fix` and `senior-dev` (`lib/interpreter.mjs:791-794`). S4's `latest` is per producer; three `optional` inputs cannot say which is newest. Allow `from: [a.x, b.x, c.x]` (latest by Visit order across the list), or make the implementation report a gg-kept record fact like R3c's baseline. Also `tests: named: inputs.findings` needs `pick: file` (R13d requires a list of strings).

**S4. R9b, R12b and the ADR list carry superseded names.** R9b routes "to `replan`", a Terminal R11a removed; R12b lists "`onFail` values" that R14a dropped; S7 adds `session: fresh | resume: <step id>` while R2a leaves one agent step and R6c says recovery resumes its Session, so the only remaining choice is `fresh | resume` on a recovery Phase. Add these three to the reading guide. R6d should also forbid whitespace in Action ids, since the marker regex excludes it (`lib/marker.mjs:14`).

**S5. Q1's warning is permanent noise on the shipped reviewer.** `changes: { requires: [] }` on a read-only Vertex is the intended shape (Q3, R4), yet Q1 warns whenever a read-only Phase advances on its Claim. Restrict the warning to a write Vertex token with empty `requires` (which S2 already rejects for the committing token), or drop it.

**S6. R2e/R2g: an absent `optional` input in a rule.** D4 holds the Ticket on a missing input; R2g makes `red.findings` optional. If a rule matches an optional input and it is absent, the two rules collide. Forbid matching optional inputs, or give absence a value (`absent`) in the R8 domain.

**S7. R3e `testPaths` "repository Layer only" with a shipped default.** ADR 0013 rejects the key in the defaults and user Layers (`lib/config.mjs:64` for the user Layer); the default globs must then live in code, not in `defaults/gg.json`. Say so, or allow the defaults Layer to set it and forbid only the user Layer.

## Resolved

- R1 (recovery re-run set): resolved by R1a–d; S1 above is a sharpening, not a reopening.
- R2 (which Claim controls): resolved by one agent step per Procedure and Vertex composition.
- R3 (Test Immutability omittable): resolved; fixed row, `tests:` setting, baseline as a record fact.
- R4 (`review-pass`, repeat): resolved; `response` and `repeat` kinds; the shipped `failed` row `review-pass failed → changes` should be written down, since today `checkOutcome` supplies it (`lib/procedures.mjs:74`).
- R5 (worktree after a failed route): resolved by rescue, reset, History; B1 is a different gap (passing, not failing).
- R6 (marker reuse): resolved by the Recovery Number; `gg:` plus seven parts matches `lib/marker.mjs:14`.
- R7 (versions): resolved as a deliberate choice; the repository's own runs use ff, so nothing to migrate.
- R8 (overlap algorithm): resolved by box subtraction over the reachable domain with brute-force cross-checks.
- Owner questions 1–6: 1 by R11d (B1 shows the remaining edge), 2 by R12, 3 by R4d, 4 by R13, 5 by R7c, 6 by R14.
- Checked sound: R11a–c and `end:` against today's labels (`lib/run.mjs:40`); R11h; R3c against `testBaseline ?? red.sha` (`lib/interpreter.mjs:675,729`); loops red → green → reviewer → red and reviewer → fix → reviewer are bounded by their edge `max`; a stop token with a `stopped` route to a Vertex rescues and resets (R5a), so no dirty start.

## Ready to slice: no

B1–B4 are all in the shipped Flow or the publishing rule and each changes what S3 and S6 build. After they are recorded, a builder still needs: the shipped `failed` and `stopped` tables written out for `review`, `implement`, `fix` and `publish` (R4b, R9b give prose only); the multi-producer or record-fact answer for the PR body (S3); and whether a write Vertex must commit on its passing path (B1's optional half), since S2's "committing token" wording assumes a commit exists.

Not checked: `lib/render.mjs` templates, `lib/integrity.mjs` beyond `snapshot`, the test fixtures.
