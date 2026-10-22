# User-defined Procedures: design review round 3, merged

Two independent read-only reviews of the example Flow and the decisions since round 2 (T1–T14, P1–P5), 2026-10-22:
Codex `gpt-6-astra` at high effort ([raw](user-defined-procedures-review3-astra.md), findings A1–A5) and Fable at high
effort ([raw](user-defined-procedures-review3-fable.md), F1–F8, Q1–Q4). Each finding below was checked against main
at bd60df9; the code references are main's. Each item carries a recommendation for the owner.

## Blocking

- **U1. What a Brief or template can read. (Both: A1, F1, Fable Q3.)** Today every PR body re-render carries the latest
  implementation report, Red and Green Evidence and a provenance row per Vertex (`lib/interpreter.mjs:835-838`,
  `lib/render.mjs:110`), and the review Brief carries the branch diff, the test files changed since red, and both
  evidences (`lib/interpreter.mjs:604-617`). In the example, `publish` declares no inputs, and no Vertex declares Red
  Evidence after `green`, so `publish` would render an empty body. Recommendation: split the two sources explicitly.
  - gg's own context, available to every Brief and template without declaring it: the Ticket, base, branch diff,
    Declared Commands, History, provenance and Action Marker, and the test files changed since the Execution's first
    test commit (R3d). These are facts of the Execution, not outputs of a Vertex.
  - Everything a Vertex produced comes through `inputs` (Q7). The example declares `report`, `red` and `green` on
    `reviewer`, `publish`, `implementer-fix` and `senior-dev` (T6 lists where several Vertices produce it).
- **U2. "No tests were written" is not caught. (Fable F2.)** Today a red Visit that stages nothing fails with that
  reason (`lib/interpreter.mjs:756, 777-782`). In the example, `tests-fail` passes whenever a named test fails, which a
  test that already failed satisfies with no change; `commit` then has nothing to commit. Recommendation: "no file
  under `testPaths` changed since the Visit's baseline" is one of `tests-fail`'s non-recoverable failures (T4c), and a
  `commit` with nothing to commit is a no-op with `files: []` (a `fix` with no edits, as today).

## Should change

- **U3. The `reason` enum and strict schemas. (Fable F3.)** Every schema property is required
  (`lib/briefs.mjs:2, 8`), so an `ok` Claim must still fill `reason`. Recommendation: add `none`.
- **U4. A third overlap in the review's `passed` table. (Both: A2, F4.)** `ok` with review-pass passed and
  `needsTest: true` matches rows 1 and 3; row 1 wins. Recommendation: name it in the admission summary and keep it: a
  passing review that also asks for a test is `ok`.
- **U5. Rescue decides on the declared target. (Fable F5.)** When `senior-dev`'s `maxVisits` is spent,
  `implementer-fix`'s `failed` ends at `needs-human`, but R5a would still rescue and reset because the route names a
  Vertex. Recommendation: R5a and R5b decide on the effective target, after edge `max` and `maxVisits` exhaustion.
- **U6. Comments at the end. (Both: A5, F6.)** Today a stopped Ticket gets exactly one Ticket comment carrying the
  Terminal Reason, and a replan also posts the diagnosis to the Epic (`lib/interpreter.mjs:929-947`). R11a posts a
  Terminal Reason comment and S5 a stop template; their composition is unstated. Recommendation: a stop token's
  template replaces the end's Terminal Reason comment and must include the reason, so the Ticket still gets one
  comment; `end: needs-replan` also posts the diagnosis to the Epic as fixed end behaviour, since that end's contract
  is with the Epic's planner (R11b).
- **U7. Q3c's removable Check is dead. (Fable F7.)** Removing `test` from `ok` leaves a committing token requiring
  nothing, which S2 and T1c reject. Recommendation: a reading-guide row, Q3c → S2.
- **U8. Delivery order for P1–P4. (Both: A3, F8.)** On main, `gg init` and `gg doctor` are stubs, this repository's
  `.agents/gg/gg.json` holds only `commands`, and Persona loading assumes the shipped Agents (`lib/config.mjs:40-46`).
  Recommendation, for step 7: working `gg init` and `gg doctor`, repository-Layer Briefs, Personas and schemas, and
  this repository's own Flow, Procedures and `testPaths` all land before `agents`, `flows` and `defaults/personas`
  leave the defaults Layer. The slice names the tests that load the shipped Flow (`test/defaults.test.mjs`,
  `test/flow.test.mjs`, `test/config.test.mjs`, `test/personas.test.mjs`, the golden traces in
  `test/interpreter.test.mjs` and `test/run.test.mjs`) and adds `senior` to `examples/*.json`.
