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

## Frozen interfaces

Request slices 2 to 7 build on these, frozen at #23. `test/unit/freeze.test.ts` holds each document to the code.

- `docs/interfaces/harness.md`: the Harness contract, `run(call)`'s argument and result, and the fake harness's
  scripting keys (`FAKE_HARNESS_VERSION`).
- `docs/interfaces/record.md`: the Execution Record, the Epic Record and the State Database (`RECORD_SCHEMA_VERSION`,
  `stateDatabase.SCHEMA_VERSION`).
- `docs/interfaces/events.md`: the Action Event and each Lifecycle Event (`EVENT_SCHEMA_VERSION`).

Changing anything these three list, outside their Reserved sections, needs a new ADR under `docs/adr/` and a version
bump of the constant it names. A Reserved shape lands in the ticket its entry names, inside the field it names.

- `docs/interfaces/problems.md`: the validator's Problem codes, under the promise it states instead: a code keeps its
  meaning; adding one needs no ADR; renaming or removing one, or changing what it means, needs a new ADR.

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
- A check that judges a value gives its typed value; nothing judges it again. A second judgment that restates a check,
  such as a type guard over what a check accepted, has no behaviour of its own to test, so its coverage never closes
  (#391).

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
  passes it on to `interpreter.runExecution`. `database` is every read and write a Run makes to the State Database
  (#367): the record rows with their write-ahead log, the Event append and reads, Pinned Configurations, Check results,
  and the other Tickets' Activity the Integrity Assertions read, which their caller passes them. New code takes what it
  needs from its caller as a parameter; ESLint fails a module-level `let` or an exported `set*` function. A new key in
  `Deps` needs a second adapter beside the real one: the double `docs/testing.md` (Test doubles) lists for it, held to
  the real module by a contract suite where the boundary allows one.

## Layout

| Module | Responsibility |
| --- | --- |
| `bin/gg.ts` | `gg` entry point: one command table gives the usage, each command's flags and its dispatch; `main`, over the gh it is passed and any Harnesses joined to the shipped ones, which the tests that spawn gg pass as the fake gh and a stand-in Harness that starts no CLI (`test/support/gg-over-fake-gh.ts`) |
| `lib/options.ts` | option parsing and its `UsageError` |
| `lib/config.ts` | the two sources (the repository's `.agents/gg/` and the user's `GG_HOME`), each `gg.json` read whole with the files it names (at the keys `lib/procedures.ts` declares), the Pinned Configuration and its Config Hash, and the value an Execution runs under (`Pinned`) |
| `lib/settings.ts` | the settings both `gg.json` files hold beside their Flows: the repository contract (Declared Commands, `testPaths`, `approvers`, `labelPrefix`, `baseBranch`), the user's machine settings, and the keys each file may hold, parsed to Settings or their Problems, never both |
| `lib/flow.ts` | the Flow rules the interpreter and the validator share: where an Outcome routes (H7), and the Resolved Flow and Config Hash written to a Run's directory |
| `lib/validate/` | the Flow validator, which `gg doctor` and `gg run` admission share: `index.ts` (`validate()`), `procedures.ts`, `actions.ts` and `conditions.ts` (a Procedure on its own), `references.ts` and `templates.ts` (what it reads, typed alone and at each Vertex), `flows.ts`, `routes.ts` and `inputs.ts` (Flows, Vertices, routes and inputs), `agents.ts` (each declared Agent and the Agent each Vertex runs), `capabilities.ts` (what each Harness's Capabilities refuse of an Agent and a recovering Vertex), `claim-tokens.ts` (a Procedure's Claim tokens), `graph.ts` (the graph checks) with `route-facts.ts` (what a route guarantees: pr-ready before ready-for-qa and each input's sources), which only it imports, `declared.ts` (each Flow as written, its Resolved Flow and what it uses) and `report.ts` (the errors and warnings, each with a code from its closed list, and `Reported`, what a check gives for a value it refused, and the value tests every part shares, from `configured-values.ts`, which only it imports), with `null-values.ts` (every null reported first, which each check also refuses at its key); each check gives the value it judged typed, so it gives every Flow as written, each Flow whose checks refused no value it copies as its Resolved Flow (with each Procedure's hash), the files and commands each Flow uses, plus errors and warnings |
| `lib/model.ts` | the Resolved Flow: its JSON's one declared type (`ResolvedFlowJson`), the view of a Flow as written that `gg doctor` prints (`DeclaredFlowJson`), the Vertex the interpreter reads, and the Flow in memory, its Procedures, Vertices and Claim tokens as Maps keyed by configured name, read from and written back to that JSON |
| `lib/reference-paths.ts` | the one reference-path resolver: parse, read and type every dotted reference path |
| `lib/run.ts` | `gg run`: its preflight over the checked configuration, with the Flow `--flow` names, the `preflight failed` text and its exit code, and each admitted Flow pinned with its Pinned Configuration; the Run's Tickets mapped concurrently, run directory, Lifecycle Events, each Ticket's result and the exit codes |
| `lib/configuration-check.ts` | the configuration check `gg doctor` and `gg run` share (V1): the Flows of both sources, each checked against the repository contract and named `user:<name>` when it is the user's, the settings, each user Flow that does not fit the repository, the State Database, the Execution Records a Run would resume whose Flow is gone and each whose row cannot be read, and Harness preflight over every admitted Flow, with each used Harness's `doctor` once, given the Agents the admitted Flows run on it (cheap, or with its probes under `gg doctor --probe`); the repository's GitHub owner/name both read, and the error a failed read gives (#372) |
| `lib/admission.ts` | `gg run` admission of one Ticket: its Execution Record, readiness and holds, then its Execution under the Flow its record pins, handed whole as that Flow's pinned value (`config.Pinned`), the Run's Settings giving only what the Config Hash does not cover |
| `lib/ticket-worktree.ts` | the worktree admission runs a Ticket in: the branch checks that hold it, and the other ticket worktrees |
| `lib/interpreter.ts` | `runExecution`: one Execution from its cursor to a Terminal, after Reconciliation of a resumed record or a pending report's finish; `resumption`, what a Run does with a record it finds; gg's own Protected Files |
| `lib/run-context.ts` | what `runExecution` takes (`ExecutionOptions`), where everything the Config Hash covers is one value, `pinned`, with that hash; the Run context every step reads (`RunContext`), the deps a test replaces (`Deps`), and how each Action is entered, marked and recorded |
| `lib/clock.ts` | the `Clock` a Run and the locks read, and the wall clock they default to |
| `lib/visit-runner.ts` | one Visit: its Configuration Snapshot and inputs, its Actions and recovery passes, the saved result of each (`settleOf`, the only writer of `visitState.settled`), a stop and its rollback, and the Visit's Outcome |
| `lib/visit-inputs.ts` | the Vertex inputs a Visit pins at its entry, read from the outputs of the Visits before it |
| `lib/branch-tip.ts` | the branch tip an Execution Record proves: gg's last commit, or the tip a later `gg work resume` took as the baseline (Q2 A), which Reconciliation holds the branch to and publishing pushes and marks ready |
| `lib/rescue.ts` | the Rescue Ref and the write-ahead reset, one mechanism for a failure routed to another Vertex and for an Interrupted Attempt; the Interrupted Attempt's recovery at resume: rescued, reset under a `job` and retried once on its `crash` budget, else held (#68) |
| `lib/visit-scope.ts` | what every Action of a Visit reads and writes: its scope, outputs and Claim token, and `settle` |
| `lib/bounds.ts` | Edge traversal: the route `lib/flow.ts` gives under each Bound, and the Action Cap, each read from the Execution Record and its Flow alone, which a Run context holds |
| `lib/agent-action.ts` | the agent Action: its Attempts, each with its Brief, Session and Harness, and the result the Transition Table makes of its Signals |
| `lib/agent-handoff.ts` | an agent's hand-off past its `contextBudget` (#430), for `lib/agent-action.ts` alone: the Claim token and note a budgeted Agent's schema gains, the note and Session the next Attempt takes over in a fresh Session, the handed-off Sessions its record keeps, and the `gg ask-session` rule that lets it ask one, given only to an agent whose Harness runs its commands outside a sandbox (#485 Q1 B) |
| `lib/agent-call.ts` | an Attempt's call under the Integrity Assertions: its baseline and intent, the Harness's run with its heartbeat, Test Immutability |
| `lib/check-action.ts` | the check Action and its Check kinds (`command`, `tests-fail`, `response`, `repeat`) |
| `lib/attempt.ts` | an Attempt from its start to its saved result: its start, its Action Marker, its work (bracketed busy when it touches the worktree, `whileBusy`), and one save holding its result, its completion, its outputs and its Action Event; a complete one's saved result; a held completion (J4); an Effect's Attempt (`effectAction`) |
| `lib/effect-actions.ts` | the deterministic Actions (commit, push, comment, pr-upsert, pr-ready): the payload each builds for its Effect |
| `lib/approval-action.ts` | the await-approval Action: an Approval Request's write-ahead Actions and a Decision's consumption |
| `lib/cleanup-hold.ts` | a Pending cleanup hold: its label and comment, and a later Run's confirmation under the recorded containment |
| `lib/pending-report.ts` | what a Run does for a Ticket it leaves Pending: its label and comment Actions and the ending that stops the Run |
| `lib/effects/` | the Effects, one module each (`commit.ts`, `push.ts`, `comment.ts`, `pr-upsert.ts`, `pr-ready.ts`, `label.ts`, `close.ts`, `rescue.ts`, `reset.ts`): its payload and the reader that reads an intent's from a row, its perform, how an open intent of it is found by its Action Marker or finished at resume, the worktree state it proves, and whether it is remote; `index.ts`, the lookup by the name an intent persists; `side-effect.ts`, `sideEffect`: the context an Action's effects read, and an Effect's intent, launch and evidence in the write-ahead log, which its Attempt's save completes |
| `lib/effect-errors.ts` | what the effects throw: crash points, `EarlyTerminalError` (an Execution held, abandoned or stopped from inside an Action), `RetriesExhaustedError` |
| `lib/remote-effects.ts` | a remote Effect's retries and backoff on a budget saved first, the effect lookup before a retry, the repo-lock guard |
| `lib/terminal.ts` | Terminals: hold, abandonment, fault and run stops, the Terminal each ends at, Terminal Reason texts |
| `lib/terminal-report.ts` | a Terminal's report: its comment and label Actions, the stop it saves first, its state and ticket_end, its run stop; `resolve`, gg work done's report |
| `lib/procedures.ts` | the Action and Check kinds a Procedure may declare: each kind's keys and outputs, and the keys that name a file (`FILE_KEYS`), which the loader and the validator both read, and the files a Procedure names (`procedureFiles`), which a Visit pins (Procedures themselves are configuration) |
| `lib/briefs.ts` | Brief context and rendering, Structured Response schema and response validation |
| `lib/outcome.ts` | the Transition Table and Resolution Policy |
| `lib/rules.ts` | Rule Table first-match evaluation and admission analysis (unreachable rows, overlaps, work limit) |
| `lib/rule-domain.ts` | a Rule Table's finite domain for that analysis: each field's partition, the row masks per value, and the passes over every point |
| `lib/checks.ts` | Red Check, Green Check, Test Immutability, Findings Hash, the `response` Check's conditions, Check Evidence |
| `lib/integrity.ts` | Integrity Assertions (worktree snapshots, busy flag, generation, Protected Files) and their types: the snapshot, the Attempt baseline, Integrity Violations |
| `lib/record.ts` | Execution Record and Epic Record: their types, creation, and the row each saves as, checked against its declared fields (`rowOf`) |
| `lib/record-json.ts` | a record's row: the Execution Record's JSON type (`ExecutionRecordJson`), the Epic Record's (`EpicRecordJson`), and the Execution Record's only Map conversion (`toJson`, `fromJson`), the parse that tells a corrupt row (`RecordCorruptError`); `lib/record.ts` re-exports what callers use |
| `lib/record-read.ts` | a record's row read whole, field by field, into the types `lib/record-json.ts` saves: a wrong type, a key left out or undeclared, or a string outside its closed set is a `RowFieldError` naming its path; an intent's payload read by its effect's reader |
| `lib/record-read-visit.ts` | what an Execution Record's row nests for its Visits, read for `lib/record-read.ts`: the Configuration Snapshot, the Visit's progress and Resolution, each Action's outputs, and the History items, worktree snapshots, untracked files and baselines the payload readers of `lib/write-ahead.ts` and `lib/effects/` read too |
| `lib/record-read-node.ts` | the node readers the two record read modules build a record's row from, and the payload readers of `lib/write-ahead.ts` and `lib/effects/` an intent's payload: a typed value of one node, or a `RowFieldError` naming its path |
| `lib/json-value.ts` | the JSON gg saves: its type (`JsonValue`), the typed gate (`JsonChecked`) and `text`, the one function every save path serializes through: it writes a copy checked at run time (`checked`), which refuses what JSON cannot hold, by its path, and `checkedObject`, that copy of an object typed as a JSON object; `fullySeen`, whether a check of an object's own keys saw all a reader of it reads, which `briefs.assertStrict` asks of each object in a schema |
| `lib/json-parse.d.ts` | the overload that makes `JSON.parse` give `unknown` in gg, so tsc refuses its result wherever no check has narrowed it |
| `lib/state-database/` | the State Database and all its SQL: `index.ts`, the file, its creation, which only `gg init` makes (ADR 0023), one connection per repository that refuses a missing or unknown database, and the `database` a Run is handed (`createStateDatabase`, `StateDatabase`), every read and write a Run makes to it, whose real instance the module itself is; one module per table group, each taking a connection: `records.ts`, `events.ts`, `pinned-configurations.ts` and `check-results.ts` |
| `lib/write-ahead.ts` | the write-ahead log's entries, what an intent and its evidence hold (`Payload`, `Evidence`), and what reads them: open intents, evidence, the agent call's payload reader (`readCallPayload`), and `payloadOf`, an entry's payload read at use by its effect's reader as a save writes it |
| `lib/visit.ts` | types only: the Visit's saved shapes (Configuration Snapshot, Vertex inputs, `VisitState`, the `Resolution` union, an Action's outputs, a History item) |
| `lib/marker.ts` | Action Marker format and parse |
| `lib/reconcile.ts` | Reconciliation of a record against git and GitHub at resume, and admission's load of a record or its corrupt row |
| `lib/events.ts` | event schema 2 (`EVENT_SCHEMA_VERSION`, frozen in `docs/interfaces/events.md`): each Event's declaration, its builders and the Event log that appends each through `database` |
| `lib/event-declaration.ts` | how lib/events.ts declares and checks an Event's fields: required or optional, in their saved order, and a closed Usage; only lib/events.ts imports it |
| `lib/event-read.ts` | the event log read back: each row `lib/state-database/` reads checked against its Event's declaration, its fields gg reads and its indexed columns, a refused row an `EventCorruptError` naming it |
| `lib/labels.ts` | State, Await and Decide Label names and prefix, and the end states |
| `lib/approval.ts` | Pending Instance, Approval Digest, timeline read, consumption |
| `lib/locks.ts` | ticket, epic and repo locks as `node:sqlite` exclusive transactions |
| `lib/harnesses/contract.ts` | the Harness contract check, the shared Usage shape and its delta (`usageDelta`: a call's Session total less the total before it) |
| `lib/harnesses/cli-call.ts` | one Agent CLI call, which every Harness makes the same way: its launch over `exec.launch` under the stall and wall clocks and the cancel signal, its lines read by the Harness's own stream parse, and its status at exit with the stderr tail in a failure (#480) |
| `lib/harnesses/cli-doctor.ts` | what every Harness's doctor does with its Agent CLI: a command started and what it printed (`said`), the version against a pinned minimum, the login, the cheap and probe wall limits, a probe's temporary directory (#480), and the one shell check and containment probe every Harness's doctor runs on win32: the first shell on PATH, an app execution alias followed to its target, fails when packaged under `\WindowsApps\` unless the Harness's commands stay in gg's job there anyway, and under `--probe` a command in it must leave its child in gg's job (ADR 0030 decisions 2 and 5, #533) |
| `lib/harnesses/shipped.ts` | the shipped Harnesses by name, as declared (`HARNESSES`), and each built from the `exec` `bin/gg.ts` passes (`shipped(exec)`), holding only the contract's members of each declaration; the only module outside a Harness that names one |
| `lib/harnesses/claude.ts` | the Claude Code Harness: its declaration (Capabilities, `validate`, `resolveTools` with the tools, the permission rules for the platform's shell and each listed plugin's directory, `launchArgs` with the launch profile's argv, environment and files (the settings file with the hand-off hook of an Agent with a `contextBudget`, and `--fork-session` for gg ask-session's copy), and the launch profile's name and version), and `createCli(exec)`, whose `run` launches the CLI over `exec.launch` and gives the contract's result from its stream, Usage, transcript and repository digest, and `doctor` over `lib/harnesses/claude-doctor.ts`; `interactiveArgs` and `metrics` throw "not implemented" until their slices |
| `lib/harnesses/claude-doctor.ts` | the Claude Harness's `doctor`, for `lib/harnesses/claude.ts` alone: the cheap checks with no model call (executable, version against the pinned minimum, login, the win32 shell by `cli-doctor.ts`'s shared shell check, `gg` on PATH for gg ask-session, the `--bare` help line, and each Agent's listed plugin whose hook can rewrite a shell command, a warning) and the probes `gg doctor --probe` adds (the launch profile's, the hand-off hook's on the same call, a read-only fork of its handed-off Session as gg ask-session asks one, `--bare` with `CLAUDE_CODE_OAUTH_TOKEN`, and on win32 the containment probe in its shell) (#427, ADR 0028, #430, ADR 0032) |
| `lib/harnesses/claude-plugins.ts` | where a listed plugin is installed, read from Claude Code's configuration directory (ported), and whether the hooks it declares can rewrite a tool's input before it runs (#484 Q5 A), for `lib/harnesses/claude.ts` alone |
| `lib/harnesses/claude-stream.ts` | what a Claude call's `stream-json` lines say, read for `lib/harnesses/claude.ts` alone: its session, failure and Failure Class, response, counts and the Session's token totals (#425) |
| `lib/harnesses/claude-handoff-hook.ts` | the PostToolUse hook gg's Claude settings file installs for an Agent with a `contextBudget`: past it, the request to hand off with a note of what remains, once in each 40,000 tokens further (#430) |
| `lib/harnesses/ask-session.ts` | `gg ask-session`: a question to a Session an agent handed off, found on its Execution Record and asked through a read-only copy of it under the launch profile (#430) |
| `lib/harnesses/codex-doctor.ts` | the Codex Harness's `doctor`, for `lib/harnesses/codex.ts` alone, every command in gg's `CODEX_HOME`: the cheap checks with no model call (executable, version against the pinned minimum, login, on win32 one command under MXC by the marker line it prints and `pwsh` on PATH by `cli-doctor.ts`'s shared shell check) and the probes `gg doctor --probe` adds (the launch profile on a cheap call, `codex exec resume` of its thread with `--output-schema`, and on win32 the containment probe through `codex sandbox` under MXC) (#484, #533 Q1 B) |
| `lib/harnesses/codex-plugins.ts` | what a listed plugin brings, for `lib/harnesses/codex.ts` alone: its parts found by manifest key or folder file from the layout the Harness passes in, and those outside the set it admits, naming no Harness (#481 Q3) |
| `lib/harnesses/codex-skills.ts` | the skills list gg writes into a Codex call's prompt, for `lib/harnesses/codex.ts` alone: each skill's name, description and `SKILL.md` path read from its front matter, a folder of skills read whole but a bundled skill Codex uses only on request (D7 A), a listed plugin's marked to use only when named (D8 C), each skill an Agent declares found in the user's skills folder, and the list's text (#481 D2 A) |
| `lib/harnesses/codex-listings.ts` | what Codex lists of gg's Codex home, for `lib/harnesses/codex.ts` alone, which re-exports `list`: the installed plugins and the configured MCP servers, each listing failed by its command when it fails or prints an unexpected shape |
| `lib/harnesses/codex-handoff-hook.ts` | the PostToolUse hook gg's Codex launch installs for an Agent with a `contextBudget`, for `lib/harnesses/codex.ts` alone: its command line, the latest request's context read from the thread's rollout, past the budget the request to hand off with a note of what remains, once in each 40,000 tokens further, and the hook files in gg's Codex home that fail a budgeted Agent (#485, ADR 0033) |
| `lib/harnesses/codex.ts` | the Codex Harness: its declaration (Capabilities, `resolveTools`, the launch profile `codex-exec` and `launchArgs` under gg's Codex home, ADR 0031, with the skills list it writes into the prompt, and hooks on with the hand-off hook for an Agent with a `contextBudget`, ADR 0033), the matching of the plugin and MCP listings, and `createCli(exec)`, whose `validate` lists once per preflight (#481 Q2 A) and finds each declared skill in the user's skills folder, `doctor` over `lib/harnesses/codex-doctor.ts`, and `run` over `lib/harnesses/codex-run.ts`, each call's launch over a listing of its own, taken before it spawns |
| `lib/harnesses/codex-run.ts` | one Attempt through `codex exec`, for `lib/harnesses/codex.ts` alone: the launch profile's files written, the persona and skills list leading a Session's first prompt on stdin (Q4 A), the call over `lib/harnesses/cli-call.ts`, and the contract's result: the response from the `-o` file's final message (F2), Usage from the thread's cumulative totals with null for what Codex does not report (F3), the thread id, else the resumed one, and the rollout's facts, a resume whose rollout is missing or ran under another sandbox discarded (#482) |
| `lib/harnesses/codex-stream.ts` | what a Codex call's `--json` events and its rollout say, read for `lib/harnesses/codex.ts` alone: the thread, the failure from the final event with its Failure Class by Codex 0.171's own texts (Q2 A), the token totals and tool calls, and the rollout, found by thread id across the sessions tree, with its CLI version and its last turn's model, effort and sandbox (#482) |
| `lib/exec.ts` | process spawn (a nonzero exit rejects with a `CommandError`), the shell runner, with its timeout and cleanup (ported), and `launch`, an argv run contained with no shell under its stall and wall clocks and the cancel signal, its tree taken down (#423) |
| `lib/containment-probe.ts` | the containment probe's command, for `lib/exec.ts` alone (`childInJob`): an argv started behind the gate in a new job with no watcher, and whether the pid its first line of a pid alone names is in that job (ADR 0030 decision 5, #533) |
| `lib/command-shim.ts` | what an argv starts as with no shell, for `run` and `launch`: on Windows an npm `.cmd` shim for a node bin read for the script it names, any other `.cmd` refused |
| `lib/launch-clock.ts` | the clocks that stop a launch: the stall clock, which output and `onIdle`'s last activity re-arm, the wall clock and the cancel signal |
| `lib/command-cleanup.ts` | Command Cleanup's decisions, with no I/O: the `ps` listing parse, the descendant closure, the watcher's update, the kill plans and their survivors, a job's leftovers, the `cleanup` report |
| `lib/process-tree.ts` | the processes a shell command leaves, on either platform: listing, watching and killing them as Command Cleanup decides, the Windows job's watcher and termination through `lib/job-watcher.ts`, and the helper processes that do so (ported) |
| `lib/job-watcher.ts` | a Windows command's job watched and cleaned up, for `lib/process-tree.ts` alone: each process started outside the job linked to its members, held and adopted as it is linked, and at cleanup the job terminated and each linked process ended and confirmed gone, or named (ADR 0030 decision 3, #531), each periodic snapshot taken on a thread of its own |
| `lib/snapshot-worker.ts` | the worker thread `lib/job-watcher.ts` starts per watcher, which answers each request with a process snapshot over its own kernel32, so a slow snapshot blocks none of gg's clocks (#531 D1 A) |
| `lib/containment.ts` | the Windows job object a shell command, a launched argv or the suite launcher's stage runs in, through `node:ffi`: start, list, name, terminate, confirm empty (ADR 0021) |
| `lib/containment-gate.ts` | the node process a launched argv waits behind on Windows until its job holds it, which then starts the argv with no shell |
| `lib/git.ts` | the one git interface: named verbs over the git CLI returning parsed values, worktrees (ported) |
| `lib/git-default-branch.ts` | the branch a repository's Tickets start from by default, which `gg init` writes as `baseBranch`: origin's HEAD, else the checked-out branch |
| `lib/git-temp-index.ts` | what `lib/git.ts` reads through a copy of the index: a worktree's fingerprint and a rescue's tree |
| `lib/path-entry.ts` | the one PATH-entry lookup, which `argvOf` and the Harness doctors' shell check share: a candidate's own entry, a link not followed, or none when it is missing or cannot be read, so the search goes on to the next |
| `lib/paths.ts` | canonical local paths, the path key every path comparison uses, and the State Database's file in a common dir |
| `lib/github.ts` | gh verbs, and the label writes and the read of the repository's `owner/name` that never throw; a failed gh process is a `GhError` carrying its HTTP status and rate limit (ported) |
| `lib/gh-answer.ts` | gh's JSON answers read field by field into the types `lib/github.ts` declares: a field of the wrong type fails the verb, naming its path (#354) |
| `lib/render.ts` | the template renderer, commit messages, PR body, comments, provenance |
| `lib/public-text.ts` | redaction of the local directories in text gg publishes |
| `lib/templates/` | gg's own templates, which no source declares: the Terminal Reason comment, the Approval Request and cleanup hold comments, the parse-retry nudge, the default recovery section and the hand-off section |
| `lib/work.ts` | `gg work`'s verbs under the ticket lock: `abandon` (the Execution Record forgotten, readable or not, its worktree and branch kept), `done` (a person's end, L12) and `resume`, which gg run calls before admission (the record re-entered at a new Visit, L12, L16, with the tip the person left as its Test Immutability baseline); the rest of `gg work` and the Registry are to come |
| `lib/trace.ts` | **stub** (`export {}`): Trajectory export and `gg trace` |
| `lib/stats.ts` | **stub** (`export {}`): `gg stats` |
| `lib/doctor.ts` | `gg doctor`: the checked configuration printed, each Resolved Flow with its source per Vertex, its warnings (a misfit among them) and errors (each record whose Flow is gone or whose row cannot be read, and an owner/name gh cannot read among them), and the labels the Flows can request that the repository lacks; `gg init`: the example, `test/fixtures/example/`, written into a repository, the user's `gg.json` with the machine settings, and the State Database |
| `lib/plan.ts` | **stub** (`export {}`): `gg plan` |
| `lib/publish.ts` | **stub** (`export {}`): `gg publish` (to be ported) |
| `scripts/run-suite.ts` | the suite launcher Codex may run outside its sandbox (ADR 0010); the full and fast stages' census of what they leave running (`docs/testing.md`) |
| `scripts/record-claude.ts` | the one command that calls the real `claude` (#425): each call `scripts/record-claude-scenarios.ts` lists, run once with the Claude Harness's launch profile in a temporary repository, redacted into `test/fixtures/claude/` with its command, line times and what it left behind; run by hand to re-record a new Claude version, never by a test |
| `scripts/cli-recording.ts` | what a recorder of an Agent CLI does the same way as any other (`scripts/record-claude.ts` today; `scripts/record-codex.ts` once #534 moves it): the names it records and the chain of calls that continue one another, the text a value fills, the environment a nested CLI starts with, the redaction of what it commits, the stand-in API server, the temporary directory, a call's saved files and the files it changed in a worktree (#480) |
| `scripts/record-codex.ts` | the one command that calls the real `codex` (#479): each `codex exec` call `scripts/record-codex-scenarios.ts` lists, under gg's `CODEX_HOME` (`GG_HOME/codex`) in a temporary repository `scripts/record-codex-repository.ts` makes, inside a Windows job (`scripts/record-codex-run.ts`), with the `CODEX_HOME` put back after it (`scripts/record-codex-home.ts`), or under the Codex Harness's own launch, with the model and schema every call runs on (`scripts/record-codex-launch.ts`), the usage limit's against a stand-in Responses API (`scripts/record-codex-stub.ts`), and each free command `scripts/record-codex-commands.ts` lists (version, login, listings, `debug prompt-input`), or, by the name `example` alone, the example's first-visit pass through gg on the Codex Harness (`scripts/record-codex-example.ts`, #482), redacted and trimmed (`scripts/record-codex-redaction.ts`) into `test/fixtures/codex/`; its findings are `docs/research/codex-cli.md`; run by hand to re-record a new Codex version, never by a test |
| `examples/` | each Harness's harness, model and effort for the Agents of the example, which `gg init --harness <name>` writes |

## Misleading areas

- The stubs marked in Layout: `plan`, `publish`, `trace` and `stats` print "not implemented", as do the `gg work` verbs
  other than `abandon`, `done` and `resume`.
- `gg init` writes `test/fixtures/example/`, the example the tests run, so the fixture is shipped content: a change to it
  changes what a new repository gets. `test/fixtures/shipped-flow/` keeps the Flow the defaults shipped until #121 for
  the golden traces; gg ships no Flow now.
- `.agents/feature-flow/` belongs to feature-flow until #97; it is not gg's configuration.
- `git.ts`, `locks.ts` and `lib/state-database/index.ts` also export the functions of their real instance, for callers
  that take no seam (`gg doctor`, `gg init`, `gg work abandon`, `gg ask-session`, contract suites, helper processes);
  `record.ts` and `event-read.ts` re-export its record and Event reads and writes for them. Code on a Run's path uses
  the deps it was passed instead, which `test/unit/state-database.test.ts` holds.

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
