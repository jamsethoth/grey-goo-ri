# Design review: user-defined Procedures (decisions of 2026-10-21)

Reviewer: Fable 5.1, read-only. Code references are to `C:/dev/projects/grey-goo-ri` main. Items marked *(inference)* were not checked against code.

## Blocking

**B1. Q3b/Q3d: the recovery re-run set is undefined, and the gap breaks use case (a).**
Q3b puts `recover: { phase, max }` on a Check; Q3d says the recover Phase runs and "remaining Actions run", but never says which Checks run again after a recovery Phase. Today it is explicit: `still-green` ordinal 2 is the Red Check again (`lib/procedures.mjs:8-9`). If only the recovering Check re-runs:
- Config: `qa` = agent `qa` (write) → Check `suite` (command test, `recover: { phase: fix-suite, max: 1 }`) → Check `scope` (changes only `test/**`) → commit `requires: [suite, scope]`; `ok: { requires: [suite, scope] }`.
- Results: `suite` fails, `scope` passes; `fix-suite` edits `src/foo.js`; `suite` re-runs and passes; `scope` is not re-run. Every required Check is `passed`; Q3a is satisfied because `suite` ran after the last write step. The commit lands non-test changes.
Fix: after a recovery Phase, every Check of the Phase it recovers runs again (the Phase's Checks are a unit, as today), and Q3a reads "every Check the commit requires ran after the *last* write step".

**B2. Q2 vs Q3b: Test Immutability can be omitted.**
Q3b lists `immutability` as a user-declared Check kind with `recover` and `onFail`; Q3d's fixed "integrity" row runs "at each agent Attempt", which today covers HEAD/index/tree/Protected Files (`lib/interpreter.mjs:594`) but not Test Immutability, which runs inside the Green Check (`lib/interpreter.mjs:675,692`) with `integrity: true`. A Procedure that simply lists no `immutability` step (agent write → `command test` → commit) lets an agent rewrite committed tests, pass, commit and publish. Q2 says Integrity Assertions are never switchable; the GLOSSARY counts committed tests among them.
Fix: make Test Immutability part of the fixed integrity row, asserted before any Check and any commit of every write Phase whenever a test baseline exists, never declarable, never recoverable. Then also decide the baseline (see B4).

**B3. Q3d/S6 (failed-table routing) breaks crash safety (I1).**
Q3a says a failed required Check leaves "the work uncommitted"; Q3d/S6 let the `failed` table route to another Vertex. Nothing says what happens to the worktree. Config: Vertex A `tdd`, `failed: [{ when: { check: green, is: failed }, outcome: fixer }]`, `route: { fixer: B }`. Results: green fails for good; gg routes to B and dies before B's agent intent is written. Next Run: `reconcile.dirtyState` at admission (`lib/run.mjs:293`, `lib/reconcile.mjs:82-91`) finds uncommitted changes no open intent proves and holds the Ticket as "changes gg did not make". Without a crash, B's agent starts on a dirty worktree, and the shipped dirty-worktree guard is a literal `phase === 'red'` test (`lib/interpreter.mjs:436`) that D3 removes.
Fix: decide one of (i) the failed branch resets to the Visit's first baseline through the write-ahead `reset` (today's `red-failed`, `lib/interpreter.mjs:481`) and routes with a History item; (ii) it commits the work as a marked WIP commit before routing; (iii) a failed Outcome may route only to a Terminal. (i) is smallest and keeps ADR 0005's rule that only proven changes are rolled back.

**B4. Q3g and the shipped `review` cannot both hold without a `response` Check kind; and Test Immutability's moving baseline is not expressible under Q7.**
- `review-pass` is not among Q3b's kinds. The shipped review then has `ok: { requires: [] }`, which Q3g forbids from routing to `done`; today it does (`defaults/gg.json` `"ok": "done"`). The reviewer's "no blocker or major finding" is a quantifier over an array (`lib/checks.mjs:106`), outside Q4a's enum/boolean/integer matching. Decide before S2: add a `response` Check kind (fields of the Structured Response against constants) and a schema-derived `worstSeverity` enum (gg-computed, as the research's option 2 showed), or keep `review-pass` as a gg fact. S2 removes `state.calls.review` and cannot without this.
- The immutability baseline is the red commit, moving to the fix commit when a fix committed (`lib/interpreter.mjs:729`), with the review's named files excused (`:678-682`). Q7's `from: <vertex>.<step>.<field>` names one producer and one Visit; "latest of red.commit or fix.commit, whichever landed last, skipping fix Visits that made no commit" is not expressible, and the excuse list is a path into an array of a response field, which Q7 does not define. Simplest fix: the baseline is a gg-maintained record fact ("the last commit that passed Test Immutability"), the excuse list a parameter `except: <input>` of list type, and Q7 gains list-typed fields explicitly.

