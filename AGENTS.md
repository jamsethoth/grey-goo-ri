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
  names its source lines; "port unchanged" without a source is not a complete ticket.

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
- Comments only for the non-obvious why.

## Layout

| Module | Responsibility |
| --- | --- |
| `bin/gg.mjs` | `gg` entry point: usage and command dispatch |
| `lib/opts.mjs` | option parsing |
| `lib/config.mjs` | Layers, merge, migration table, Config Hash, Persona and Declared Command loading |
| `lib/flow.mjs` | Flow loading, Agent Library expansion, validation, Resolved Flow |
| `lib/run.mjs` | `gg run` admission, preflight, pool, run directory, Lifecycle Events, exit codes |
| `lib/interpreter.mjs` | Visits, Actions, Attempts, Edge routing, Bounds, Action Cap |
| `lib/effects.mjs` | write-ahead side effects, the activity bracket, remote retries and backoff, the repo-lock guard |
| `lib/terminal.mjs` | Terminals: hold, abandonment, fault, run-stopped and their reports, Terminal Reason texts |
| `lib/procedures.mjs` | tdd, fix, review, plan as data (Actions, declared Checks, options, Outcome enum) |
| `lib/briefs.mjs` | Brief builders, Structured Response schemas and validation |
| `lib/outcome.mjs` | the transition table and Resolution Policy |
| `lib/checks.mjs` | Red Check, Green Check, Test Immutability, Findings Hash, review-pass |
| `lib/integrity.mjs` | Integrity Assertions (worktree snapshots, busy flag, generation, Protected Files) |
| `lib/record.mjs` | Execution Record, Epic Record and Pinned Configuration persistence in the State Database, and the write-ahead log |
| `lib/marker.mjs` | Action Marker format and parse |
| `lib/reconcile.mjs` | Reconciliation of a record against git and GitHub at resume |
| `lib/events.mjs` | event schema 2 append and read from the State Database |
| `lib/labels.mjs` | State, Await and Decide Label names and prefix |
| `lib/approval.mjs` | Pending Instance, Approval Digest, timeline read, consumption |
| `lib/locks.mjs` | ticket, epic and repo locks as `node:sqlite` exclusive transactions |
| `lib/harnesses/contract.mjs` | the Harness contract check and shared Usage shape |
| `lib/harnesses/claude.mjs` | the Claude Code Harness |
| `lib/harnesses/codex.mjs` | the Codex Harness |
| `lib/exec.mjs` | process spawn and job-object runner (ported) |
| `lib/git.mjs` | the one git interface: named verbs over the git CLI returning parsed values, worktrees (ported) |
| `lib/paths.mjs` | canonical local paths and the path key every path comparison uses |
| `lib/github.mjs` | gh verbs and label writes that never throw (ported) |
| `lib/render.mjs` | commit messages, PR body, comments, provenance, ticket and epic bodies |
| `lib/work.mjs` | `gg work` and the Registry |
| `lib/trace.mjs` | Trajectory export and `gg trace` |
| `lib/stats.mjs` | `gg stats` |
| `lib/doctor.mjs` | `gg doctor` and `gg init` |
| `lib/plan.mjs` | `gg plan` |
| `lib/publish.mjs` | `gg publish` (ported) |
| `scripts/run-suite.mjs` | the suite launcher Codex may run outside its sandbox (ADR 0010) |
| `examples/` | user Layers to copy: a Claude and a Codex harness choice for the shipped Agents |

## Tests

Test design (rules, doubles, sizes, layout and stages) follows `docs/testing.md`; the conventions below cover files.

- One `test/<module>.test.mjs` per module. A large module may also have area files `test/<module>.<area>.test.mjs`;
  new tests for it still go in `test/<module>.test.mjs`. node runs files in parallel but a file's tests serially, so
  once a file's serial time passes about 3 minutes, move tests out of it to an area file.
- Tests import modules as namespaces (`import * as record from '../lib/record.mjs'`) and call `record.fn()`, so a
  missing export fails inside the case.
- A test for a module that does not exist yet uses `await import()` inside the case.
- Ported test files keep their case names and assertions but rewrite static named imports to namespace imports.
- A fake's contract suite lives under `test/contract/<boundary>/` and runs its cases against the real module and the fake;
  `lib/git.mjs`'s is `test/contract/git/`.
- Fixtures live under `test/fixtures/` as JSON or text.
- Shared helpers live under `test/support/`; the runner lists them as passing empty files.
- Spawn `process.execPath` directly, never a shell.

## Commands

- test: `node scripts/run-suite.mjs` (`npm test` is the same)

gg reads Declared Commands from `.agents/gg/gg.json` (ADR 0013). This section stays, equal to it, for feature-flow
until the cutover (grey-goo-ri issue #97).