- **U9. `testPaths` reaches every consumer. (Both: A4, F8.)** Main uses the default globs in Test Immutability, the
  rollback set, `TEST_PATHSPECS` (`lib/checks.mjs:82`, `lib/interpreter.mjs:51, 630`) and the review's changed-test
  list (`lib/interpreter.mjs:610`). Recommendation: one pinned repository value feeds all of them, with a test whose
  test files live outside today's globs. This includes `events.diffStats`' own `TEST_PATH` regex
  (`lib/events.mjs:73`), which disagrees with `DEFAULT_TEST_GLOBS` today (`fixtures/` counts only for immutability,
  `spec/` only for stats, and only stats ignores case; the 2026-10-21 code-quality audit, finding 4).

## From the grey-goo-ri issue #95 session (Declared Commands, 2026-10-22)

That session's handoff, checked against main. Its constraints already hold in the design; these make them explicit.

- **U13. Commands by name only.** A Procedure, Check or later gate names a Declared Command (`command: test`), never a
  command line. With P2 no other Layer may declare Procedures, but naming keeps ADR 0013's allowlist the only source
  of what runs unsandboxed. Recommendation: record it; the validator (V1) errors on any named command the repository
  Layer does not declare, generalising preflight's "`test` is required" (`config.commandProblems`). `test` stays
  required, since the example and Test Immutability's intent assume a suite.
- **U14. The command name leaves the Outcome vocabulary.** Today `checkOutcome: { test: 'gate-failed(test)' }` and
  `CHECK_NAMES` bind a Check to `commands.test` in code (`lib/procedures.mjs`, `lib/interpreter.mjs`). With Checks as
  data, Outcomes come from the tables or the engine's `failed` (T7), and Check ids are the user's. Recommendation:
  record that `gate-failed(<name>)` and `CHECK_NAMES` are removed in the slice that ports the Checks.
- **U15. grey-goo-ri issue #96 (an agent can fake a green run by editing what a command delegates to).** P4 builds the
  repository-Layer test globs that issue's option 1 asked for, required rather than defaulted, so a repository can add
  its test launcher (`scripts/run-suite.mjs`) to `testPaths` and Test Immutability, rescue and rollback cover it.
  Limit: adding `package.json` would also stop an implementer adding a dependency, so `scripts.test` stays exposed
  unless the `test` command calls a launcher file directly. Recommendation: P4 closes #96's option 1; ADR 0014 records
  the `package.json` limit, and #96 stays open for it.

## Questions for the owner

- **U10. A failed `red` ending at `needs-human`. (Fable Q1.)** Today it discards the agent's changes
  (`lib/interpreter.mjs:523`); under R5b they stay for the human. Recommendation: R5b, uniformly; no Procedure is
  special (D3), and the human can see what the agent tried.
- **U11. `retest` exhausted. (Fable Q2.)** It goes to `senior-dev`, which runs `fix` with `tests: named` and so cannot
  write the failing test the review asked for. Recommendation: `retest` exhausted ends at `needs-human`; red already
  failed to reproduce the finding twice.
- **U12. The reviewer's access. (Fable Q4.)** Today the `review` Procedure forces `read-only` whatever its Agent says
  (`lib/procedures.mjs:63`, `lib/interpreter.mjs:618-619`). The example takes access from the Agent only.
  Recommendation: a Procedure may declare `access: read-only`, which caps its Agent's access, as today; `gg doctor`
  shows the effective access, and the example's `review` declares it.

## Confirmed by both

Every Outcome of every Vertex is routed, and `review` cannot produce `failed`. Every loop is bounded. The tables
evaluate in the decided order with no unreachable or never-firing row, and P5a never lets a failing review reach `ok`.
Required and optional inputs have producers (T6, T9, T10), and `pick: file` gives `tests: named` a list of strings
(T8). Every passing write path commits (T1c); publishing happens only in `publish`, on its own Check's tree (R11d,
T1a, R11e); `implementer-fix`'s failure rescues to `senior-dev` (R5). Against today's Flow, the review comment, the
draft PR at green, a push after each commit, one still-green and one test-fix recovery resuming the Session, History
in fix Briefs and the fix test baseline (R3c) are kept; the losses are U1, U2 and U10.
