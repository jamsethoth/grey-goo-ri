# Request: a node / harness / workflow-graph framework for ticket-driven agentic development

Date: 2026-10-14, revised 2026-10-15 after an adversarial review. Owner: James Irwin. Status: ready for planning.
Supersedes feature-flow (`C:\dev\projects\feature-flow`, main at 89e1d67). The new tool is `gg`.

This document is organised by capability. Where it shows config or grammar, the shape is an illustration of what the
capability must support, not a syntax decision. The planning session decides syntax, ticket by ticket. The authored
graph is a bounded workflow graph: it has back edges, every one of them bounded. "DAG" in older notes means this.

## 1. Target, in the owner's words

"The workflow is a configurable dag, where each node is a persona definition, a model, an effort, and a set of skills
and mcps and plugins passed to an agentic harness. If we have this core behavior, we can then configure the dag at will
and expand or reduce the scope as necessary for different workflows. The node should be an abstraction, with harness
specific implementation for codex and claude to start."

Also required: usage metrics for every harness, detailed per-vertex tracing, a unified end-to-end view of a run, and
management of the work submitted to a workflow across all its instances on one machine. The existing feature-flow
implementation is thrown away; this is a ground-up rewrite in this repository.

## 2. Non-negotiables

- Plain Node ESM, Node 22+ (22.13 or later), native Windows first, nothing to install beyond Node and the harness
  CLIs; npm dependencies are allowed when they earn their place, node built-ins preferred. Spawn executables without
  a shell;
  a command string that cannot be avoided goes through the job-object runner.
- Agents never run git write commands or gh. The orchestrator owns commits, pushes, PRs, comments and labels.
- Topology is data. Work is code. No per-node code; a node is only configuration.
- A session starts empty. The shipped defaults add no skills, plugins, MCP servers, hooks or repository instructions
  to any session. Everything an agent gets is declared in config. Ponytail and every other plugin are user or repo
  config, never framework.
- No degraded runs: a node field its harness declares unsupported fails preflight; a field declared hint runs with
  its declared semantics and is recorded as hinted; a permission intent must be enforceable on every surface the
  node uses or preflight fails. Nothing is silently dropped.
- Every agent action is traced with normalised usage. A field a harness cannot produce is declared absent, never zero.
- Wrongly advancing is costlier than wrongly holding. Advance needs evidence. Which checks a procedure declares is
  configuration, visible in validation output; that advance never happens while a declared check is failing, and
  that integrity violations stop, is not. The ordering among legitimate outcomes is per-node configuration.
- GitHub issues are the source of truth for what work exists and what humans decided. The local execution record is
  the source of truth for where the machine was. Human decisions are read only from records GitHub cannot edit.

## 3. Capabilities

### 3.1 Node

A node is a named, declarative unit of agent work. Fields, all with declared semantics per harness (3.2):

| Field | Meaning |
|---|---|
| `harness` | `claude` or `codex` |
| `model`, `effort` | harness-native strings; shape validated at load, value validated by the CLI; effective value recorded per action |
| `persona` | markdown file name, resolved through the config layers (defaults < user < repo); hashed |
| `skills`, `mcp`, `plugins` | lists applied generically by the harness; no plugin name appears in code; default empty |
| `mode` | `headless` (default) or `interactive` (the planner) |
| `access`, `network` | permission intents: `read-only` or `workspace-write`; network boolean. Harness translates per surface |
| `gates` | quality gates: named repo commands that must pass before this node's output is accepted (3.6) |
| `resolution` | ordering policy among legitimate outcomes (3.4); shipped default, overridable |
| `contextBudget` | optional; translated to the harness compaction threshold; compaction count logged |
| `timeouts` | optional stall and wall-clock overrides (3.5) |

Nodes live in a shared `nodes` library in the layered config. A vertex in a flow either inlines a definition or
`use`s a library node with field overrides. Provenance, stats, session state and the trace key on the vertex id and
visit number.

Secrets: any `mcp.env` value that is not a `${VAR}` reference fails validation. Expansion happens at launch into a
gg-owned temp file that is deleted after the action. Expanded values never reach the execution record, events, the
resolved-config snapshot, the trace export or any diagnostic gg retains (log tails, error excerpts); gg knows every
value it expanded and redacts them from anything it derives from a transcript. The one raw artefact gg does not own
is the CLI's own transcript on disk, which stays where the CLI wrote it under the owner's home directory; gg stores
its path and never copies it. A test injects a sentinel credential through an MCP response and asserts it appears
in no gg-written artefact.

### 3.2 Harness

