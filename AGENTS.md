# grey-goo-ri

Node CLI (`gg`) that carries GitHub tickets through a configurable bounded workflow graph whose Vertices run
persona Agents on agentic harnesses (Claude Code, Codex) to reviewed pull requests.

## Documents and their authority

- `docs/requests/node-harness-dag.md` decides behaviour. Read it before any ticket.
- `docs/adr/` records why the hard-to-reverse decisions were made. Do not reverse one without a new ADR.
- `GLOSSARY.md` decides what things are called, in code, tickets, records, events and labels. Its avoid lists ban
  competing names for a defined concept, not words in their ordinary technical sense.
- Behaviours marked "ported" in the request document have their source in `C:\dev\projects\feature-flow` at
  commit 89e1d67, with line references in `C:\dev\ff-review-work\design-vetting-code.md` section 1. A port ticket
  names its source lines; "port unchanged" without a source is not a complete ticket. A ported file may rename
  identifiers and feature-flow strings; its case names and assertions otherwise stay.

## Conventions

- Plain Node ESM (`.mjs`), Node 24 LTS (24.15 or later, where `node:sqlite` loads without a warning; ADR 0012), must
  run on stock Node on native Windows. npm dependencies are allowed when they earn their place; prefer node
  built-ins. Never adopt an agentic workflow framework (ADR 0001).
