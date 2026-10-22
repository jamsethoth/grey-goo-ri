# User-defined Procedures: design review round 3, Astra (raw)

Codex `gpt-6-astra`, effort high, read-only, two runs in one thread (2026-10-22). Run 1 could not read the main
checkout; run 2 compared against main at bd60df9 through `git show bd60df9:<path>` and numbered from A3.

## Run 1

### Blocking

**A1. `publish` lacks the inputs needed to re-render the PR body.** `example-flow.md:209` declares no inputs, although
T2/T6 require the latest implementation report and Green Evidence; Q7 permits templates to use inputs and their own
Vertex's outputs. Define the shared `pr-body.md` data contract and wire it at every caller, including `publish`, so
rendering needs no undeclared cross-Vertex access.

### Should change

**A2. The overlap summary omits `ok` suppressing `retest`.** At `example-flow.md:121`, `claim: ok`,
`review-pass: passed`, and `needsTest: true` matches rows 1 and 3, with row 1 winning, even when findings do not
repeat. Document this additional overlap in the admission summary; retain P5a's accepted precedence.

### Confirmed

The declared routes cover all listed Outcomes; cycles and escalation have bounds; declared required inputs have
producers; optional inputs have producing paths; `pick: file` supplies the required string-list shape. P5a correctly
sends `ok` with failed `review-pass` to repeat/retest/changes, never `ok`; passing write paths commit, failed-fix
escalation invokes R5 rescue/reset, and only checked `publish` reaches ready-for-qa through `pr-ready`.

## Run 2

### Blocking

**A1, verified against main.** At bd60df9, `lib/interpreter.mjs:835–838` supplies every PR update with the latest
implementation report, Red/Green Evidence and provenance; `lib/render.mjs:110–145` renders these alongside DoD and QA
instructions. Under Q7/T2/T6/P3, define and supply that complete template contract at every PR-body caller, including
the inputless `publish`.

### Should change

**A3. Make the bootstrap cutover explicit (P1–P4).** Main's `gg init` and `gg doctor` are stubs (`bin/gg.mjs:43–54`,
`lib/doctor.mjs:1`), this repo's `.agents/gg/gg.json:1–5` contains only `commands.test`, and Persona loading assumes
shipped Agents (`lib/config.mjs:40–46`). Require working init/doctor, repository asset loading and this repo's
populated Flow/Procedures/`testPaths` before removing defaults; migrate the default-dependent config/flow/Persona tests
and `test/run.test.mjs:34–42`, retaining P1c's generated-example admission and golden-trace check.

**A4. Carry repository `testPaths` through every existing consumer (P4/R3d).** Main hard-codes default pathspecs for
snapshots and rollback (`lib/checks.mjs:82`, `lib/interpreter.mjs:51,630`) and implicitly uses default globs for
reviewer context and immutability (`lib/interpreter.mjs:610,719`). Specify one pinned repository setting for all these
consumers, including the reviewer's changed-test list from the first test commit, and cover a test location outside
today's default globs.

### Questions for the owner

**A5. Should the stop-token comment replace the end-state comment?** Main deliberately posts exactly one blocked Ticket
comment containing the Terminal Reason (`lib/interpreter.mjs:930–946`), while S5 supplies `blocked.md` and R11a
separately mandates an end-state Terminal Reason comment; their composition is unspecified. State that the stop
template incorporates and replaces that comment, preserving one Ticket comment plus the existing Epic diagnosis
delivery when applicable.

### Confirmed

Review comments retained, early commit → push → draft-PR ordering, and one resumed still-green/test-fix recovery;
History remains required in fix Briefs (`lib/briefs.mjs:146–151`), and R3d preserves changed-test visibility, so both
must survive template conversion. P2 is compatible with per-user harness/model/effort because repository Agent
declarations omit those fields.