One module per CLI exporting the same contract. Tests inject one fake harness object. Field names and the capability
matrix follow Archon's provider contract for comparability
(https://github.com/coleam00/Archon/blob/main/packages/provider-contract/src/capabilities.ts); module layout is
guidance, not a requirement.

```
name, capabilities, validate(node), resolveTools(node, ctx), run(call), interactiveArgs(node, opening, opts),
metrics(session), doctor(cfg)
```

Capability semantics, per field per harness: `exact` means the harness enforces the field; `hint` means the field
is passed as prompt text or a best-effort setting and the action is logged as hinted so eval can tell variants apart;
`unsupported` means a node that lists the field fails preflight. A harness declares one of the three for `skills`,
`mcp`, `plugins`, `access`, `network`, `contextBudget`. Current declarations: Claude `plugins` exact, `mcp`
unsupported (until filtering lands), `skills` hint; Codex `plugins` exact, `mcp` exact for config servers, `skills`
hint until verified per installed version. The matrix also declares `interactive`, `background`, `resume` with its
preconditions, `structuredOutput`, `sandbox: none | codex-windows | codex-posix`, `peakContext`, `cost`, `turns`,
`toolCalls`, `reasoningTokens`, `backgroundWork: reported | none | unobserved`.

Permission intents are enforced per surface, and the harness states which surface each mechanism covers: shell
commands, built-in file tools, MCP tools, plugins and hooks, network. A combination the harness cannot enforce on
every surface the node uses fails preflight; for example a Claude read-only node that lists MCP servers, or a Codex
node with `network: false` and an MCP server that reaches the network. On native Windows Claude has no command
sandbox. A Claude `workspace-write` node therefore runs in a declared trusted-command mode, which the matrix names
as `confinement: trusted-commands` rather than a sandbox: only the repo's declared commands and gg's allow list may
run, git write and gh commands are denied, network tools are denied unless the node allows network, and the
post-action assertions in 3.6 detect changes to the checked surfaces only. A command that writes outside the checked
worktrees or reaches the network through its own means is neither prevented nor observed in this mode. The owner
accepts this knowingly; the mode is recorded on every event and in the config hash, and it is never described as
equivalent to a sandbox.

`run(call)` returns three separate things, never conflated: the agent's structured response (unvalidated; its claim
is one field of it),
the harness result (`completed | failed | timed-out | killed`, session id, normalised usage cumulative and delta,
transcript path, exit code, signal, final event subtype, init metadata, permission denials, commands-run count as
diagnostics only), and for `failed` a typed `failure.class` of `auth | quota | budget | rate-limited | transient |
unknown` with `retryAfterMs`. A harness never throws for an expected failure; a throw is an unexpected fault (3.4).
The orchestrator validates the claim against the schema regardless of harness and derives the outcome from the
transition table in 3.4. Outcomes are classified from the final event, not the exit code. A reported case where
Codex did not enforce the schema with MCP tools active is kept as a versioned regression fixture, not a rule.

`doctor` probes behaviour, not help text: CLI versions against pinned minimums, `codex exec resume` with
`--output-schema`, login state, sandbox lock, labels the resolved flow references, the Claude launch profile below,
and a `--bare` probe with `CLAUDE_CODE_OAUTH_TOKEN` so the switch to bare mode happens the day it works on a
subscription. The launch profile in use is part of the config hash.

Claude launch profile, validated on 2026-10-15 against claude 2.1.300 on this machine with a subscription login:

- `--setting-sources ""` so no user, project or local settings file is read: no hooks, no installed plugins, no
  `enabledPlugins`. `--strict-mcp-config` with gg's own `--mcp-config` or none. A gg-owned `--settings` file for
  permissions and gg hooks (the context-budget hook). `--plugin-dir` per listed plugin. Environment
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Verified: the init event listed only
  built-in plugins, a project `.claude/skills` entry was absent, and a CLAUDE.md instruction was not followed.
- Read-only actions add `--restricted`, which confines file tools to the working directory and removes Bash and
  WebFetch, plus `--disallowedTools "mcp__*"` unless the node lists MCP. The review brief carries the diff text, so
  the reviewer needs no shell. Verified: `--restricted -p` authenticates with the subscription.
- Explicit `--permission-mode` and `--permission-prompts none`. `--system-prompt-snapshot off` on every call, with
  the persona supplied from the visit's pinned snapshot (3.5), written to a file in the run directory, never from
  the live layer directories. A resumed call therefore sees exactly the persona the visit entered with, the hash
  recorded per action is the one the model ran, and a persona edit takes effect at the next vertex entry.
- `--output-format stream-json --verbose`. The init event (first line) supplies `plugins`, `plugin_errors`,
  `mcp_servers`, `mcp_server_errors` and `capabilities`; a non-empty error array or a listed server not connected
  fails the action. The result event (last line) supplies usage, cost, turns, `structured_output`,
  `permission_denials`. Stream liveness feeds the stall timeout. Verified with `--json-schema` on a fresh session and
  on `--resume`. Fallback if the stream misbehaves on a future version: `--output-format json --verbose`, which
  returns the same events as one array; observed, not documented.
- Spawn the resolved `claude` executable directly, no shell. On this machine it is a native `.exe`; a `.cmd` shim is
  resolved to its target first. Prompts go through stdin or a file, never argv. Paths with spaces are tested.
- `--bare` is not used: it refuses subscription credentials ("Not logged in", verified), and reporters say the OAuth
  environment token is ignored under it as well. Bare mode also removes `.claude/skills`, `.claude/commands` and
  `.claude/agents` discovery, which the profile above does not promise to remove. The probe in section 9 saw a
  project skill absent under the profile, so this content is treated as potentially discoverable rather than as
  declared: gg does not rely on it being loaded or unloaded, its digest is recorded on every attempt so two runs that
  differ only in repository `.claude` content are distinguishable, the launcher acceptance test records whether the
  installed version exposed it, and the protected-files check in 3.6 stops an agent from changing it. This content
  is live, not pinned: a human may change it mid-visit, so every agent-action event records its current digest
  separately from the pinned config hash, and a test edits it between two calls of one visit and asserts both
  digests appear. This is the one stated exception to "sessions start empty".
- Cost and usage on `--resume` are the session's cumulative totals; gg stores the previous totals per session and
  logs the delta. The session id from the first non-resume call of each session is the one persisted; a resumed
  call's init id is never stored.

Codex specifics: every harness-owned key as a `-c` override, since CLI overrides rank above project and user config;
`--sandbox` and `-C` before `resume`; sandbox policy re-checked from the rollout on resume; strict output schemas;
`features.hooks` explicit; `commandWindows` required for any hook on win32; MXC fallback to unelevated only on an mxc
error and only with equivalent isolation declared; usage delta from the cumulative `turn.completed`; rollout lookup by
session id across the sessions tree; tail `$CODEX_HOME/logs` on non-zero exit; verify expected filesystem changes and
checks rather than command counts. Installed: codex-cli 0.162.1, which accepts `exec resume --output-schema`.

Plugin hook injection (Codex without hooks): `harnesses.codex.injectHooks` lists plugin names; a generic hook runner
reads the plugin's hook manifest, runs its session-start command through the shell runner, and injects the output.

### 3.3 Workflow definition

A flow is a graph over persona vertices plus two deterministic kinds and built-in terminals.