- Must work on native Windows: spawn real executables without a shell, forward-slash-safe paths.
- Tests must not call the real `claude`, `codex` or `gh`, or touch GitHub. Logic tests use the fake harness and the fake
  git (`test/support/fake-git.mjs`); real git in temp repositories only for the `lib/git.mjs` contract suite, tests whose
  subject is git behaviour (integrity snapshots and violations, rollback of real files, Test Immutability, dirty state,
  admission's dirty, conflict and branch checks, Reconciliation against git state, the repo lock), and a few end-to-end
  runs.
- Codex output schemas are strict: every property required, `additionalProperties: false`.
- Comments only for the non-obvious why. A comment that carries a spec code starts with a plain-language clause and
  puts the code after it: `// A Hold needs an Await Label (R11f)`. Codes resolve in `docs/requests/node-harness-dag.md`
  and in `docs/research/user-defined-procedures-decisions.md` and its siblings.
- Names: a domain concept takes its full GLOSSARY.md term in camelCase (`executionRecord`, not `rec`; `actionRef`, not
  `at`). Single letters only within about 10 lines of scope. Abbreviations only from `id`, `url`, `sha`, `err`, `gh`,
  `pr`, `json` and `ms`: spell out `ctx`, `opts`, `cfg`, `res`, `out` and the like.
- `null` means deliberately empty in anything persisted or emitted; `undefined` means not given. Use `== null` only to
  test for either.
- Seams: the target is one `deps` object (git, gh, State Database, events, clock, integrity, shell) built at the entry
  point and passed down. #199 moves the code there; until then, new code takes what it needs as a parameter and adds
  no module-level `set*` function or `let`.

## Layout

| Module | Responsibility |
| --- | --- |
| `bin/gg.mjs` | `gg` entry point: usage and command dispatch |
| `lib/opts.mjs` | option parsing |
| `lib/config.mjs` | Layers, merge, migration table, Config Hash, the Layer files each Layer names, Declared Command loading |
| `lib/flow.mjs` | the Resolved Flow and Config Hash written to a Run's directory |
| `lib/validate.mjs` | the Flow validator, which `gg doctor` and `gg run` admission share: the configuration's agents, procedures, flows and the names each template reads checked, giving each Resolved Flow (with each Procedure's hash) plus errors and warnings |
| `lib/refs.mjs` | the one reference-path resolver: parse, read and type every dotted reference path |
| `lib/run.mjs` | `gg run` admission, preflight, pool, run directory, Lifecycle Events, exit codes |
| `lib/interpreter.mjs` | Visits, Actions, Attempts, Edge routing, Bounds, Action Cap |
| `lib/effects.mjs` | write-ahead side effects, the activity bracket, remote retries and backoff, the repo-lock guard |
| `lib/terminal.mjs` | Terminals: hold, abandonment, fault, run-stopped and their reports, Terminal Reason texts |
| `lib/procedures.mjs` | the Action and Check kinds a Procedure may declare: each kind's keys and outputs (Procedures themselves are configuration) |
| `lib/briefs.mjs` | Brief context and rendering, Structured Response schema and response validation |
| `lib/outcome.mjs` | the transition table and Resolution Policy |
| `lib/rules.mjs` | Rule Table first-match evaluation and admission analysis (unreachable rows, overlaps, work limit) |
| `lib/checks.mjs` | Red Check, Green Check, Test Immutability, Findings Hash, the `response` Check's conditions, Check Evidence |
| `lib/integrity.mjs` | Integrity Assertions (worktree snapshots, busy flag, generation, Protected Files) |
| `lib/record.mjs` | Execution Record, Epic Record and Pinned Configuration persistence in the State Database, and the write-ahead log |
| `lib/marker.mjs` | Action Marker format and parse |
| `lib/reconcile.mjs` | Reconciliation of a record against git and GitHub at resume |
| `lib/events.mjs` | event schema 2 append and read from the State Database |
| `lib/labels.mjs` | State, Await and Decide Label names and prefix, and the end states |
| `lib/approval.mjs` | Pending Instance, Approval Digest, timeline read, consumption |
| `lib/locks.mjs` | ticket, epic and repo locks as `node:sqlite` exclusive transactions |
| `lib/harnesses/contract.mjs` | the Harness contract check and shared Usage shape |
| `lib/harnesses/shipped.mjs` | the shipped Harnesses by name; the only module outside a Harness that names one |
| `lib/harnesses/claude.mjs` | **stub**: the Claude Code Harness; exports only `protectedPaths`, so `gg run` preflight fails "not implemented" |
| `lib/harnesses/codex.mjs` | **stub**: the Codex Harness; exports only `protectedPaths`, so `gg run` preflight fails "not implemented" |
| `lib/exec.mjs` | process spawn and job-object runner (ported) |
| `lib/winjob.ps1` | the Windows job-object helper `lib/exec.mjs` runs, which caches its compiled assembly beside itself (ADR 0017) |
| `lib/git.mjs` | the one git interface: named verbs over the git CLI returning parsed values, worktrees (ported) |
| `lib/paths.mjs` | canonical local paths and the path key every path comparison uses |
| `lib/github.mjs` | gh verbs and label writes that never throw (ported) |
| `lib/render.mjs` | the template renderer, commit messages, PR body, comments, provenance, ticket and epic bodies |
| `lib/templates/` | gg's own templates, which no Layer declares: the Terminal Reason comment, the parse-retry nudge and the default recovery section |
| `defaults/` | the defaults Layer: `gg.json` (today it ships Agents `implementer` and `reviewer`, five Procedures and the `default` Flow; ADR 0014's "no shipped Flow" lands with #121) and the files it names, under `personas/`, `templates/` and `schemas/` |
| `lib/work.mjs` | **stub** (`export {}`): `gg work` and the Registry |
| `lib/trace.mjs` | **stub** (`export {}`): Trajectory export and `gg trace` |
| `lib/stats.mjs` | **stub** (`export {}`): `gg stats` |
| `lib/doctor.mjs` | `gg doctor`: the validator's Resolved Flows, warnings and errors, per Vertex. `gg init` is not built (#120) |
| `lib/plan.mjs` | **stub** (`export {}`): `gg plan` |
| `lib/publish.mjs` | **stub** (`export {}`): `gg publish` (to be ported) |
| `scripts/run-suite.mjs` | the suite launcher Codex may run outside its sandbox (ADR 0010) |
| `examples/` | user Layers to copy: a Claude and a Codex harness choice for the shipped Agents |

## Misleading areas

- The stubs marked in Layout: `gg init`, `plan`, `publish`, `work`, `trace` and `stats` print "not implemented".
- The defaults Layer ships a Flow, its Agents, Procedures, Personas and schemas until #121 (ADR 0014: gg ships none).
- feature-flow leftovers until #198: `FF_*` variables, `FFJOB` lines and `[ff: ...]` notes in `lib/exec.mjs` and
  `lib/winjob.ps1`, and the `Feature-Flow-Stage:` commit trailer in `lib/render.mjs`.
- `.agents/feature-flow/` belongs to feature-flow until #97; it is not gg's configuration.
- `test/support/interpreter.mjs`, `run.mjs` and `reconcile.mjs` share lib module names but are test helpers.
- Two seam styles until #199: module-level setters (`github.setGh`, `git.setSleep`, `locks.setClock`,
  `locks.setAttemptWrapper`, `record.setSaveHook`, `events.setAppendHook`) and injected parameters (`runTarget`'s
  `git`, `gh` and `exec`, `integrity.withGit`). New code follows the Seams convention.

