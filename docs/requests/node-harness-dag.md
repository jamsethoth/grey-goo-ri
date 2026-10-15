# Request: a node / harness / DAG framework for ticket-driven agentic development

Date: 2026-10-14. Owner: James Irwin. Status: ready for planning. Supersedes feature-flow (`C:\dev\projects\feature-flow`).

This document is organised by capability. Where it shows config or grammar, the shape is an illustration of what the
capability must support, not a syntax decision. The planning session decides syntax, ticket by ticket.

## 1. Target, in the owner's words

"The workflow is a configurable dag, where each node is a persona definition, a model, an effort, and a set of skills
and mcps and plugins passed to an agentic harness. If we have this core behavior, we can then configure the dag at will
and expand or reduce the scope as necessary for different workflows. The node should be an abstraction, with harness
specific implementation for codex and claude to start."

Also required: usage metrics for every harness, detailed per-node tracing, and a unified end-to-end view of a run.
The existing feature-flow implementation may be thrown away; this is a ground-up rewrite in this repository.

## 2. Non-negotiables

- Zero runtime dependencies, plain Node ESM, Node 20+, native Windows first. Spawn without a shell unless a command
  string is unavoidable, then through the job-object runner.
- Agents never run git write commands or gh. The orchestrator owns commits, pushes, PRs, comments and labels.
- Topology is data. Work is code. No per-node code; a node is only configuration.
- No degraded runs: a node field the harness cannot enforce fails preflight, it is never silently dropped.
- Every agent step is traced with normalised usage. A field a harness cannot produce is declared absent, never zero.
- Wrongly advancing is costlier than wrongly holding. Advance needs evidence.
- GitHub issues are the source of truth for what work exists and what humans decided. The local execution record is
  the source of truth for where the machine was.

## 3. Capabilities

### 3.1 Node

A node is a named, declarative unit of agent work. Fields, all with declared semantics per harness (3.2):

| Field | Meaning |
|---|---|
| `harness` | `claude` or `codex` |
| `model`, `effort` | harness-native strings; shape validated at load, value validated by the CLI; effective value recorded per step |
| `persona` | markdown file name, resolved through the config layers (defaults < user < repo); hashed |
| `skills`, `mcp`, `plugins` | lists applied generically by the harness; no plugin name ever appears in code |
| `mode` | `headless` (default) or `interactive` (the planner) |
| `access`, `network` | permission intents: `read-only` or `workspace-write`; network boolean. Harness translates |
| `gates` | quality gates: named repo commands that must pass before this node's output is accepted (3.6) |
| `resolution` | outcome conflict policy for this node (3.4); shipped default, overridable |
| `contextBudget` | optional; translated to the harness compaction threshold; compaction count logged |
| `timeouts` | optional stall and wall-clock overrides (3.5) |

Nodes live in a shared `nodes` library in the layered config. A vertex in a flow either inlines a definition or
`use`s a library node with field overrides. Provenance, stats and session state key on the vertex id.

Secrets: any `mcp.env` value that is not a `${VAR}` reference fails validation; expansion happens at launch into an
ff-owned temp file.

### 3.2 Harness

One module per CLI exporting the same contract. Tests inject one fake harness object. Names and the capability matrix
are aligned with Archon's provider contract (`packages/provider-contract/src/capabilities.ts`) for comparability.

```
name, capabilities, validate(node), resolveTools(node, ctx), run(call), interactiveArgs(node, opening, opts),
metrics(session), doctor(cfg)
```

Capability matrix, declared per harness and read by the validator and the trace:
`interactive`, `background`, `resume` (and its preconditions, e.g. rollout on disk), `structuredOutput`,
`plugins | mcp | skills: exact | hint | unsupported`, `sandbox: none | codex-windows | codex-posix`,
`peakContext`, `cost`, `turns`, `toolCalls`, `reasoningTokens`, `backgroundWork: reported | none | unobserved`.
Hint fields are logged on the event so eval can tell variants apart.

`run(call)` returns structured output, the session id, normalised usage (cumulative and delta), the transcript path,
exit code, signal, final event subtype, commands-run count, and on failure a typed `failure.class` of
`auth | quota | budget | rate-limited | transient | unknown` with `retryAfterMs`. Retries are decided by class.
Outcomes are classified from the final event, not the exit code.