- Persona vertex: a node (3.1) plus a `procedure` with options (3.4) plus edges.
- `gate` vertex: runs a named repo command, must declare both pass and fail targets.
- `approval` vertex: pauses for a human decision through GitHub labels (3.5). It declares its await label and a
  map of decide labels to outcomes; `approved` and `rejected` are the shipped default, a vertex may declare more.
- Terminals: `done` (PR marked ready, state label), `needs-human`, `replan` (state label, diagnosis posted on the
  ticket and the epic). `done` requires an open PR for the ticket; a flow that routes to `done` without a vertex that
  creates one fails validation.
- Every Terminal carries a Terminal Reason, `done` included: `decidedBy` (the Vertex, Visit, Phase and ordinal of
  the Action whose Outcome took the Edge, or `{ hold: <name> }` when the Execution stopped before any Action, such as
  `dirty-worktree`), `outcome` and `rule` from that Action (null for a hold), and `text`, one sentence for a human
  saying why it succeeded or stopped. It is stored in the Execution Record beside the state, is the `reason` of the
  ticket end event, and its text and Action Marker are posted on the ticket with the Terminal's label change, through
  the write-ahead log (the blocked comment carries it rather than a second comment). It points to the deciding
  Action's event for the full Signals rather than copying them.
- Edges: `then: <vertex>` or `route: { <outcome>: <vertex | {to, max, exhausted}> }`. Every back edge has `max` and
  `exhausted`. Every vertex has `maxVisits` with its own `exhausted`; every ticket has a action cap. Loops exist only
  as bounded back edges.
- Counting semantics, so tests are deterministic: an edge `max` counts traversals of that edge per ticket; a vertex
  `maxVisits` counts entries per ticket; procedure-internal retries (still-green, test-fix, quality gate retries) count
  toward the ticket action cap but not toward edge or vertex counts; when an edge and a vertex exhaust on the same
  action the vertex `exhausted` wins; the ticket action cap exhausting goes to needs-human and wins over both; counts
  survive a restart because they live in the execution record and are checked before the action runs, so a restart at
  a boundary routes the same way. Repeat detection for `REPEAT` compares the findings hash with earlier reviews by
  the same reviewer vertex within the same execution only. One worked example with nested retries, a cap boundary
  and a restart ships with the validator tests.
- Per-ticket graphs are sequential. Parallelism is across tickets only.
- Two sections: `plan` (epic level, used by `gg plan`) and `ticket` (used by `gg run`). The planner is never a ticket
  vertex. The small flow sets `plan` to null.
- Entry cases: `gg run <epic>` runs every ready ticket of the epic under the epic's plan approval; `gg run <ticket>`
  runs one ticket under the repo's default flow or `--flow`. A ticket inside an epic inherits the epic's plan
  approval. A standalone ticket under a flow whose `plan` section is non-null is rejected before any effect, with
  the message naming a flow that sets `plan` to null. Readiness requires every blocking issue closed, as today.
  Epic-level state, including a pending plan approval, lives in an epic record under the same records directory
  (3.5), and executions reference it by epic number.

Illustration only (shape, not syntax):

```
implementer(tdd) -> reviewer(review)
reviewer: PASS -> done, CHANGES -> {to: implementer-fix, max: 2, exhausted: senior-dev}, REPEAT -> senior-dev
implementer-fix = use implementer, procedure fix -> reviewer
senior-dev(fix, maxVisits 1, exhausted needs-human) -> reviewer
```

Flows live inside the layered config as a `flows` map, selected by `--flow <name>` or a `flow` default key
(`--flow` > repo > user > `default`). Layering: maps merge key by key, arrays replace whole, null deletes, validation
runs after the merge and names the layer file that broke it. Every run writes the fully resolved flow (after layering
and `use` expansion) to the run directory and hashes that file.

Validation before any ticket starts: unknown nodes or harnesses; unreachable vertices; back edges without bounds;
`then` and `route` both set; route keys not in the procedure's outcome enum; enum values with no route and no built-in
default; gate without both targets; gate commands not declared; approval decisions without a route; resume across
different vertices or harnesses; listed fields the harness declares unsupported; permission intents the harness
cannot enforce on every surface the node uses; strict-schema lint for Codex nodes; literal secrets in `mcp.env`;
retries on a node whose harness options disable session persistence; labels the flow references missing in the
repo; `done` reachable without a PR-creating vertex; a warning when reviewer and implementer share a model.

### 3.4 Procedures, outcomes and resolution

Procedures are code: named action sequences the interpreter expands into actions.

- `tdd`: red brief, red check (expected fail, verified), commit tests, green brief in a fresh session with the full
  context (ticket, branch, commands, rules, committed test list, failing output), green check (the declared test
  command must pass), quality gates, commit, push, draft PR. Options: `stillGreen` and `testFix` retry counts
  (default 1), `resumeGreen` (default false), `requireTestPass` (default true; turning it off is allowed, raises a
  loud validation warning, and is recorded on every event so eval can see which variant ran). Still-green resumes
  the red session; test-fix resumes the green session. A `tdd` vertex is entered once per ticket; later rounds enter
  a `fix` vertex, as the illustration shows. Splitting red and green onto different vertices is deferred and is a
  procedure split, not a grammar change.
- `fix`: fix brief with history and the review findings, green check under the same option, quality gates, commit,
  push. A fix visit may change tests when a finding names a test; the immutability baseline then moves to the fix commit
  and the reviewer brief lists every test file changed since the red commit.
- `review`: read-only call with the diff in the brief, worktree-unchanged assertion, PR comment, findings hash
  computed over normalised findings (file, severity, issue text with whitespace and line numbers stripped).
- `plan`: interactive launch; exit is `gg publish`.

Procedures declare their checks as data: the checks they require, the options that may relax them, and their outcome
enum. Validation prints the effective check list per vertex, so nothing a procedure verifies is hidden in code.

