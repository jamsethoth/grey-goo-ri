# User-defined Procedures: review round 6, all issues, merged

On 2026-10-22 two new reviewers, Astra (gpt-6-astra, high) and Fable, reviewed the whole Epic as filed: issue #101,
its 22 tickets (issues #102–#123), and issues #23 and #68. They worked from one brief, with an export of GitHub, and
did not read the earlier reviews. Their reports are in [the raw reviews](user-defined-procedures-review6-raw.md). Each
finding below was checked against main.

Both found the blocked-by chain equal to the Epic's stated order, and the issue #118 / issue #68 split clean. Fable
found the cited code facts accurate. The findings are gaps an implementer would otherwise fill by guessing.

## Should fix before `ff run`

- **K1. Approval configuration and labels (Astra IR1, Fable Z1).**
  - Issue #108 defers "where a Flow sets `approvers`" to issue #119, but #119 never sets it, and #106's shape lacks it.
  - #119 says "#106 and #107 treat `decisions` as Outcomes", yet #106 puts the decisions out of scope and #107 never
    mentions them.
  - Nothing creates the Await and Decide Labels: `github.ensureLabels` creates State Labels only
    (`lib/github.mjs:47-62`), so the first `await` write would fail.
  - Recommendation: #119 extends the validator (`lib/validate.mjs`) itself.
    - `decisions` are Outcomes.
    - The Await and Decide Labels a Flow can request go in the Resolved Flow. `ensureLabels` creates them, and
      `gg doctor` reports any that are missing.
    - Add `gh` verbs for issue timeline events and collaborator permission.
    - **Owner decision:** where `approvers` lives (see the question).
- **K2. The Action Cap has no key (Fable Z2).** Issue #117 builds "the Action Cap over Attempts", but the request,
  the decisions, the example and the code name no key or value, and #106's shape has none.
  **Owner decision:** the key and the example's value.
- **K3. The example's schemas, Briefs and Personas exist nowhere (Fable Z3).** Issues #104, #106, #107 and #120 test
  against "the example's" schemas. The example-flow doc only names them (`red.schema.json`, …) and their changes.
  Recommendation:
  - Issue #104 writes the three example schemas as fixtures under `test/fixtures/example/`. They are today's
    `RED_SCHEMA`, `IMPLEMENT_SCHEMA` and `REVIEW_SCHEMA` with the decided changes: the `reason` enum and
    `diagnosis` (R9a, U3, U11), `needsTest` (R2g), and the review Claim enum `ok | changes | blocked`.
  - Issue #120 says its Briefs are #105's templates with W6, W7, W10 and `recover.md`, and its Personas are
    today's `defaults/personas/*.md`.
- **K4. Issue #23 changes shapes that no Epic ticket builds (Fable Z4).** #23's Out of scope is "Any behaviour
  change", yet several of its items need code. Recommendation: move each into the ticket that owns the code, so #23
  only documents and freezes them.
  - `rule` as `{ table, row }`: today it is the string `r.row` (`lib/interpreter.mjs:307, 547`). Moves to issue
    #115.
  - An unknown `intent.action` holds (`lib/reconcile.mjs:140` returns absent today): moves to issue #118.
  - The Procedure definition hash: moves to issue #116, as the Visit snapshot's `procedure: { name, hash }`.
  - Dropping the `exhausted` Event field (`lib/interpreter.mjs:672`): moves to issue #117. Dropping `repeat` moves
    to issue #114.
  - The owner field: `owner: { kind, number }` joins `ticket`, which stays, in the record and in every
    Execution-scoped Event. The `events.ticket` column stays.
- **K5. #23's freeze test cannot see the persisted record (Astra IR3, Fable Z12).**
  - The test compares `record.md` with the keys of `createExecution(...)`. But `admission`, `visitState`,
    `terminalReason` and `terminalStop` are added later (`lib/run.mjs:278`, `lib/interpreter.mjs:388-389, 485`).
  - Recommendation: `record.md` separates the fresh record's fields from those added later. The test checks the
    fresh keys, and the union of representative persisted records: admission, Visit, recovery, approval, rescue,
    hold, fault, abandonment and completion.
  - The Epic Record is treated the same way.
- **K6. The abandonment report and the corrupt-record hold have no Action id (Fable Z5).**
  - An abandonment is reported with phase `abandoned` and a label only (`lib/interpreter.mjs:866, 945, 953`). The
    corrupt-record hold builds its marker by hand (`lib/run.mjs:251`). Y18's ids cover neither.
  - Recommendation:
    - `<report>` gains `abandon`. An abandonment's Vertex slot is `needs-human`, and its one Action is
      `abandon-label`.
    - The corrupt-record comment becomes `hold-comment`.
    - Issue #111 also keys `terminalReason.decidedBy` on `action` and `recovery`, as request 3.3 says.
    - Issue #23 freezes `abandon-label` and the `decidedBy` shapes.
- **K7. U2 has no ticket (Fable Z6).**
  - U2 has two parts:
    - "no file under `testPaths` changed" is a non-recoverable `tests-fail` failure;
    - a `commit` with nothing to commit is a no-op with `files: []`.
  - Today the first lives in the commit Action (`lib/interpreter.mjs:756, 777-782`). Recommendation: both go into
    issue #114.
- **K8. The implicit Claim of an agentless Procedure (Fable Z7).** R11f ("an implicit Claim `ok` that requires all
  its Checks") is in neither #106 nor #107, but #107's publishing check needs it. Recommendation: #106 adds it.
- **K9. Issue #68 escapes the serial order (Astra IR2).** It is blocked only by #118, so it could run beside #119,
  #23 or #123, and change recovery fields while #23 freezes them. Recommendation: block it on #123 (which follows
  #23), and say why in its Notes.
- **K10. Admission holds the interrupted worktree before issue #68's path runs (Fable Z11).**
  - `admit` calls `reconcile.dirtyState` (`lib/run.mjs:305`) before Reconciliation. `asRecorded` returns false for
    an open `call` intent (`lib/reconcile.mjs:49-54`), so the worktree is held.
  - Recommendation: #68 makes `asRecorded` accept an open `call` intent whose baseline matches. The heartbeat
    check then runs first in Reconciliation.

## Nits

- **K11.** Issue #119: the glossary already has **Pending** ("an Execution waiting for a Decision at an Approval
  Vertex"). Drop "Awaiting" (Y15) and redefine Pending for a Vertex whose Procedure ends in `await-approval`.
  (Fable Z8)
- **K12.** Issue #105: name W6 among the changes. The stop template reads `summary`, `diagnosis` and the Terminal
  Reason, and `notes` leaves it. (Fable Z9)
- **K13.** Issue #112: preflight, `harnessOf` and the snapshot skip the Agent of a Vertex without `use`
  (`lib/run.mjs:58-61`, `lib/interpreter.mjs:331, 464`). (Fable Z10)
- **K14.** Citations (Fable Z12):
  - issue #103 names its module `lib/rules.mjs`;
  - issue #122 cites `lib/run.mjs:109-114`;
  - issue #120 drops `flow` from the tests that load the shipped Flow;
  - issue #113's `from` is `<vertex>.<action id>.<field>`, followed by a dotted path.