`doctor` probes behaviour, not help text: CLI versions against pinned minimums, `codex exec resume` support, login,
sandbox lock, labels used by terminals exist, resolved flow printout.

Claude specifics to build in: `--bare --strict-mcp-config`, an ff-owned settings file, explicit `--permission-mode`
and `--permission-prompts none`, `--output-format json` (not stream-json), plugins by `--plugin-dir` with every
installed plugin disabled first, prompts via stdin or file never argv, honour `plugin_errors` and `mcp_server_errors`
in the init event, read-only runs with `--tools Read,Grep,Glob --disallowedTools "mcp__*"` and a background-wait
ceiling, drop `mcp` and declare `skills` hint until filtering exists, `--system-prompt-snapshot` recorded on resume,
spawn the JS entry under `process.execPath` (no `.cmd` shim, no shell).

Codex specifics: every harness-owned key as a `-c` override (CLI overrides rank above project and user config),
`--sandbox` and `-C` before `resume`, sandbox policy re-checked from the rollout on resume, strict output schemas
plus ff-side validation of every output (schema is not enforced when MCP tools are active), `features.hooks` explicit,
`commandWindows` required for any hook on win32, MXC fallback to unelevated only on an mxc error, usage delta from the
cumulative `turn.completed`, rollout lookup by session id across the sessions tree, `skills` declared hint until
verified, tail `$CODEX_HOME/logs` on non-zero exit, assert at least one command ran when the brief expects edits.

Plugin hook injection (Codex without hooks): `harnesses.codex.injectHooks` lists plugin names; a generic hook runner
reads the plugin's hook manifest, runs its session-start command through the shell runner, and injects the output.

### 3.3 Workflow definition

A flow is a graph over persona vertices plus two deterministic kinds and built-in terminals.

- Persona vertex: a node (3.1) plus a `procedure` with options (3.4) plus edges.
- `gate` vertex: runs a named repo command, must declare both pass and fail targets.
- `approval` vertex: records a pending state in the execution record, sets a label, ends the run; the next run
  continues at its `then` once a human has approved.
- Terminals: `done` (PR ready, label), `needs-human`, `replan` (label needs-replan, diagnosis posted on ticket and
  epic).
- Edges: `then: <vertex>` or `route: { <outcome>: <vertex | {to, max, exhausted}> }`. Every back edge has `max` and
  `exhausted`. Every vertex has `maxVisits`; every ticket has a step cap. Loops exist only as bounded back edges.
- Per-ticket graphs are sequential. Parallelism is across tickets only.
- Two sections: `plan` (epic level, used by `gg plan`) and `ticket` (used by `gg run`). The planner is never a ticket
  vertex. The small flow sets `plan` to null.

Illustration only (shape, not syntax):

```
implementer(tdd) -> reviewer(review)
reviewer: PASS -> done, CHANGES -> {to: implementer, max: 2, exhausted: senior-dev}, REPEAT -> senior-dev
senior-dev(fix, maxVisits 1, exhausted needs-human) -> reviewer
```

Flows live inside the layered config as a `flows` map, selected by `--flow <name>` or a `flow` default key
(`--flow` > repo > user > `default`). Layering: maps merge key by key, arrays replace whole, null deletes, validation
runs after the merge and names the layer file that broke it. Every run writes the fully resolved flow (after layering
and `use` expansion) to the run directory and hashes that file.

Validation before any ticket starts: unknown nodes or harnesses; unreachable vertices; back edges without bounds;
`then` and `route` both set; route keys not in the procedure's outcome enum; enum values with no route and no built-in
default; gate without both targets; gate commands not declared; resume across different vertices, harnesses or persona
hashes; listed fields the harness cannot enforce; strict-schema lint for Codex nodes; literal secrets in `mcp.env`;
retries on a node whose harness options disable session persistence; terminal labels missing in the repo; a warning
when reviewer and implementer share a model.

### 3.4 Procedures, outcomes and resolution

Procedures are code: named action sequences the interpreter expands into action steps.