Three layers that never mix: the agent's claim (one dedicated structured-output field holding exactly one enum
token, no free-text marker fallback), the harness result (completed, failed with class, timed out, killed), and the
orchestrator's deterministic checks (red and green checks, quality gates, integrity assertions, findings hash). Integrity assertions (3.6) run
after every terminated attempt, whatever the harness result, before the table is consulted; a violation takes the
integrity row even when the attempt timed out or returned nothing, so a prohibited change never survives into a
retry. Checks other than integrity run only on a completed attempt with a valid claim. One transition table, obeyed by every harness and
procedure, derives the outcome. It lives in exactly one interpreter module that takes the harness result, the
validated claim, the check results and the node's `resolution` policy and returns the outcome, its direction and the
row that fired; harnesses and procedures never decide outcomes. The rows are data-shaped in code so they are tested
row by row, and `gg doctor` prints a vertex's effective table next to its effective check list:

| Harness result | Claim | Checks | Transition |
|---|---|---|---|
| any | any | integrity violation | stop: discard the agent's changes, needs-human |
| failed, class transient or rate-limited | none | integrity only | retry the attempt within the class budget, honouring `retryAfterMs`; exhausted: needs-human |
| failed, class auth, quota or budget | none | integrity only | stop the whole run: every active ticket to needs-human, class on the run end event |
| timed-out or killed | ignored, even if partial | integrity only | one retry as a fresh attempt, resuming the session where the harness allows; then needs-human |
| failed, class unknown | none | integrity only | needs-human, no retry |
| completed | invalid: field missing, malformed, or more than one token | integrity only | parse-failure retry resuming the session with a return-the-result nudge, default 1; exhausted: needs-human |
| completed | valid, blocked or misscoped | all run and recorded | stop: comment and needs-human, or replan; passing checks never override this |
| completed | valid, ok | a declared check fails | retry within the procedure's own bounds; when those are exhausted the procedure signals failure and the interpreter derives the failure outcome (`red-failed`, `gate-failed(<gate>)`), whose route applies, with the built-in default needs-human when no route exists; edge and vertex bounds apply to the traversal as usual |
| completed | valid, ok | every declared check passes | advance |
| gg throws: bug, I/O error, gh failure after its own retries | any | any | unexpected fault: ticket to needs-human with the error on its end event, record marked, exit code 1, never retried automatically; a fault that interrupts a Terminal posts its own comment, carrying the error and the interrupted Terminal's Terminal Reason, which its end event also carries as `interrupted` |

Illustrative enums: `tdd` ok | blocked | misscoped | red-failed | gate-failed(<gate>); `fix` ok | blocked |
misscoped | gate-failed(<gate>); `review` PASS | CHANGES | REPEAT | misscoped. Built-in defaults: blocked posts a
note and goes to needs-human; misscoped goes to replan; thrown errors go to needs-human with the error on the ticket
end event. Blocked is honoured after every agent phase including still-green and test-fix; today's ff misses those
two, so this is a correction, not a port.

Resolution. Outcomes have a direction: advance (ok, PASS), retry (gate-failed, still-green, test-fix, parse failure,
timeout, transient failure class), stop (blocked, misscoped, exhausted, integrity violation). Fixed, not
configurable: advance requires a completed harness result, a valid claim, every declared check of the action passing
and no stop signal from any layer; an integrity violation always stops; review PASS requires no blocker or major
findings, definition of done met and declared checks green, and a repeated findings hash routes REPEAT instead of
looping. Configurable per node through `resolution`, with a shipped default: the order among non-advance outcomes
when several are signalled in one action (default: stop beats retry; within retry, in place before discard and retry;
within stop, replan on misscoped, escalate before needs-human), the weight of the agent's claim when no deterministic
evidence exists, and per-class retry budgets. Which checks a procedure declares is procedure configuration (above),
not resolution policy. Every signal received and the rule that decided are recorded on the action event.

### 3.5 Execution record, approvals and work management

One persisted record per work item (ticket), plus one per epic for plan approval and epic-level pending state,
each a schema-versioned JSON document stored as one row of the state database `<git common dir>/gg/gg.db`
(`node:sqlite`, ADR 0009), readable with any SQLite client and with `gg work show` (slice 6). Contents: flow name and config hash, run id, graph position, visit counts per vertex and traversal
counts per edge, session lineage per phase (session id, harness, persona hash, last cumulative usage), the outputs
later briefs need (red commit and evidence, implementation reports, review findings and hash, history), worktree
and branch identity, base revision, PR number, pending approval state, and the write-ahead log below.

An execution belongs to a ticket; an epic has an epic record but no execution. A run is one `gg run` invocation:
one run may admit several tickets' executions, and a later run resumes them. An action's identity is `(execution,
vertex, visit, phase, ordinal)`, where deterministic actions carry the phase they serve; an attempt adds `(run,
attempt)`. The action marker names an attempt, since the attempt is what produced the effect. One `tdd` visit, in
order: red call (red, 1), red check (red, 2), commit tests (red, 3), green call (green, 1), green check (green, 2),
quality gates (green, 3 onward), commit (green, next), push, PR upsert. Still-green and test-fix are phases of their
own, with their own briefs: a still-green call is (still-green, 1) and the red check that follows it is (still-green,
2). An attempt number rises only when the same action is tried again, for instance a parse-failure retry of the red
call is attempt 2 of (red, 1). The action cap counts attempts. Every action with a side effect is recorded in three steps: intent before the effect, including the intended payload (commit message,
expected parent and the intended tree hash from `git write-tree`; PR title and body hash; comment body hash; label
name); the effect's own evidence; completion after. The marker travels with the effect: in the commit trailer next
to the vertex and harness, in a hidden marker line in PR bodies and comments, and as the `await` label event for
approvals. Resume reads the log: an intent without completion is reconciled by looking for the marker, never for
mere existence. A commit is complete only when its trailer carries the marker and its parent and tree match the
intent; a marker with a different tree, for instance a commit amended by a human between crash and resume, holds
the ticket for a human. A PR that exists but whose body lacks the marker or hash gets the intended update reapplied,
which is idempotent; a comment without the marker is posted; a label present is accepted. The golden trace tests
kill the process before the effect, between effect and completion, and after completion, for a commit, a PR upsert
and a comment, assert no duplicate and no stale payload, and include the amended-commit fixture.

