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

## Architecture

New and changed code moves gg toward deep modules: a lot of behaviour behind a small interface, so callers get
leverage and a change lands in one place (locality).

- One domain concept, one module. What gg knows about a GLOSSARY.md concept (its types, its rules, how it is made, read
  and resumed) lives in the module named for it, so adding a kind or changing a rule is a one-module edit. A list of
  names that other modules match against means the concept is scattered, as the Effects were before #355 gathered each
  into one module in `lib/effects/`, ending `REMOTE_ACTIONS` and an `if (effect === …)` chain.
- The interface is the test surface (`docs/testing.md` rule 2). When reaching one rule takes a golden Flow, the rule
  sits behind the wrong interface.
- The deletion test: a module whose deletion would only move its code into one caller is a pass-through, so fold it in.
  A module whose deletion would copy its code into several callers earns its place.
- The lint caps (400 lines a file, 60 a function) split a module along a seam inside it, into a module only it imports,
  so the concept keeps one owner.

## Conventions

- TypeScript ESM on Node 26 LTS (26.13 or later, where `node:sqlite` loads without a warning; ADR 0020), must run on
  stock Node on native Windows. npm dependencies are allowed when they earn their place; prefer node
  built-ins. Never adopt an agentic workflow framework (ADR 0001).
- Node's type stripping runs the sources, with no build step (ADR 0018): every code file is `.ts`, and
  `test/unit/layout.test.ts` fails on any other. The one JavaScript file is `eslint.config.mjs`, since ESLint 10.14
  loads a `.ts` config only through the optional `jiti` package or an unstable flag. Erasable syntax only (no enums,
  namespaces or parameter properties). The strict ESLint rules apply to every file.
- Must work on native Windows: spawn real executables without a shell, forward-slash-safe paths.
- Tests must not call the real `claude`, `codex` or `gh`, or touch GitHub. Which tests run on a fake and which on real
  git is `docs/testing.md`'s (Test doubles, and the `test/e2e/` row of Layout and stages).
- Codex output schemas are strict: every property required, `additionalProperties: false`.
- Comments only for the non-obvious why. A comment that carries a spec code starts with a plain-language clause and
  puts the code after it: `// A Hold needs an Await Label (R11f)`. Codes resolve in `docs/requests/node-harness-dag.md`
  and in `docs/research/user-defined-procedures-decisions.md` and its siblings.
- Names: a domain concept takes its full GLOSSARY.md term in camelCase (`executionRecord`, not `rec`; `actionIdentity`,
  not `at`). Single letters only within about 10 lines of scope, except `t`, `node:test`'s test context, in tests only.
  Abbreviations only from `id`, `url`, `sha`, `err`,
  `gh`, `pr`, `json` and `ms`: spell out `ctx`, `opts`, `cfg`, `res`, `out`, `dir` and the like. Types are PascalCase,
  other identifiers camelCase (module constants may be CONSTANT_CASE), exports named, never default (ESLint); a file is
  lowercase words joined by hyphens, named for the concept it owns or its job, never `utils` or `helpers` (`test/unit/layout.test.ts`).
- A thrown class ends its name in `Error` and sets `name` to it (`name = 'CrashError';`). ESLint's `gg/thrown-class`
  checks both.
- `null` means deliberately empty in anything persisted or emitted; `undefined` means not given. Use `== null` only to
  test for either. In a configuration file, `null` is never a value: the validator reports it (`null-value`). A missing
  key is optional or `required-key-missing`: each source is read whole, and nothing is inherited (ADR 0022).
