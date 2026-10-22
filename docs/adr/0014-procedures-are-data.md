---
status: accepted
date: 2026-10-22
---

# Procedures are data over gg's own Actions, and the repository owns its Flow

gg's Procedures (`tdd`, `fix`, `review`) were code: their Actions, recovery Phases, Briefs, Claim tokens and failure
Outcomes lived in `lib/procedures.mjs`, and the interpreter special-cased Phase names (`red`, `green`, still-green,
test-fix), Check names and Outcomes such as `red-failed` and `gate-failed(test)`. A repository owner could not add a
QA stage, a lint or scope gate, a custom review shape or a stronger escalation without changing gg. Procedures now are
data, declared in the repository Layer and built only from gg's own Actions (agent, check, commit, push, pr-upsert,
pr-ready, comment, await-approval), Check kinds (`command`, `tests-fail`, `response`, `repeat`, and `changes`, which is
named but built after option 1) and fixed integrity rows.
The interpreter names no Procedure, Action or Check.

- **One agent step per Procedure.** A Procedure has at most one agent Action; with none it is a deterministic Vertex
  (a gate, `publish`). Multi-step work is composed from Vertices, and Sessions never cross Vertices, so red and green
  become two Vertices.
- **Claim tokens decide what is required.** Each token is `{ requires: [<check ids>] }` or `{ stop: true }`. The
  Outcome is decided once per Visit: gg's fixed rows (integrity, harness failure, parse), then a stop token through
  the `stopped` table, then the `passed` or `failed` table by whether every required Check passed on the current
  tree. Tables are first match over enum, boolean and integer fields, analysed exactly at admission. With no `failed`
  row matching, the Outcome is the engine Outcome `failed`.
- **Recovery is per Visit.** `recover: { max, brief }` resumes the agent's Session after a pass in which a required
  Check failed recoverably, then every Check runs again.
- **Integrity is never configurable.** Protected Files, read-only enforcement and Test Immutability over `testPaths`
  run after every agent Attempt; a Procedure only declares how much it may touch tests (`frozen`, `named`, `write`).
- **A human approval is an Action.** `await-approval` ends a Procedure with no agent Action, asks for a Decision
  through ADR 0003's label protocol, and ends the run for the Ticket; the Decision a later run consumes is the
  Visit's Outcome, routed like any other. There is no separate approval kind of Vertex.
- **Ends replace Terminals.** A Vertex routes to a Vertex or to `end: ready-for-qa | needs-human | needs-replan`.
  Publishing (`pr-ready`) is an Action in a Vertex that requires a Check, and runs only on the tree that Check passed.
- **The repository owns its Flow.** gg ships no default Flow and no library of Procedures, Briefs, Personas or
  schemas. `gg init` writes an example into the repository Layer, which then owns it; without a Flow, preflight and
  `gg doctor` fail naming `gg init`. `flows`, `procedures`, `commands` and `testPaths` may be set only in the
  repository Layer; elsewhere they are a load error. `testPaths` is required, like `commands.test`.

The design, its reasons and four review rounds are in `docs/research/user-defined-procedures-decisions.md`; the
example `gg init` writes is `docs/research/user-defined-procedures-example-flow.md`.

## Considered options

- A separate typed decision table beside the Procedure (research option 2). Folded in instead: its rules (typed Claim
  fields as inputs, first match, exact overlap analysis, an absent input as a value) became the Procedure's own
  tables.
- User Actions as executables behind a durable protocol (option 3) now. Deferred until after grey-goo-ri issue #23
  freezes the record and Event schemas; #23 reserves the fields it needs. Until then, new kinds of side effect (merge,
  deploy, notify) wait.
- Procedures as durable-step code modules. Rejected: it is per-agent code, `gg doctor` could not print a Procedure's
  Checks without running it, copied config would run inside the process holding the git and gh credentials, and
  replay determinism would be the author's job.
- Shipping the example as a defaults-Layer Flow or library that repositories override. Rejected: an upgrade would
  change a repository's process silently, and a Flow merged from three Layers cannot be read in one place.
- Keeping `testPaths` optional with `DEFAULT_TEST_GLOBS` as its default. Rejected: what counts as a test decides what
  an agent may not change, so the repository states it.

## Consequences

- Amends ADR 0004: acceptance follows the claimed token's `requires`, not every declared Check, and stop Outcomes are
  routable. Its separation of claim, harness result and Checks, and its fixed integrity row, stand.
- Amends the request: section 2 ("Work is code" now means gg's Actions; a Procedure is composition), 3.1 (agent
  `gates` and `resolution`), 3.3 (Terminals, `then`, the `gate` and `approval` vertices, Flow layering), 3.4 (Procedures are data; the
  illustrative enums), 3.5 (Action identity), 3.6 (Checks and test paths), 3.9 (the defaults Layer) and 7 (red and
  green on separate Vertices is no longer deferred).
- The Action Marker becomes `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>`.
- A Check records the worktree tree it checked; a commit and the `passed` table count only results on the current
  tree. The tree covers tracked and staged content, not untracked ignored files.
- `testPaths` cannot list `package.json` without freezing its dependencies, so a `scripts.test` that does not call a
  launcher file stays changeable by an agent (grey-goo-ri issue #96).
- A failure routed to another Vertex rescues the work to a Rescue Ref and resets; one routed to an end leaves it in
  place, a failed red included.
- Record and Event versions do not change before grey-goo-ri issue #23; a State Database from an earlier slice is
  deleted, not migrated.
- One validator serves `gg doctor` and `gg run` admission, so a configuration cannot pass one and fail the other.