Reconciliation with GitHub at resume: labels decide whether a executions, the record decides where it continues.
State label says needs-human and record says mid-action: label wins, record marked abandoned. State label in-progress
with no record: stuck, reset path. Configuration is pinned per vertex visit: the record stores the resolved
configuration snapshot a vertex entered with, persona contents included as bytes, not as a path; the current vertex
finishes on that snapshot even if the config hash or a persona file has changed, every call in the visit is supplied
from the snapshot, and the new configuration takes effect at the next vertex entry, logged as a change. A test edits
a persona between green and test-fix and asserts test-fix ran the old bytes. If the current
vertex no longer exists in the new flow, the ticket is held for a human. Transcript missing for a session the record
wants to resume: that phase starts fresh with the full brief. Corrupt record: held for a human, never auto-discarded.

Dirty state. Unknown uncommitted changes at ticket start are held: the ticket goes to needs-human with the diff stat
posted, and nothing is deleted. Rollback by gg is limited to changes the record proves this run's agent made (a failed
red phase or an Integrity Violation in the same run). git does not keep ignored files, so each agent Attempt snapshots the
untracked files, ignored ones included, under the Protected Files and the test paths, and a rollback restores them;
ignored files outside those paths are neither detected nor rolled back, as in snapshot-based agent checkpoints (only a
disposable copy per Attempt would cover them). `gg work reset` is the only destructive path, explicit, refuses when a published PR
exists, and never runs without the ticket named. Cleanup never deletes a worktree that is dirty or has unpushed
commits.

Locks and timeouts. A per-ticket lock, an epic lock for epic-record writes and approval reconciliation, and a
repo-level lock around every orchestrator git write, so two gg processes on one repo serialise correctly. Each lock
is a `node:sqlite` `BEGIN EXCLUSIVE` transaction held open on `<git common dir>/gg/locks/<name>.db`; the OS releases
it when the holder dies, so there is no stale takeover (ADR 0008). The
in-process mutex alone is not enough and the document says so. Retry on index lock with backoff. Stall timeout when
the output stream and transcript stop growing (default about 10 min) and a wall clock per agent action (default about
60 min), per node overridable; expiry kills the process tree through the job object and records a typed timeout
outcome. GitHub writes are idempotent by action identity: PR found by head branch before create, one marked comment
updated in place, label adds that tolerate presence.

Labels are namespaced; the prefix is config, default `gg`:

| Family | Pattern | Written by | Examples |
|---|---|---|---|
| Lifecycle state | `gg:state:<name>` | gg only | `gg:state:in-progress`, `gg:state:needs-human`, `gg:state:ready-for-qa`, `gg:state:needs-replan` |
| Approval request | `gg:await:<vertex>` | gg only | `gg:await:plan`, `gg:await:qa-approval` |
| Human decision | `gg:decide:<vertex>:<outcome>` | humans only | `gg:decide:plan:approved`, `gg:decide:qa-approval:needs-changes` |

`gg init` creates the labels a resolved flow references; doctor reports missing ones. A human touching a state or
await label is an external intervention and reconciles as above. gg never reads or writes ff's unprefixed labels;
ff and gg are never run on the same repository at the same time, and ff goes unused once gg is accepted.

Approval flow, the only one. When a run reaches an approval vertex, or `gg publish` finishes a plan:

1. gg creates a pending instance with a unique id: for a ticket (execution, vertex, visit, nonce); for an epic
   (epic, plan, publish ordinal, nonce), since an epic has no execution. It computes a digest of what is being
   approved: for a ticket, branch HEAD, the ticket body revision and the full config hash; for a plan, the plan
   document, the ticket set with their bodies, and the full config hash.
2. gg retires any earlier request on the item: it removes the vertex's `await` label and every `decide` label for
   that vertex, so no stale decision can follow a new request. It writes the pending instance to the record, applies
   the `await` label, which creates a fresh labeled event, posts one comment naming the instance id, the digest and
   the decide labels, and ends the run for that item.
3. A human applies a `decide` label in the GitHub UI, the mobile app, or with `gg work approve <ticket> [outcome]`,
   which applies the same label through gh. gg never applies a `decide` label; it only removes them to retire or
   consume.
4. On the next run gg reads the issue's event timeline, which has no edit or delete API: it takes the `await`
   labeled event matching the pending instance as the request time, looks for `decide` labeled events after it that
   no later unlabeled event undid, checks each actor's repository permission is write or higher (or the actor is in
   the optional `approvers` list), recomputes the digest and compares it with the record. Exactly one authorised
   decision and a matching digest: consume it. Consumption is a write-ahead action like any other: gg first persists
   the pending instance id, the decision event id, actor and time, the outcome and the next graph position to the
   record, then removes the decide label, then marks completion. A crash after the record write but before or after
   the removal resumes by completing the recorded consumption, never by re-reading the timeline, so the unlabeled
   event gg itself created cannot invalidate the decision. More than one surviving authorised decision: hold, retire
   both, re-request. Digest differs: stale, retire, re-request with the new digest. Record or pending instance
   missing: cannot verify, retire, re-request. Epic-level approvals reconcile under an epic lock file; once verified,
   the epic record stores the approved digest and event id, and every execution under that epic reads the epic
   record rather than the timeline. The stored approval is a cache, not an authority: before admitting any ticket,
   gg recomputes every approval input (plan document, ticket set, each ticket body revision, full config hash) under
   the epic lock and compares it with the approved digest; a mismatch, whether from `gg publish`, a replan, a ticket
   body edited directly on GitHub or a config change, retires the approval and re-requests. Tests cover a direct
   body edit and a config change after approval. The golden trace covers record loss, a repeated
   visit to the same vertex, crashes around consumption, and two ticket processes entering under one epic approval.