- `tdd`: red brief, red gate (expected fail, verified), commit tests, green brief in a fresh session with the full
  context (ticket, branch, commands, rules, committed test list, failing output), persona gates, commit, push, draft
  PR. Options: `stillGreen` and `testFix` retry counts (default 1), `resumeGreen` (default false). Still-green
  resumes red; test-fix resumes green. Splitting red and green onto different vertices is deferred; it is a procedure
  split, not a grammar change.
- `fix`: fix brief with history, gates, commit, push.
- `review`: read-only call, worktree-unchanged assertion, PR comment, findings hash.
- `plan`: interactive launch; exit is `gg publish`.

Each procedure declares an outcome enum. Outcomes are read from one dedicated field of the structured output, which
must hold exactly one enum token. There is no free-text marker fallback: a missing or invalid field is a parse failure
with its own retry counter. Illustrative enums: `tdd` ok | blocked | misscoped | red-failed | gate-failed(<gate>);
`fix` ok | blocked | misscoped | gate-failed(<gate>); `review` PASS | CHANGES | REPEAT | misscoped. Built-in defaults:
blocked posts a note and goes to needs-human; misscoped goes to replan; thrown errors go to needs-human with the error
on the ticket end event.

Resolution policy. Outcomes have a direction: advance (ok, PASS), retry (gate-failed, still-green, test-fix, parse
failure, timeout, transient), stop (blocked, misscoped, exhausted). A step can receive signals from the agent's claim
and from deterministic checks. The policy is a node field with a shipped default, never a constant in code:

1. Advance requires every deterministic check to agree and no stop signal.
2. On conflict, a stop signal beats retry.
3. Within a direction, the least long-term impact wins: retry in place before discard and retry; escalate before
   needs-human; replan on misscoped.
4. Review PASS requires evidence: no blocker or major findings, definition of done met, gates green. A repeated
   findings hash routes REPEAT instead of looping.

Assumption to confirm at planning: integrity violations (3.6) sit outside the policy and always stop.

### 3.5 Execution record and work management

One persisted record per work item (ticket) under the repo's feature folder in the git common dir, written after
every action step: flow name and config hash, graph position, visit counts per vertex and edge, session id per vertex
visit (first non-resume id only), last cumulative usage per session, red evidence, PR number, pending state, schema
version. Plain JSON a human can read.

Reconciliation at resume: labels decide whether a ticket runs, the record decides where it continues. Label says
needs-human and record says mid-step: label wins, record marked abandoned. Label in-progress with no record: stuck,
reset path. A lost record costs a restart from red, never human state.