## Examples to copy

- A new module: `lib/paths.mjs` (one concept, a why-comment per rule) and `scripts/run-suite.mjs` (a closed set of
  inputs, a usage error that prints the usage).
- A new unit test: `test/unit/record.test.mjs` and `test/unit/interpreter.retry.test.mjs` (one behaviour per case,
  named for it, state asserted, the inputs that matter visible in the case).
- A contract suite and its fake: `test/contract/git/git.test.mjs` and `test/support/fake-git.mjs`.

## Do not copy

Each is rewritten by its ticket; until then, do not take its patterns:

- `lib/validate.mjs` (#206), `test/unit/validate.test.mjs` (#209), `test/unit/interpreter.test.mjs` (#210),
  `test/unit/run.holds.test.mjs` (#211), `test/contract/exec/exec.test.mjs` (#212), `test/support/run.mjs` (#208).

## Tests

Test design (rules, doubles, sizes, layout and stages) follows `docs/testing.md`; the conventions below cover files.

- Every test lives in the layout of `docs/testing.md` for its size: `test/unit/` (small: one process, no child
  process, no real git, no timers), `test/contract/<boundary>/` (one suite per external boundary) or `test/e2e/` (the
  full runs and the real-git wiring). `test/unit/layout.test.mjs` checks `test/unit/`.
- A module's tests of one size go in `<dir>/<module>.test.mjs`. A large module may also have area files
  `<dir>/<module>.<area>.test.mjs`; new tests for it still go in `<dir>/<module>.test.mjs`. node runs files in parallel
  but a file's tests serially, so once a file's serial time passes about 3 minutes, move tests out of it to an area file.
- Tests import modules as namespaces (`import * as record from '../../lib/record.mjs'`) and call `record.fn()`, so a
  missing export fails inside the case.
- A test for a module that does not exist yet uses `await import()` inside the case.
- Ported test files follow the port rule above and rewrite static named imports to namespace imports.
- A fake's contract suite lives under `test/contract/<boundary>/` and runs its cases against the real module and the fake;
  `lib/git.mjs`'s is `test/contract/git/`.
- Fixtures live under `test/fixtures/` as JSON or text.
- Shared helpers live under `test/support/`; the runner lists them as passing empty files.
- Spawn `process.execPath` directly, never a shell.

## Commands

- test: `node scripts/run-suite.mjs` (`npm test` is the same)
- fast stage: `node scripts/run-suite.mjs fast [boundary ...]` runs `test/unit/` and the named `test/contract/` suites

gg reads Declared Commands from `.agents/gg/gg.json` (ADR 0013). This section stays, equal to it, for feature-flow
until the cutover (grey-goo-ri issue #97).