Human recovery, `gg work`: list across every repo in the user-dir registry, resume, abandon (keep the worktree, forget
the position), reset (as above), approve. Doctor validates records and reports disagreement with GitHub. Single
machine; the user dir `~/.agents/gg/` holds config and a registry of repo paths appended on each run; repo config is
`.agents/gg/`; state is under the repo's git common dir. gg never reads ff's config or state; ff's open branches and
PRs finish under ff; cutover (section 6) archives ff after a real-harness acceptance run.

### 3.6 Checks and evidence

- Red check: accepted only when the runner exited non-zero on its own (not timeout, not 127) and the output names at
  least one test the agent reported. Where the runner's output distinguishes per-test status (node:test TAP, pytest,
  jest), the named test must be reported failing, not merely present. Otherwise the substring rule is a heuristic and
  the document says so; the counterexample "named test passed, unrelated old test failed" is a fixture that must be
  rejected on runners with per-test status. One still-green retry resumes the red session, then the check runs again.
  Red evidence is captured once after the test commit and reused in every PR body.
- Quality gates: `gates` on the node name repo commands (test, lint, format, coverage). Pass or fail by exit code in
  v1; thresholds come from the tool's own flags. Output captured, fed back on the bounded retry, recorded as its own
  event. Quality gate results go into the reviewer's brief.
- Test test immutability check: test paths are the repo's declared test globs (default pattern shipped) and include additions,
  renames and shared fixtures. The diff of those paths between the baseline commit and the tree must be empty at the
  green check and after test-fix; baseline is the red commit, moving to the fix commit after a fix visit that
  legitimately changed tests. A violation is an integrity stop, not a retry.
- Git ownership, after every agent action: HEAD and index of the agent's worktree unchanged by the agent; no change to
  protected files; for read-only actions the tree unchanged as well, untracked files included. Other worktrees are
  checked only over intervals in which they are proven idle: every worktree carries in the record a busy flag and
  an activity generation. The flag is set before any process gg launches in that worktree starts (agent actions,
  gate and declared commands, git operations) and cleared only after that process and its descendants have
  terminated, with the generation bumped at every transition. A snapshot is three fingerprints: HEAD, the index
  (`git write-tree` of the index) and the working tree including untracked files. At action start gg reads
  generation, takes the snapshot and the busy flag, and reads generation again, keeping the snapshot only if both
  reads match and the flag was idle. At action end it repeats the read, and asserts unchanged only a worktree that was idle at both snapshots
  with the same generation at both. Activity that encloses the action (busy at start) and activity enclosed by it
  (generation moved) are both skipped, not misattributed; tests cover both shapes, a concurrent format quality gate in the
  other worktree, and an index-only mutation in an idle one. A violation discards the agent's changes and stops the
  ticket. These assertions observe the checked surfaces only: worktree HEAD, index, tree and
  protected files. Writes elsewhere on the machine and network effects of commands are not observed, which is the
  stated weakness of the trusted-command mode in 3.2.
- Protected files: agent diffs touching `.agents/`, `.claude/`, `.codex/`, `.mcp.json`, `AGENTS.md` or `CLAUDE.md`
  are rejected. Under the Claude launch profile, settings, hooks, `.mcp.json`, CLAUDE.md and memory are not
  consumed; `.claude/skills`, `.claude/commands` and `.claude/agents` are potentially discoverable, as 3.2 states.
  Codex trust level is set explicitly so project config is not consumed.
- Agents get read-only git (diff, log, status, show) and no movement commands (checkout, switch, worktree, stash,
  reset, add, commit, push, remote, gh). Confinement: Codex sandbox; Claude file tools confined to the working
  directory with prompts off, `--restricted` on read-only actions; the idle-worktree assertion for shell writes.
  Agents are never told the worktree root.
- Declared commands are passed in the brief, not assumed read from AGENTS.md.

### 3.7 Tracing, metrics and export

Events come in two kinds. Action events record one attempt and belong to their execution. Lifecycle events record a
run or an execution starting or ending (run start and end, ticket start and end) and belong to the run or the
execution they describe; stats reads both, and an execution's trace is its action events plus its own lifecycle
events. Action events, schema 2, appended as rows of the state database carry: flow name, config hash,
launch profile, ticket, run, vertex, visit, procedure, phase, ordinal, attempt, duration, outcome, direction, signals
received and the resolution rule applied. Agent actions add: harness and CLI version, model and effective effort,
persona hash, resolved tools with hint fields marked, init metadata (plugins, MCP servers), session id and lineage,
transcript path, usage cumulative and delta, cost delta, peak context, turns, tool calls, compactions, exit code,
signal, final event subtype, permission denials, commands run (diagnostic), failure class. Deterministic actions record
events too.

Token rules, the same for both harnesses: `input` is uncached input tokens only; `cached` is cache reads;
`cacheWrite` is cache creation; `output` is output tokens from the result; `reasoning` where the harness reports it,
else absent. Peak context is the maximum over the session's requests of `input + cached + cacheWrite` for that
request. Cost is the delta of the harness's cumulative figure per session, or computed from `apiPrices` where the
harness reports none, or null. Fixtures cover a resumed Claude session and a resumed Codex thread.

Stats: every action event carries the vertex id, visit and ordinal; lifecycle events carry only the run or execution they describe; aggregation defaults to procedure and phase, with vertex,
harness and model as further dimensions, so two reviewers on the same procedure stay distinguishable and renaming
a vertex does not hide escalations. `rounds`, `red_failed` and `blocked` remain derivable. The commit trailer text
`Feature-Flow-Stage:` is kept, carrying vertex and harness.

Config hash = resolved flow + persona hashes + harness settings + launch profile + declared commands. It covers the
pinned configuration only; the repository content digest (3.2) is live and recorded per attempt, outside the hash.
Written with the resolved flow to the run directory, and the pinned configuration it fingerprints is stored by hash in
the state database the first time a run uses it, so any two hashes in a trace or a record can be diffed (`gg config
diff`, slice 6). Secrets never enter it (3.1).

