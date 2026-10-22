# User-defined Procedures: design review round 4, raw

Two read-only reviews of a120ca6 (2026-10-22): Codex `gpt-6-astra` at high effort (B1–B3) and Fable at high effort
(G1–G9), both checked against main at bd60df9.

## Astra

**Blocking:** none.

**Should change**

- **B1. Normalize findings references.** The example declares `review.response.findings` (example-flow.md:155), but
  consumers use `reviewer.review.findings` (lines 193, 223, 233–234, 246–247). Change those sources to
  `reviewer.review.response.findings` so they satisfy R13e's reference validation.
- **B2. Declare the shared fix Brief's optional input.** `fix.md` reads `previous` (example-flow.md:105), but only
  `senior-dev` declares it; `implementer-fix` does not. Add an optional `previous` to `implementer-fix` too; the
  rescue-source list has a producing path through `senior-red → senior-dev → reviewer → implementer-fix` (T9).
- **B3. Resolve recovery placement.** T4a defines `recover` as a Vertex setting, while example-flow.md:58, 86 and 111
  place it on Procedures without defining inheritance. Move it onto the Vertices, or amend T4.

**Questions:** none.

**Confirmed:** U1–U15 otherwise landed consistently; every Outcome routes, every cycle is bounded, required inputs
(T6 lists, PR-body bindings) have producers on every path; no further silent loss versus bd60df9.

## Fable

**Blocking**

- **G1. `recover` lives in two places.** T4a/T4b/T4d and the reading guide say Vertex-level; the example puts it in
  each Procedure, while its Changes section says "each Vertex's `recover`". Fix: a decision that `recover` is a
  Procedure setting, like `tests` and `access` (amends T4a/b/d), which fits U7/R10c; or move it onto the Vertices.

**Should change**

- **G2. The stop template cannot name the Terminal Reason.** U6 requires it, but U1's gg context omits the Terminal
  Reason and the end name. Add them to U1's list, for stop templates.
- **G3. The review's `comment` has no target.** Today it goes to the PR (`lib/interpreter.mjs:823`) and Terminal
  comments to the issue (`:940`). Fix: `target: pr`; stop-token comments always go to the Ticket (U6).
- **G4. `draft: true` versus its absence.** `upsertPr` always creates as draft and `gh pr edit` never changes draft
  state (`lib/github.mjs:93-101`); only `pr-ready` publishes. Read literally, the review's and publish's `pr-upsert`
  without `draft` would publish outside R11d. Fix: `pr-upsert` creates as draft and never changes draft state; drop
  the flag.
- **G5. One `blocked.md` over three schemas fails R13e.** Today's blocked comment renders `response.notes`
  (`lib/render.mjs:166-171`), which `REVIEW_SCHEMA` lacks. Fix: `blocked.md` reads only fields all three schemas share,
  or `review` gets its own template.
- **G6. The `rescue` input path has no producing Action.** `implementer-fix.rescue` is not `<vertex>.<action
  id>.<field>`. Fix: define `<vertex>.rescue` as a Vertex-level output `{ ref, diffStat, output }` written by R5a.
- **G7. Stale text.** (a) T13 still names the review's `failed` table, which P5b removed; add T13 to the R4b → P5a
  row. (b) Example-flow.md:20-21 says red reads the Ticket and commands, but `red` also reads `findings`.

**Questions for the owner**

- **G8. Where the Epic's replan diagnosis comes from under U6.** Today `render.diagnosisComment` reads
  `response.diagnosis` by name. Either the Epic gets the same rendered stop-token comment, or `diagnosis` becomes a
  reserved response field.
- **G9. After a `retest`, `green` never sees the findings.** Non-test findings are fixed only if the reviewer repeats
  them, spending a `changes` traversal. If not intended, `green` declares `findings` optional, as `red` does.

**Confirmed:** U1–U15 present with reading-guide rows; the example carries them; every Outcome routed, every cycle
bounded, every required input produced per Outcome, optional inputs each with a producing path, `with:` bindings
resolve, publishing fenced, commits guarded. Skipped: R8 beyond the review's table; `gg init` and `gg doctor`.