- Saved data is JSON by type and at run time: the Execution and Epic Record rows, the Pinned Configuration, an Event and
  the Run directory's `flow.json` serialize through `jsonValue.text` (`lib/json-value.ts`), never `JSON.stringify`. A
  saved field is typed by what gg builds, or as `JsonValue` when it was parsed (configuration, a Structured Response, a
  Harness's output); `unknown` there fails tsc at the save (#342).
- Seams: the deps (`gh`, `git`, `exec`, `locks`, `database`, `clock`, and `integrity` built from git and locks) are
  built once in `bin/gg.ts` and passed down as one `deps` key typed `Deps` (ADR 0019): `run.runTarget` takes it and
  passes it on to `interpreter.runExecution`. New code takes what it needs from its caller as a parameter; ESLint fails
  a module-level `let` or an exported `set*` function. A new key in `Deps` needs a second adapter beside the real one:
  the double `docs/testing.md` (Test doubles) lists for it, held to the real module by a contract suite where the
  boundary allows one.

## Layout

| Module | Responsibility |
| --- | --- |
| `bin/gg.ts` | `gg` entry point: one command table gives the usage, each command's flags and its dispatch |
| `lib/options.ts` | option parsing and its `UsageError` |
| `lib/config.ts` | the two sources (the repository's `.agents/gg/` and the user's `GG_HOME`), each `gg.json` read whole with the files it names, the files a Flow uses, the Config Hash |
| `lib/settings.ts` | the settings both `gg.json` files hold beside their Flows: the repository contract (Declared Commands, `testPaths`, `approvers`, `labelPrefix`, `baseBranch`), the user's machine settings, and the keys each file may hold, as Problems |
| `lib/flow.ts` | the Flow rules the interpreter and the validator share: where an Outcome routes (H7), and the Resolved Flow and Config Hash written to a Run's directory |
| `lib/validate/` | the Flow validator, which `gg doctor` and `gg run` admission share: `index.ts` (`validate()`, the Agents), `procedures.ts`, `actions.ts` and `conditions.ts` (a Procedure on its own), `references.ts` and `templates.ts` (what it reads, typed alone and at each Vertex), `flows.ts` and `inputs.ts` (Flows, Vertices, Agents and inputs), `graph.ts` (the graph checks) and `report.ts` (the errors and warnings, each with a code from its closed list); it gives each Resolved Flow (with each Procedure's hash) plus errors and warnings |
| `lib/model.ts` | the Resolved Flow in memory: its Procedures, Vertices and Claim tokens as Maps keyed by configured name, read from and written back to the validator's JSON |
| `lib/reference-paths.ts` | the one reference-path resolver: parse, read and type every dotted reference path |
| `lib/run.ts` | `gg run`: the Run's Tickets mapped concurrently, run directory, Lifecycle Events, exit codes |
| `lib/run-flows.ts` | the Flows of both sources, each checked against the repository contract and named `user:<name>` when it is the user's; the Flows a Run admits with their Pinned Configurations, the one `--flow` names, preflight over every Flow's Harnesses and the State Database, the Flow an Execution's record pins, and the error for one no longer declared |
| `lib/admission.ts` | `gg run` admission of one Ticket: its Execution Record, readiness and holds, then its Execution |
| `lib/ticket-worktree.ts` | the worktree admission runs a Ticket in: the branch checks that hold it, and the other ticket worktrees |
| `lib/interpreter.ts` | `runExecution`: one Execution from its cursor to a Terminal, after Reconciliation of a resumed record or a pending report's finish; gg's own Protected Files |
| `lib/run-context.ts` | the Run context every step reads (`RunContext`), the deps a test replaces (`Deps`), and how each Action is entered, marked and recorded |
| `lib/clock.ts` | the `Clock` a Run and the locks read, and the wall clock they default to |
| `lib/visit-runner.ts` | one Visit: its Configuration Snapshot and inputs, its Actions and recovery passes, the saved result of each (`settleOf`, the only writer of `visitState.settled`), a stop and its rollback, and the Visit's Outcome |
| `lib/visit-inputs.ts` | the Vertex inputs a Visit pins at its entry, read from the outputs of the Visits before it |
| `lib/rescue.ts` | the Rescue Ref and the write-ahead reset, one mechanism for a failure routed to another Vertex and for an Interrupted Attempt (#68) |
| `lib/visit-scope.ts` | what every Action of a Visit reads and writes: its scope, outputs and Claim token, and `settle` |
| `lib/bounds.ts` | Edge traversal: the route `lib/flow.ts` gives under each Bound, and the Action Cap |
| `lib/agent-action.ts` | the agent Action: its Attempts, each with its Brief, Session and Harness, and the result the Transition Table makes of its Signals |
| `lib/agent-call.ts` | an Attempt's call under the Integrity Assertions: its baseline and intent, the Harness's run with its heartbeat, Test Immutability |
| `lib/check-action.ts` | the check Action and its Check kinds (`command`, `tests-fail`, `response`, `repeat`) |
| `lib/attempt.ts` | an Attempt from its start to its saved result: its start, its Action Marker, its work (bracketed busy when it touches the worktree, `whileBusy`), and one save holding its result, its completion, its outputs and its Action Event; a complete one's saved result; a held completion (J4); an Effect's Attempt (`effectAction`) |
| `lib/effect-actions.ts` | the deterministic Actions (commit, push, comment, pr-upsert, pr-ready): the payload each builds for its Effect |
| `lib/approval-action.ts` | the await-approval Action: an Approval Request's write-ahead Actions and a Decision's consumption |
| `lib/cleanup-hold.ts` | a Pending cleanup hold: its label and comment, and a later Run's confirmation under the recorded containment |
| `lib/pending-report.ts` | what a Run does for a Ticket it leaves Pending: its label and comment Actions and the ending that stops the Run |
| `lib/effects/` | the Effects, one module each (`commit.ts`, `push.ts`, `comment.ts`, `pr-upsert.ts`, `pr-ready.ts`, `label.ts`, `rescue.ts`, `reset.ts`): its payload, its perform, how an open intent of it is found by its Action Marker or finished at resume, the worktree state it proves, and whether it is remote; `index.ts`, the lookup by the name an intent persists; `side-effect.ts`, `sideEffect`: the context an Action's effects read, and an Effect's intent, launch and evidence in the write-ahead log, which its Attempt's save completes |
| `lib/effect-errors.ts` | what the effects throw: crash points, `EarlyTerminalError` (an Execution held, abandoned or stopped from inside an Action), `RetriesExhaustedError` |
| `lib/remote-effects.ts` | a remote Effect's retries and backoff on a budget saved first, the effect lookup before a retry, the repo-lock guard |
| `lib/terminal.ts` | Terminals: hold, abandonment, fault and run stops, the Terminal each ends at, Terminal Reason texts |
| `lib/terminal-report.ts` | a Terminal's report: its comment and label Actions, the stop it saves first, its state and ticket_end, its run stop |
| `lib/procedures.ts` | the Action and Check kinds a Procedure may declare: each kind's keys and outputs (Procedures themselves are configuration) |
| `lib/briefs.ts` | Brief context and rendering, Structured Response schema and response validation |
| `lib/outcome.ts` | the Transition Table and Resolution Policy |
| `lib/rules.ts` | Rule Table first-match evaluation and admission analysis (unreachable rows, overlaps, work limit) |
| `lib/rule-domain.ts` | a Rule Table's finite domain for that analysis: each field's partition, the row masks per value, and the passes over every point |
| `lib/checks.ts` | Red Check, Green Check, Test Immutability, Findings Hash, the `response` Check's conditions, Check Evidence |
| `lib/integrity.ts` | Integrity Assertions (worktree snapshots, busy flag, generation, Protected Files) and their types: the snapshot, the Attempt baseline, Integrity Violations |
| `lib/record.ts` | Execution Record and Epic Record: their types, creation, persistence in the State Database and its writes (`StateDatabase`) |
| `lib/record-json.ts` | a record's row: the Execution Record's JSON type (`ExecutionRecordJson`) and its only Map conversion (`toJson`, `fromJson`), the parse that tells a corrupt row (`RecordCorruptError`); `lib/record.ts` re-exports what callers use |
| `lib/json-value.ts` | the JSON gg saves: its type (`JsonValue`), the typed gate (`JsonChecked`) and `text`, the one function every save path serializes through: it writes a copy checked at run time (`checked`), which refuses what JSON cannot hold, by its path |
| `lib/json-parse.d.ts` | the overload that makes `JSON.parse` give `unknown` in gg, so tsc refuses its result wherever no check has narrowed it |
| `lib/state-database.ts` | the State Database file: its creation, which only `gg init` makes (ADR 0023), one connection per repository that refuses a missing or unknown database, Pinned Configurations and reusable Check results |
| `lib/write-ahead.ts` | the write-ahead log's entries, what an intent and its evidence hold (`Payload`, `Evidence`), and what reads them: open intents, evidence |
| `lib/visit.ts` | types only: the Visit's saved shapes (Configuration Snapshot, Vertex inputs, `VisitState`, the `Resolution` union, an Action's outputs, a History item) |
| `lib/marker.ts` | Action Marker format and parse |
| `lib/reconcile.ts` | Reconciliation of a record against git and GitHub at resume, and admission's load of a record or its corrupt row |
| `lib/events.ts` | event schema 2: each Event's declaration, its builders and its append to the State Database |
| `lib/event-read.ts` | the event log read back: each row checked against its Event's declaration, its fields gg reads and its indexed columns, a refused row an `EventCorruptError` naming it; whether an Execution's ticket_end has landed |
| `lib/labels.ts` | State, Await and Decide Label names and prefix, and the end states |
| `lib/approval.ts` | Pending Instance, Approval Digest, timeline read, consumption |
| `lib/locks.ts` | ticket, epic and repo locks as `node:sqlite` exclusive transactions |
| `lib/harnesses/contract.ts` | the Harness contract check and shared Usage shape |
| `lib/harnesses/shipped.ts` | the shipped Harnesses by name; the only module outside a Harness that names one |
| `lib/harnesses/claude.ts` | **stub**: the Claude Code Harness; exports only `protectedPaths`, so `gg run` preflight fails "not implemented" |
| `lib/harnesses/codex.ts` | **stub**: the Codex Harness; exports only `protectedPaths`, so `gg run` preflight fails "not implemented" |
| `lib/exec.ts` | process spawn (a nonzero exit rejects with a `CommandError`) and the shell runner, with its timeout and cleanup (ported) |
| `lib/command-cleanup.ts` | Command Cleanup's decisions, with no I/O: the `ps` listing parse, the descendant closure, the watcher's update, the kill plans and their survivors, a job's leftovers, the `cleanup` report |
| `lib/process-tree.ts` | the processes a shell command leaves, on either platform: listing, watching and killing them as Command Cleanup decides, the Windows job's termination, and the helper processes that do so (ported) |
| `lib/containment.ts` | the Windows job object a shell command, or the suite launcher's stage, runs in, through `node:ffi`: start, list, name, terminate, confirm empty (ADR 0021) |
| `lib/git.ts` | the one git interface: named verbs over the git CLI returning parsed values, worktrees (ported) |
| `lib/git-default-branch.ts` | the branch a repository's Tickets start from by default, which `gg init` writes as `baseBranch`: origin's HEAD, else the checked-out branch |
| `lib/git-temp-index.ts` | what `lib/git.ts` reads through a copy of the index: a worktree's fingerprint and a rescue's tree |
| `lib/paths.ts` | canonical local paths and the path key every path comparison uses |
| `lib/github.ts` | gh verbs, and the label writes and the read of the repository's `owner/name` that never throw; a failed gh process is a `GhError` carrying its HTTP status and rate limit (ported) |
| `lib/gh-answer.ts` | gh's JSON answers read field by field into the types `lib/github.ts` declares: a field of the wrong type fails the verb, naming its path (#354) |
| `lib/render.ts` | the template renderer, commit messages, PR body, comments, provenance |
| `lib/public-text.ts` | redaction of the local directories in text gg publishes |
| `lib/templates/` | gg's own templates, which no source declares: the Terminal Reason comment, the Approval Request and cleanup hold comments, the parse-retry nudge and the default recovery section |
| `lib/work.ts` | `gg work abandon`: a Ticket's Execution Record forgotten, its worktree and branch kept; the rest of `gg work` and the Registry are to come |
| `lib/trace.ts` | **stub** (`export {}`): Trajectory export and `gg trace` |
| `lib/stats.ts` | **stub** (`export {}`): `gg stats` |
| `lib/doctor.ts` | `gg doctor`: both sources' Resolved Flows, each with its source, their warnings and errors per Vertex, the labels they can request that the repository lacks, and the Execution Records whose Flow is gone or a missing State Database; `gg init`: the example, `test/fixtures/example/`, written into a repository, the user's `gg.json` with the machine settings, and the State Database |
| `lib/plan.ts` | **stub** (`export {}`): `gg plan` |
| `lib/publish.ts` | **stub** (`export {}`): `gg publish` (to be ported) |
| `scripts/run-suite.ts` | the suite launcher Codex may run outside its sandbox (ADR 0010); the full and fast stages' census of what they leave running (`docs/testing.md`) |
| `examples/` | each Harness's harness, model and effort for the Agents of the example, which `gg init --harness <name>` writes |

## Misleading areas

- The stubs marked in Layout: `plan`, `publish`, `trace` and `stats` print "not implemented", as do the `gg work` verbs
  other than `abandon`.
- `gg init` writes `test/fixtures/example/`, the example the tests run, so the fixture is shipped content: a change to it
  changes what a new repository gets. `test/fixtures/shipped-flow/` keeps the Flow the defaults shipped until #121 for
  the golden traces; gg ships no Flow now.
- `.agents/feature-flow/` belongs to feature-flow until #97; it is not gg's configuration.
- `git.ts`, `locks.ts` and `record.ts` also export the functions of their real instance, for callers that take no
  seam (`gg doctor`, contract suites, helper processes); code on a Run's path uses the deps it was passed instead.

## Examples to copy

- A new module: `lib/paths.ts` (one concept, a why-comment per rule) and `scripts/run-suite.ts` (a closed set of
  inputs, a usage error that prints the usage).
- A module split along a seam inside it: `lib/rules.ts` with `lib/rule-domain.ts`, which only it imports.
- Options objects in place of positional flags: `sideEffect.sideEffect` (`lib/effects/side-effect.ts`), `attempt.run` and `attempt.effectAction` (`lib/attempt.ts`).
- A long function cut into named steps: `lib/interpreter.ts`, with `lib/visit-runner.ts`.
- A new unit test: `test/unit/record.test.ts` and `test/unit/interpreter.retry.test.ts` (one behaviour per case,
  named for it, state asserted, the inputs that matter visible in the case).
- A contract suite and its fake: `test/contract/git/git.test.ts` and `test/support/fake-git.ts`.
- A fake typed against the interface it stands in for: `test/support/fake-git.ts` (lib/git.ts's `Git`) and
  `test/support/fake-gh.ts` (lib/github.ts's transport).

## Tests

Test design (rules, doubles, sizes, layout and stages) follows `docs/testing.md`; the conventions below cover files.

- Every test lives in the layout of `docs/testing.md` for its size: `test/unit/` (small: one process, no child
  process, no real git, no timers), `test/contract/<boundary>/` (one suite per external boundary) or `test/e2e/` (the
  full runs and the real-git wiring). `test/unit/layout.test.ts` checks `test/unit/`.
- A module's tests of one size go in `<directory>/<module>.test.ts`. A large module may also have area files
  `<directory>/<module>.<area>.test.ts`; new tests for it still go in `<directory>/<module>.test.ts`. node runs files in
  parallel but a file's tests serially, so once a file's serial time passes about 3 minutes, move tests out of it to an
  area file.
- Tests import modules as namespaces (`import * as record from '../../lib/record.ts'`) and call `record.fn()`, so each
  call names its module, and in a focused `node --test` run, which strips types unchecked, a missing export fails inside
  the case. ESLint enforces it, for a test file's type imports too.
- A test for a module that does not exist yet imports a stub module: its exports with their final signatures, each
  returning a wrong value.
- Ported test files follow the port rule above and rewrite static named imports to namespace imports.
- A fake's contract suite lives under `test/contract/<boundary>/` and runs its cases against the real module and the fake;
  `lib/git.ts`'s is `test/contract/git/`.
- Fixtures live under `test/fixtures/` as JSON or text.
- Shared helpers live under `test/support/`, one helper per job, each file named for that job and never for the lib
  module it serves (`test/unit/layout.test.ts`). A fixture builder says whether it runs the Execution:
  `golden.fixture`, `greenFixture`, `reviewFixture` and the run fixture build one; `runFirstVisit` and
  `runReviewFlow` run it. A case asks for real git by name (`git: 'real'`); real integrity alone runs over the fake
  git.
- Spawn `process.execPath` directly, never a shell.

## Commands

- test: `node scripts/run-suite.ts` (`npm test` is the same)
- fast stage: `node scripts/run-suite.ts fast [boundary ...]` runs `test/unit/` and the named `test/contract/` suites
- check stage: `node scripts/run-suite.ts check` runs the format check, lint and the type check, and no tests
- coverage stage: `node scripts/run-suite.ts coverage` holds unit coverage at or above the fixed floor `COVERAGE_FLOOR` in `scripts/run-suite.ts`
- lint: `node node_modules/eslint/bin/eslint.js .`
- typecheck: `node node_modules/typescript/bin/tsc -p tsconfig.json`
- format: `node node_modules/prettier/bin/prettier.cjs --check .` (`--write` in place of `--check` fixes the format)

Run `npm ci` once in a new checkout or worktree: every stage runs the format check, lint and the type check before its
tests, and stops at the first failure.

gg reads Declared Commands from `.agents/gg/gg.json` (ADR 0013). This section stays, equal to it, for feature-flow
until the cutover (grey-goo-ri issue #97).