Retention: nothing in the state database is purged automatically. `gg work archive --before <date>` (slice 6) exports
the events of executions that ended before the date as JSON lines under `<git common dir>/gg/archive/`, deletes those
rows, their run directories and pinned configurations nothing references any more, then checkpoints and vacuums. An
execution record is deleted with its merged worktree or by `gg work reset`; an epic record when the epic is closed and
its ticket records are gone. `gg doctor` reports the database size and the oldest event, with no threshold.

Export: Agent Trajectory Interchange Format (ATIF, Harbor), pinned to the schema version Harbor's validator accepts
at implementation time and recorded in the file. One parent trajectory per execution whose ATIF steps are the
actions, deterministic actions with `llm_call_count: 0`, graph identity and init metadata in `extra`. Each agent action
contributes a subagent trajectory built from the transcript segment that action added (messages after the previous
action of the same session), with a unique `trajectory_id`, so a resumed session is never exported twice; per-action
`metrics` and root `final_metrics` come from the normalised usage. The transcript holds the per-message usage,
model and tool calls this needs; it does not hold init metadata, which is why that comes from the run output.
`gg trace <epic> [ticket]` prints the timeline from the export. Rendering in Harbor's viewer or Phoenix is a
separate acceptance step with its own import check; Phoenix truncates very long single sessions, which short
sessions avoid.

### 3.8 Planning and replanning

The planner is a node with `mode: interactive`, run at epic level by `gg plan`, with the context-budget stop hook and
background sessions ported. `misscoped` from any ticket vertex lands in the replan terminal; `gg plan --replan <epic>`
resumes planning with the collected diagnoses. Publish keeps its planning-session guard for flows with a plan
section, and publish resolves ticket dependencies into blocking issues as today.

### 3.9 Config and migration

Three layers, defaults < user < repo, same merge rules as flows, under `.agents/gg/`. The shipped defaults declare
nodes with empty `skills`, `mcp` and `plugins`, no hooks and no injection; the owner's user config adds ponytail or
anything else. The four stage keys, `stageTools`, `toolkit`, `escalationEnabled`, `maxReviewRounds` and
`contextBudget.<stage>` do not exist in gg; a gg config file using one gets a loud load error with a migration table
naming the replacement (`nodes`, `harnesses`, `flows`). Keys that carry over by name: `planApproval`,
`maxParallel`, `stuckAfterHours`, `baseBranch`, `worktreeRoot`, `allowNetwork`, `style`, `apiPrices`,
`contextBudget.byModel`. Eval variants are config layers and may change flow structure.

## 4. Behaviours to port, and deliberate changes

From feature-flow at 89e1d67; see `C:\dev\ff-review-work\design-vetting-code.md` section 1 for line references.

Ported as they are:

- Red check acceptance rules, single still-green retry, red evidence captured once, failed red discards the worktree
  and records the reason into history, "No tests were written" as a distinct failure.
- Resume rules: still-green resumes red, test-fix resumes whatever produced the code, fix never resumes; history goes
  to red and fix briefs only.
- Review is read-only with the before and after HEAD and dirty comparison; order after review: event, PR comment, PR
  body re-render with provenance, then ready and labels.
- Draft PR upserted after every green commit and push; escalation diagnosis comment when non-empty; provenance table
  with persona hash; commit trailer parsed by outcome refresh.
- Labels never throw: logged, event, exit code 1; exit 2 on any needs-human. In-progress added only after the
  worktree exists.
- Stuck detection: label age past `stuckAfterHours` is the trigger to inspect; a ticket is stuck when its in-progress
  state label stands and no recoverable execution record is behind it; a dead holder's lock is already free (3.5), so a
  recoverable record with no live holder is resumed, not stuck. Reset
  refuses when a published PR exists and closes every draft; cleanup keeps dirty or unpushed worktrees.
- Worktree add serialised, ownership validated, branch reused on title change; push without `-u`.
- Ticket dependency ordering at publish (unknown and cyclic dependencies rejected, blockers resolved to issue
  numbers) and blocker readiness at run, standalone tickets included.
- Codex: sandbox and `-C` before resume, sandbox re-check from the rollout, thread id fallback, usage delta, MXC
  fallback, node_repl lock warning, persona on first prompt only, strict schemas, allowlists as inline tables, listing
  failures throw, cost from `apiPrices` or null.
- Claude: all plugins off then the node's back by directory, allow and deny lists with prefixed twins, missing plugin
  fails before spawn. (ff's throw on `is_error` or missing structured output is superseded; see the deliberate
  changes below.)
- Preflight resolves tools for every active vertex before any gh call or worktree, all failures in one error; plan
  approval admission check; pool with `maxParallel`; per-epic log and usage file; run start and end events.
- Process containment: job object via winjob.ps1 for shell runs, timeout kills orphans, fallback chain and survivor
  reporting; green check timeout 30 minutes.
- Planning: interactive launch with session id and stop-hook budget warning, background sessions, plan marker,
  `--finish`, transcript metrics.

Deliberate changes, each with its own regression case:

- Fresh green session with the full brief (ff resumes red).
- Review PASS requires `dodMet`, `tddEvidenceOk` and no blocker or major findings (ff advances on the verdict alone).
- Test immutability between the red commit and the green check, baseline moving only through a fix visit.
- Blocked honoured after still-green and test-fix.
- Red check requires per-test failure where the runner reports it.
- Approvals bound to a digest and read from label events, not from a label's presence.
- Unknown dirty state held, never discarded.
- Input token accounting split into uncached, cached and cache-write.
- Sessions start empty; ponytail and skills hints come from config.
- Harness failures are typed results, not throws (ff's adapters throw on `is_error` and on missing structured
  output); the transition table in 3.4 replaces per-adapter behaviour.
- Push publishes the last recorded commit by sha, still without `-u`, never the branch tip (ff pushes the branch), so a
  branch changed by hand is never published.

## 5. Tests to port and tests to add