**B5. S1: the Action Marker needs a recovery iteration.**
With `recover: { max: 2 }` the second run of the recovery Phase has the same step id and attempt 1 as the first. `callAttempt` treats a completed marker as done and returns the first run's evidence (`lib/interpreter.mjs:556`); `sideEffect` does the same (`:240-244`). Today this cannot happen because each recovery Phase has its own name and `describe()` only ever drops or keeps it (`lib/procedures.mjs:66`). The marker (and the record/event key, `rec.sessions` key `vertex/visit/phase`, `rec.retries` key) must carry the recovery iteration, and #23 must freeze that component.

## Should change

**S-1. Q3a commit `requires` duplicates the token's `requires` and can disagree.** Q3c lets an option remove a Check from a *token's* requires; the commit's own list stays. Then the token's `passed` table advances while Q3a "skips the commit and holds" the same Visit: two mechanisms, two answers; push and pr-upsert would then run with no new commit (`pr-upsert` reads `rec.outputs.implementation.at(-1)`, `lib/interpreter.mjs:791`, a fault). Drop commit `requires`: a commit is skipped whenever a required Check failed (Q3d already says so), and the static rule becomes "a commit reachable after a write step needs a token-required Check after that step" (with B1's "last write step").

**S-2. Q6/Q3f vs ADR 0004 and request 3.4.** ADR 0004's consequence says "an agent's blocked claim stops the ticket even when tests pass"; request 3.4's table says blocked/misscoped → "stop: comment and needs-human, or replan". Routing a stop token to another Vertex reverses both. The Open item mentions only an ADR reversing "Procedures are code". Name the stop-routing reversal in the same ADR, or keep stop tokens Terminal-only (which also lets you drop the `stopped` table, see Simplification).

**S-3. Q4 and Q3d decide the no-match default twice.** Q4: "with no row matching and no `otherwise`, the Outcome is the Claim token". Q3d: the `failed` branch falls to `otherwise`, then `onFail`, then `needs-human`. Reword Q4 to the `passed` branch only, and cite Q3d, not Q3e.

**S-4. V1 "inputs produced on every path" and "done reachable with a PR" must be per Outcome, not per path.** On a `failed`-table Outcome, every effect step after the failing Check is unproduced (Q3d), so a path that visits the producer Vertex does not produce the input. Decidable: for each table row, the produced set is the steps before the first failing required Check plus the remaining Checks of that Phase. Model `pr` as an input `done` consumes and the existing "done without a PR-creating vertex" check falls out of the same analysis; today the runtime fault is `gh.markReady(null)` (`lib/interpreter.mjs:868`).

**S-5. V1 overlap analysis: exact only over reachable combinations.** Enumerating the full product of Check states reports overlaps on combinations Q3d makes unreachable (in the `failed` table, a Check of a later Phase is always `not-run`; in the `passed` table, no required Check is `failed` or `not-run`), and a row that fires only on an unreachable combination is reported live. Enumerate per table from the step order and the first-failing position. The integer part is exact if boundaries are collected across all rows (not "each row's") and `runs` is bounded by `max + 1`. Print the distinguishing sub-constraint, not every combination: ten Checks give 3^10 vectors.

**S-6. Q8/S1: in-flight records and markers.** `parseMarker` requires exactly seven colon parts (`lib/marker.mjs:14`); `SCHEMA_VERSION` is 1 (`lib/record.mjs:7`) and a mismatch is a clean `RecordCorruptError` hold (`:159`). S1 changes `rec.outputs`, markers and keys under the same version, so an old record loads and faults on `rec.outputs.red`. Bump `SCHEMA_VERSION` in S1 (and in each later shape change) so in-flight records hold cleanly; "no version bump" belongs after the freeze, not before it.

**S-7. Q7: resolved inputs must be snapshotted at Visit entry.** `visits: latest` resolved at read time can differ between a crashed Attempt and its resume if a producer Vertex is re-entered meanwhile (not possible on a sequential graph, but the record is the authority under I2). Put the resolved input provenance (producer Vertex, Visit, step) in `rec.snapshot` at entry; it also gives the Event the provenance the research asked for.

**S-8. #23 reservations are short.** Add: (i) the generic `signals.checks[]` element `{ id, kind, state, runs }` on the Action Event and removal of the literal fields `requireTestPass`, `repeat`, `exhausted` (`lib/events.mjs:39`); (ii) a rule identity `{ table, row }` for `rule`, which today is a gg row name; (iii) the resolved inputs snapshot (S-7); (iv) the marker iteration (B5); (v) the Procedure definition hash beside `configHash`. `onInterrupt` is config, not record, and needs no reservation.

**S-9. D3 vs the Terminal comments.** The blocked comment and the replan diagnosis (to ticket and epic) are selected by literal Outcome names (`lib/interpreter.mjs:876,881`) and read literal fields `summary`, `notes`, `diagnosis`. A `stop` token skips the remaining Actions, so a Procedure cannot post them itself. Decide where the Terminal comment template lives (on the token: `blocked: { stop: true, comment: <template> }` is smallest) and fold it into S5's templates. Same for the Red Check's `tests` names (`lib/interpreter.mjs:686`): a `tests-fail` parameter must reference the same Visit's response field, which Q7 (cross-Vertex only) does not define.

**S-10. Slicing.**
- S2 is too large and partly mis-ordered: removing `phase === 'red'` needs generic outputs (S1) and the baseline decision (B4); removing `state.calls.review` needs the `response` Check kind (B4). Split: S2a tokens, Check model, Outcome order, drop `relaxed`, shipped behaviour unchanged; S2b remove literal special cases, after S5 (or after B4's baseline-as-record-fact decision, which removes the S5 dependency).
- Still-green's Session resume (`lineage`, `resumeGreen`, `lib/procedures.mjs:24-25`) has no home: add `session: fresh | resume: <step id>` on agent steps to S2a.
- Golden traces: every interpreter-touching slice (S1, S2, S6) needs its trace fixtures regenerated and reviewed; say so per slice, since the request makes the staged trace the definition of done.
- GLOSSARY: Action identity ("Phase and ordinal"), Phase, Check states, Verdict (literal `ok|changes|misscoped`), Confirmation (Q5a), `Terminal Reason.decidedBy` shape. One doc slice, or each slice updates its entries.
- `gg doctor` output (tables, inputs, reachable Outcomes) is in V1 but no slice names it: S4 for tables, S5 for inputs.
- `examples/` and `defaults/gg.json` gain the shipped Procedures in S3; name them.

## Questions for the owner

1. Q3d: a required Check failed for good, and an *unrequired* Check of the same Phase fails with recovery left: does its recovery Phase run? "Further recovery Phases are skipped" suggests no; confirm, since a write-access recovery after a final failure would change the worktree the `failed` table is reasoning about.
2. Q1: the warning for a read-only Phase advancing on its Claim: with Q3g, such a Vertex can never reach `done` directly. Is the intended shipped shape `review ok → done` through a `response` Check (B4), or a separate deterministic Vertex before `done`?
3. Q3c: when an option removes `green` from `ok.requires`, does the Green Check still run and record (so the `passed` table can see `green: failed`)? The text implies yes; say it, because it is the one place where an advance happens past a failing Check, and request §2 says "advance never happens while a declared check is failing" — the reconciliation is that the option undeclares it, which doctor must print.
4. Q7: are `<field>` paths allowed into arrays and nested objects of a response, and are list-typed inputs allowed (needed for the excuse list and the reviewer's "test files changed since red")?
5. Q5: `irreversible: true` adds "a human-override check immediately before launch". Push already does this under the repo lock (`lib/interpreter.mjs:229-234`); is that the same check, and does it apply to merge via the existing `lockGuard`?
6. Q8: is "no readers for old markers" acceptance that every Execution in flight at upgrade is held and reset by hand?

## Simplification (no use case or invariant lost)

- Drop commit `requires` (S-1).
- Drop `onFail`: `otherwise` on the `failed` table, defaulting to `needs-human`, gives one default layer instead of three and removes the "first failing Check in step order" rule.
- Drop the `stopped` table (Q6): no use case a–g refines a stop on typed fields; a stop token routes by its name in the Flow, which is already how `misscoped → replan` is to be shipped. Reinstate when a case appears.
- Drop `visits: all` and `optional` until a use case needs them; e needs `latest` only.
- Make the Test Immutability baseline a record fact (B4), which removes the shipped Flow's only cross-Vertex input and lets S5 ship after S6 if needed.
- Q3f's three harness Outcomes can stay as fixed names in the enum (frozen) with routing deferred; nothing in a–g routes them.

## Confirmed sound

- Loops: Check recovery is bounded by `max` per Check and the Attempt count by the Action Cap; Vertex routes keep edge and Visit Bounds; with B1's "re-run the Phase's Checks" the total is still the sum of each Check's `max` plus one.
- Fixed rows first (integrity, harness classes, run stop, parse) and never routable to a publishing Terminal match request 3.4 and the research's reserved-prefix lesson.
- Q3g as stated does stop `failed` rows and `requires: []` tokens from publishing; the per-Vertex argument holds given Q3a (with B1's amendment).
- Q5's Confirmation contract mirrors today's `FINDERS` (`lib/reconcile.mjs:98-136`) and the lookup-retry budget (`lib/interpreter.mjs:174-181`); `unknown` never counting as absent is preserved.
- Pinning: hashing resolved definitions into the Config Hash and snapshotting them per Visit extends `rec.snapshot` (`lib/interpreter.mjs:425`) without a new mechanism.
- First-match tables with a never-fires error and overlap warnings are a reasonable DMN-style compromise; rules stay data, no expression language.
- V2's scenario runs as a separate ticket are the right call; the validator cannot prove a `command` Check verifies anything, and the design does not claim it can.

Not checked: `lib/run.mjs` admission beyond the dirty-state hold, `lib/render.mjs` templates, the test fixtures. Word count is within the limit.