Human recovery, `gg work`: list (every repo in the user-dir registry), resume, abandon (keep worktree, forget
position), reset (today's retry-stuck: discard worktree and branches, clear labels, refuse if a published PR exists),
approve. Doctor validates records and reports disagreement with GitHub. Single machine; the user dir holds only a
registry of repo paths appended on each run.

Robustness in v1: stall timeout (transcript stops growing, default about 10 min) and wall clock per agent step
(default about 60 min), per node overridable, expiry kills the process tree through the job object and records a typed
timeout outcome; idempotent GitHub writes keyed on (ticket, vertex, attempt): PR found by head branch before create,
one marked comment updated in place, label adds tolerate presence; per-ticket lock file with pid and stale takeover;
one in-process mutex around every orchestrator git write with retry on index lock; never delete a dirty worktree;
discard uncommitted changes at ticket start unless the record says the state is known.

### 3.6 Deterministic proof

- Red gate: accepted only when the runner exited non-zero on its own (not timeout, not 127) and the output names at
  least one test the agent reported. One still-green retry resuming red, then the gate again. Red evidence captured
  once after the test commit and reused in every PR body.
- Persona gates: `gates` on the node name repo commands (test, lint, format, coverage). Pass or fail by exit code in
  v1; thresholds come from the tool's own flags. Output captured, fed back on the bounded retry, recorded as its own
  event. Gate results go into the reviewer's brief.
- Test tamper check: diff of test paths between the red commit and the green or fix tree must be empty; a violation is
  an integrity stop, not a test-fix.
- Git ownership: after every agent step, HEAD, index and tree of the agent's worktree and of every other active
  worktree are asserted unchanged by the agent. A change is discarded and stops the ticket.
- Protected files: agent diffs touching `.claude/`, `.codex/`, `.mcp.json` or `AGENTS.md` are rejected.
- Agents get read-only git (diff, log, status, show) and no movement commands (checkout, switch, worktree, stash,
  reset, add, commit, push, remote, gh). Confinement: Codex sandbox, Claude edit scope with prompts off, and the
  all-worktrees assertion. Agents are never told the worktree root.
- Declared commands are passed in the brief, not assumed read from AGENTS.md.

### 3.7 Tracing, metrics and export

Events, schema 2, one per action step attempt, in the repo's append-only events file: flow name, config hash, ticket,
vertex, procedure, phase, attempt, duration, outcome, direction, signals received. Agent steps add: harness and CLI
version, model and effective effort, persona hash, resolved tools and hint fields, session id, transcript path, usage
cumulative and delta (input, cached, cache-write, output, reasoning where available), estimated cost delta, peak
context (max over per-step input plus cache tokens), turns, tool calls, compactions, exit code, signal, final event
subtype, commands run, failure class. Deterministic steps record events too. Old schema 1 events are still read by
stats. Stats key on procedure and phase, never on vertex id; `rounds`, `red_failed` and `blocked` remain derivable.
Commit trailer text `Feature-Flow-Stage:` is kept with vertex and harness content.

Config hash = resolved flow + persona hashes + harness settings + declared commands. Written with the resolved flow
to the run directory.

Export: Agent Trajectory Interchange Format (ATIF, Harbor), pinned schema version. One parent trajectory per ticket
run whose steps are the action steps, deterministic steps with `llm_call_count: 0`; each agent step's native transcript
(Claude JSONL, Codex rollout) converted to a subagent trajectory, embedded or referenced by file; vertex, procedure,
phase and attempt in `extra`; per-step `metrics` and root `final_metrics` from the normalised usage. `gg trace <epic>
[ticket]` prints the timeline from it; Harbor's viewer or Phoenix render it graphically. ff events remain the index.

### 3.8 Planning and replanning

The planner is a node with `mode: interactive`, run at epic level by `gg plan`, with the context-budget stop hook and
background sessions ported. `misscoped` from any ticket vertex lands in the replan terminal; `gg plan --replan <epic>`
resumes planning with the collected diagnoses. Publish keeps its planning-session guard for flows with a plan section.

### 3.9 Config and migration

Three layers, defaults < user < repo, same merge rules as flows. The four stage keys, `stageTools`, `toolkit`,
`escalationEnabled`, `maxReviewRounds` and `contextBudget.<stage>` are gone; a loud load error prints a migration table
naming the replacement (`nodes`, `harnesses`, `flows`), not just a key. Keys that stay: `planApproval`, `maxParallel`,
`stuckAfterHours`, `baseBranch`, `worktreeRoot`, `allowNetwork`, `style`, `apiPrices`, `contextBudget.byModel`. Eval
variants are config layers and may change flow structure.

## 4. Hard-won behaviours to port

From feature-flow at 89e1d67; see `C:\dev\ff-review-work\design-vetting-code.md` section 1 for line references.

- Red gate acceptance rules, single still-green retry, red evidence captured once, failed red discards the worktree
  and records the reason into history, "No tests were written" as a distinct failure.
- Resume rules: still-green resumes red, test-fix resumes whatever produced the code, fix never resumes; history goes
  to red and fix briefs only.
- Blocked short-circuits to a ticket comment and needs-human.
- Review is read-only with the before and after HEAD and dirty comparison; order after review: event, PR comment, PR
  body re-render with provenance, then ready and labels.
- Draft PR upserted after every green commit and push; escalation diagnosis comment when non-empty; provenance table
  with persona hash; commit trailer parsed by outcome refresh.
- Labels never throw: logged, event, exit code 1; exit 2 on any needs-human. `in-progress` added only after the
  worktree exists.
- Stuck detection from label age; reset refuses when a published PR exists and closes every draft; cleanup keeps dirty
  or unpushed worktrees.
- Worktree add serialised, ownership validated, branch reused on title change; push without `-u`.
- Codex: sandbox and `-C` before resume, sandbox re-check from the rollout, thread id fallback, usage delta, MXC
  fallback, node_repl lock warning, persona on first prompt only, strict schemas, allowlists as inline tables, listing
  failures throw, cost from `apiPrices` or null.
- Claude: user settings skipped, all plugins off then the node's back by directory, allow and deny lists with
  prefixed twins, `is_error` or missing structured output throws, input token accounting, missing plugin fails before
  spawn.
- Preflight resolves tools for every active vertex before any gh call or worktree, all failures in one error; plan
  approval gate; pool with `maxParallel`; per-epic log and usage file; run start and end events.
- Process containment: job object via winjob.ps1 for shell runs, timeout kills orphans, fallback chain and survivor
  reporting; test gate 30 minutes.
- Planning: interactive launch with session id and stop-hook budget warning, background sessions, plan marker,
  `--finish`, transcript metrics.

## 5. Tests to port

Port `test/exec.test.mjs` (18) and `test/publish.test.mjs` (7) unchanged. Port `test/retry-e2e.test.mjs` (7) and
`test/stuck.test.mjs` to inject the fake harness instead of `deps.invoke`; they are the golden-trace seeds: real bare
origin, fake gh spread over the real module, fake harness that writes files into cwd. From `test/core.test.mjs` port
the behaviours listed in `design-vetting-code.md` section 6 (round bounds, Codex usage and pricing, toolkit isolation,
missing plugin, replaced keys, commit and discard, worktree guards, diff stats and metrics, read-only trust, option
parsing, pool, red check, plans folder, preflight ordering, doctor rows); skip the four shape-specific ones.

Golden trace test, definition of done for the interpreter: with the fake harness, assert the exact action-step
sequence and events for first-round pass, a CHANGES round, a failed red, an escalation, a persona gate failure, a
blocked claim with passing tests, and kill after step N then resume at N plus one.

Fake harness needs: scripted responses keyed by (vertex, phase, attempt), optional file writes into cwd, a session id
per call, recorded `write` and `resume` arguments, usage with nulls for declared-absent capabilities, a way to throw
with a failure class, and a capability matrix the validator reads.

## 6. Delivery

- This repository, binary `gg`, own `test` command, so the installed `ff` runs the tickets from a separate checkout.
- Slice order: (1) harness interface, fake harness, event schema 2, execution record, interpreter with `tdd` and
  `review` on ported git, gh and exec verbs, golden trace test. (2) Claude harness. (3) Codex harness with sandbox and
  resume quirks. (4) `fix`, bounds, escalation, resolution policy, persona gates. (5) Flows in config, `--flow`,
  layering, migration errors. (6) Trace, stats, ATIF export, `gg work`. (7) Planning, publish, replan.
- Parallel-safe once the interface is frozen: the two harness modules, flow loader and validator, trace renderer,
  migration table, git/gh/exec ports.
- Planner guidance: small tickets per file area; one interpreter-touching ticket in flight at a time; the golden
  trace test is the definition of done for anything the interpreter touches; reinstall nothing until cutover.
- Cutover: once `gg` runs its own tickets, archive feature-flow.

## 7. Deferred

Journal-driven replay beyond resume; node-level brief files; red and green on separate vertices; parallel branches
and fan-out inside a ticket; non-GitHub ticket sources; multi-machine work management; output parsers for gate
metrics (coverage numbers); Claude MCP and skill filtering (becomes exact when the CLI supports it).

## 8. In-flight work in feature-flow

PR 64 merge then stop; PR 65 discard; PR 66 keep as record. Tickets 33, 35, 36, 37 paused, their facts move into the
harness modules. Ticket 46 (single ticket run) and 47 (approval) are covered here. 48 reshaped (guard only for flows
with a plan section). 45 and 49 reshaped around flows instead of sizes. 50 stays. Epic 1 done.

## 9. References

- `C:\dev\ff-state-review-2026-10-14.md`: scorecard, 47 findings, research grounding.
- `C:\dev\ff-review-work\design-vetting-code.md` and `design-vetting-discourse.md`: findings this document folds in.
- `C:\dev\ff-review-work\frameworks.md`: 23 candidates scored; build, do not adopt.
- ATIF: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
- Archon provider contract: `packages/provider-contract/src/capabilities.ts`