Port `test/exec.test.mjs` (18) and `test/publish.test.mjs` (7) unchanged. Port `test/retry-e2e.test.mjs` (7) and
`test/stuck.test.mjs` to inject the fake harness instead of `deps.invoke`; they are the golden-trace seeds: real bare
origin, fake gh spread over the real module, fake harness that writes files into cwd. From `test/core.test.mjs` port
the behaviours listed in `design-vetting-code.md` section 6 plus the dependency-order tests at lines 71 and 78; skip
the four shape-specific ones.

Golden trace test, staged with the slices in section 6. Slice 1 asserts the exact action sequence and events
for: a first-visit pass, a CHANGES verdict into a fix vertex, a failed red, a blocked claim with passing tests, an
invalid structured output, an integrity violation, and the three crash points around a commit, a PR upsert and a
comment with resume continuing correctly. Slice 4 adds: an escalation, a quality gate failure with retry, a repeated
findings hash, a stale approval. Concurrency: two tickets in parallel with the idle-worktree assertion, and two gg
processes on one repo serialised by the lock.

Launcher acceptance, per harness, against the fake CLI: prompt via stdin, stall timeout, wall-clock timeout, cancel,
orphan descendants killed, diagnostics retained, exit code and signal recorded. The existing exec tests stay and are
not treated as covering this.

Fake harness needs: scripted responses keyed by (vertex, visit, phase, attempt), optional file writes into cwd, a
session id per call with lineage, recorded `write`, `resume`, launch profile and tool arguments, usage with nulls for
declared-absent capabilities, init metadata including error arrays, a way to throw with a failure class, a way to
hang, and a capability matrix the validator reads.

## 6. Delivery

- This repository, binary `gg`, own `test` command, so the installed `ff` runs the tickets from a separate checkout.
  Bootstrap constraint: ff's red check needs failing tests that name themselves in runner output, so the first ticket
  lands an importable scaffold (entry points that export stubs) and every later test fails inside a named case,
  never at import.
- Slice order: (1) harness interface, fake harness, event schema 2, execution record with write-ahead log,
  interpreter with `tdd`, `fix` and `review` on ported git, gh and exec verbs, label namespace, slice-1 golden
  traces. (2) Claude harness with the launch profile and launcher acceptance. (3) Codex harness with sandbox and
  resume quirks. (4) Bounds and escalation, resolution policy, quality gates, approval vertex, slice-4 golden
  traces. (5) Flows in config, `--flow`, layering, migration errors. (6) Trace, stats, ATIF export, `gg work`,
  registry. (7) Planning, publish, replan.
- Interface freeze: the fake harness, the execution record schema and the event schema are frozen at the end of
  slice 1 before any parallel ticket starts. Parallel-safe after that: the two harness modules, flow loader and
  validator, trace renderer, migration table.
- Serial interpreter work is encoded as ticket dependencies, including merging the prerequisite before the dependent
  ticket starts.
- Planner guidance: small tickets per file area; one interpreter-touching ticket in flight at a time; the staged
  golden trace is the definition of done for anything the interpreter touches.
- Cutover: a separately authorised acceptance run of `gg` on its own tickets with the real Claude and Codex
  harnesses on this machine, since fake-harness success proves nothing about native Windows CLI behaviour. It runs
  after ff's last epic on this repository has finished and with no ff run active. Then ff is uninstalled and
  feature-flow archived; ff and gg never run on the same repository concurrently.

## 7. Deferred

Bare-mode launch profile (switch when subscription auth works; doctor probes it); replay beyond
resume; node-level brief files; red and green on separate vertices; parallel branches and fan-out inside a ticket;
non-GitHub ticket sources; multi-machine work management; multiple approvers and git-native signed approvals;
output parsers for quality gate metrics; Claude MCP and skill filtering (becomes exact when the CLI supports it).

## 8. In-flight work in feature-flow

PR 64 merge then stop; PR 65 discard; PR 66 keep as record. Tickets 33, 35, 36, 37 paused, their facts move into the
harness modules. Ticket 46 (single execution) and 47 (approval) are covered here. 48 reshaped (guard only for flows
with a plan section). 45 and 49 reshaped around flows instead of sizes. 50 stays. Epic 1 done.

## 9. Validated facts this document relies on

All on 2026-10-15, this machine, claude 2.1.300 native executable, codex-cli 0.162.1, subscription login.

| Claim | Result |
|---|---|
| `claude --bare -p` with a subscription | Fails: "Not logged in", zero tokens |
| `--setting-sources "" --strict-mcp-config` plus the two env vars | Init lists built-in plugins only; project skill absent; CLAUDE.md ignored |
| `--restricted -p` | Authenticates; same clean init |
| `--safe-mode -p` | Authenticates; installed plugins still listed in init, their skills absent |
| `--output-format stream-json --verbose --json-schema` | Structured output produced; init event carries plugins and MCP fields |
| Same on `--resume` | Structured output produced, same session id |
| `--output-format json --verbose` | Returns the event array including init; undocumented shape |
| Transcript on disk | Per-message usage, model, tool calls; no init metadata |
| `codex exec resume --output-schema` | Flag accepted |
| Codex `-c` precedence | CLI overrides rank above project, profile and user config (OpenAI config docs) |
| GitHub issue events API | Read-only; `labeled` records actor, time, label |
| GitHub review update API | Body only; state cannot be edited; dismissal needs write access and a message |

## 10. References

- `C:\dev\ff-state-review-2026-10-14.md`: scorecard, 47 findings, research grounding.
- `C:\dev\ff-review-work\design-vetting-code.md`, `design-vetting-discourse.md`: findings this document folds in.
- `C:\dev\ff-review-work\astra-review.md`: the adversarial review this revision answers.
- `C:\dev\ff-review-work\frameworks.md`: 23 candidates scored; build, do not adopt.
- ATIF RFC: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
- Phoenix ATIF import: https://arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/importing-atif-trajectories
- Claude headless and CLI reference: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference
- Bare mode and OAuth: https://github.com/anthropics/claude-code/issues/39069
