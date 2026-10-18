# grey-goo-ri

The language of gg: a tool that takes GitHub tickets to reviewed pull requests by sending persona agents through a
bounded workflow graph, with every decision to advance backed by deterministic evidence.

How to read the avoid lists: they prohibit competing names for the defined concept, not the word everywhere. An
external identifier, a historical configuration key, a quotation, and the ordinary technical sense of a word (a git
index, an OS signal, a Codex thread, a GitHub timeline) stay as they are. Where documents disagree, the request
document decides behaviour, an ADR decides why, and this glossary decides what things are called.

## Language

### Work

**Epic**:
A GitHub issue that groups Tickets under one Plan. An Epic has an Epic Record and Decisions; it has no Execution.
_Avoid_: feature, milestone

**Ticket**:
A GitHub issue that is one unit of implementation, carried through a Flow in its own git worktree.
_Avoid_: issue (when a ticket is meant), story

**Work Item**:
A Ticket or an Epic as something gg manages, lists, resumes or resets.
_Avoid_: job

**Execution**:
One Ticket's complete passage through the ticket section of its Flow, from first entry to a Terminal, across any
number of Runs.
_Avoid_: journey, ticket run

**Run**:
One invocation of `gg run` over a target. One Run may admit several Executions, and a later Run resumes them.
_Avoid_: session (reserved for agents)

**Flow**:
A named, authored bounded workflow graph with a plan section used at Epic level and a ticket section used per Ticket.
_Avoid_: pipeline, DAG, workflow (as the noun for a specific flow)

**Plan**:
The Epic-level artefact a planner produces, from which Tickets are published.
_Avoid_: spec, roadmap

### Graph

**Node**:
A reusable declaration of agent work: harness, model, effort, Persona, tools, Permission Intents and Quality Gates.
_Avoid_: stage, role, agent (for the declaration)

**Vertex**:
A placement in a Flow that an Execution can occupy. Three kinds: Persona Vertex, Gate Vertex, Approval Vertex.
_Avoid_: step, state

**Persona Vertex**:
A Vertex that runs a Node through a Procedure.
_Avoid_: agent vertex, node (when the placement is meant)

**Gate Vertex**:
A Vertex that runs one Declared Command and routes on pass or fail.
_Avoid_: gate (alone), check vertex

**Approval Vertex**:
A Vertex that pauses an Execution until a human gives a Decision.
_Avoid_: human gate, pause

**Visit**:
One entry of a Vertex during an Execution.
_Avoid_: round, iteration

**Edge**:
A route from a Vertex to a Vertex or a Terminal, selected by an Outcome. A back edge carries a Bound.
_Avoid_: transition, link

**Bound**:
The limit on traversals of an Edge or Visits of a Vertex, with the target to go to when it is exhausted.
_Avoid_: limit, max

**Action Cap**:
The limit on Attempts in one Execution; exhausting it ends the Execution at needs-human.
_Avoid_: step cap, ticket cap

**Terminal**:
A built-in end of an Execution: done, needs-human or replan.
_Avoid_: end state, sink

**Terminal Reason**:
Why an Execution reached its Terminal, recorded for every Terminal, successful or not: the Action that decided it (or
the named hold that stopped the Execution before any Action), its Outcome and rule, and one sentence for a human.
_Avoid_: rationale, cause, end reason

**Escalation**:
Routing to a Persona Vertex with a stronger Node after a Bound is exhausted. It is automatic; needs-human is not.
_Avoid_: fallback, hand-off

### Procedure

**Procedure**:
A named sequence of Actions the interpreter performs for a Persona Vertex, with declared options, Checks and an
Outcome enum.
_Avoid_: recipe, script, playbook

**Phase**:
A named agent call within a Procedure, such as red, green, still-green, test-fix, fix or review. The deterministic
Actions that serve a Phase carry its name. A Terminal's Actions carry the Terminal's name in that place, and the
Actions of a fault report carry `fault`.
_Avoid_: step, turn

**Action**:
The smallest logical unit of a Procedure: an agent call, a Check, a commit, a push, a pull request write, a comment
or a label. Its identity is its Execution, Vertex, Visit, Phase and ordinal within the Phase.
_Avoid_: step, task, operation

**Attempt**:
One try of an Action within one Run. Retries of the same Action are further Attempts; a transport retry inside a
harness is not.
_Avoid_: try, iteration

**Action Marker**:
The identity of an Attempt, carried into the side effects it produces so recovery can recognise them.
_Avoid_: correlation id, tag

**Interrupted Attempt**:
An agent Attempt whose intent is open at resume because gg died during it. It is rescued, reset to its baseline and
retried once (ADR 0011).
_Avoid_: crashed call, orphan

**Rescue Ref**:
The git ref under `refs/gg/rescue/` that keeps everything an Interrupted Attempt left in the worktree, untracked files
included, before the reset.
_Avoid_: backup, stash

**Brief**:
The task text given to an agent for one Phase.
_Avoid_: instructions, task

**Persona**:
The text that defines how a Node's agent behaves, supplied as its system prompt.
_Avoid_: role, character

**History**:
The account of earlier failed Attempts on a Ticket that is fed back into a Brief.
_Avoid_: memory

**Declared Command**:
A named command a repository publishes, such as test or lint, that Checks run and agents may run. Agents may also
use gg's built-in read-only allowlist, such as read-only git and file reads, which is not a Declared Command.
_Avoid_: script, task, allowed command

**Permission Intent**:
What a Node asks for in the abstract, such as read-only or workspace-write access and network, which each Harness
translates into its own mechanisms.
_Avoid_: permissions (the translated rules), allowlist

**Protected File**:
A path an agent may never change because the next Action could consume it: agent and tool configuration and
repository instructions.
_Avoid_: locked file, reserved path

### Evidence

**Check**:
A deterministic verification the orchestrator performs itself, whose result feeds an Outcome. Named kinds include
the Red Check, the Green Check, Quality Gates, Integrity Assertions, the Findings Hash comparison and the Approval
Admission Check.
_Avoid_: gate (alone), test (when a check is meant), validation (reserved for configuration)

**Red Check**:
The Check that the tests an agent wrote fail before implementation: the runner failed on its own, and a test the
agent named is reported failing where the runner reports per test, or present in the output where it does not.
_Avoid_: red gate, red verification

**Green Check**:
The Check that the test Declared Command passes after implementation.
_Avoid_: green gate, test gate

**Quality Gate**:
A Check a Node declares over a Declared Command, such as lint, format or coverage, that must pass before the Node's
output is accepted. A Node acceptance check, not a graph placement.
_Avoid_: gate (alone), persona gate

**Integrity Assertion**:
A Check over the checked surfaces only: the worktree's HEAD, index and tree, other idle worktrees, Protected Files
and committed tests.
_Avoid_: ownership check, tamper check

**Integrity Violation**:
A failed Integrity Assertion. It always stops the Execution.
_Avoid_: tampering, breach

**Test Immutability**:
The rule that committed tests do not change between the red commit and the Green Check, except through a fix Visit
that says so.
_Avoid_: tamper check, test protection

**Approval Admission Check**:
The Check that a stored Decision still covers what is about to run, performed before a Work Item is admitted.
_Avoid_: approval gate, plan gate

**Evidence**:
Captured material that establishes a fact for later readers. Check Evidence establishes a Check's result; Effect
Evidence establishes that an Action's side effect happened.
_Avoid_: proof

### Outcome

**Structured Response**:
The whole machine-readable answer an agent returns for a Phase, validated against the Phase's schema.
_Avoid_: output (alone), payload

**Claim**:
The one field of a Structured Response in which the agent names what it reports: exactly one enum token.
_Avoid_: status, result, response (for this field)

**Verdict**:
A reviewer's Claim about the change: ok, changes or misscoped. The derived repeat, from a repeated Findings Hash,
routes in place of changes and is never claimed. Every Claim and Outcome token is lowercase.
_Avoid_: review result, judgement

**Finding**:
One item a reviewer reports: a severity, a file, an issue and a fix.
_Avoid_: comment, issue (for this)

**Findings Hash**:
The normalised fingerprint of a review's Findings, used to recognise a repeated review.
_Avoid_: review hash, signature

**Harness Result**:
How an agent process ended: completed, failed with a Failure Class, timed out or killed.
_Avoid_: exit status, return value

**Failure Class**:
The typed category of a failed Harness Result: auth, quota, budget, rate-limited, transient or unknown.
_Avoid_: error type, error code

**Signal**:
One input to resolving an Outcome: a Claim, a Harness Result or a Check result. Not an OS signal.
_Avoid_: hint, flag

**Outcome**:
The value the interpreter derives for a Vertex that selects its Edge: from the Signals of a Persona Vertex, from
the command result of a Gate Vertex, from the Decision of an Approval Vertex.
_Avoid_: result, status, decision (reserved for humans), verdict (reserved for reviewers)

**Direction**:
The kind of an Outcome: advance, retry or stop.
_Avoid_: category, severity

**Resolution Policy**:
A Node's rules for deriving one Outcome when its Signals disagree: ordering among non-advance Outcomes, the weight
of the Claim without deterministic evidence, and retry budgets by Failure Class.
_Avoid_: priority, precedence, conflict rule

### Harness

**Harness**:
The module that drives one Agent CLI for a Node and returns a Harness Result with normalised Usage.
_Avoid_: adapter, provider, backend

**Agent CLI**:
The external agent program a Harness drives: Claude Code or Codex.
_Avoid_: model (for the program), harness (for the program)

**Capability**:
What a Harness declares it supports and how: exact, hint or unsupported for a Node field, and the presence or
absence of a measurement or behaviour.
_Avoid_: feature, support level

**Launch Profile**:
The way a Harness starts sessions: the fixed flags and environment that give every session the same isolation,
plus the per-call additions a Node's declaration requires.
_Avoid_: isolation mode, bare mode (one specific profile)

**Confinement**:
The declared mechanism that restricts what an agent's commands may touch: a sandbox, or Trusted-Command Mode where
none exists.
_Avoid_: isolation, sandboxing (alone)

**Trusted-Command Mode**:
The Confinement on Claude under native Windows: Declared Commands run without a sandbox, Integrity Assertions detect
changes to the checked surfaces, and writes elsewhere or network effects of commands are neither prevented nor
observed.
_Avoid_: unsandboxed mode, Windows mode

**Session**:
One agent conversation with an Agent CLI, which later Phases may resume.
_Avoid_: thread (except for Codex's own term), conversation

**Session Lineage**:
Which Phase's Session a later Phase resumes.
_Avoid_: resume chain

**Usage**:
Normalised consumption of one Attempt or one Session: token counts by kind, cost, and peak context, kept both
cumulative per Session and as the Attempt's delta.
_Avoid_: tokens (alone), cost (alone)

### State and approval

**Execution Record**:
The persisted state of one Execution, from which it resumes.
_Avoid_: journal, checkpoint, state file

**Epic Record**:
The persisted state of an Epic: its plan Decision and Epic-level pending state.
_Avoid_: plan record

**State Database**:
The per-repository `node:sqlite` file `<git common dir>/gg/gg.db` that holds every Execution Record, Epic Record,
Event and Pinned Configuration as rows. Locks are not in it: each lock is a separate SQLite database file that gg
only holds open in an exclusive transaction, so SQLite and the OS own exclusivity and release (ADR 0008).
_Avoid_: store, state file, db (alone)

**Reconciliation**:
The comparison of an Execution Record with GitHub and git at resume, to decide whether and where an Execution
continues.
_Avoid_: sync, repair

**Pending**:
An Execution waiting for a Decision at an Approval Vertex. Healthy, not Stuck.
_Avoid_: blocked, paused, waiting

**Held**:
An Execution gg stopped for a human because it could not decide safely; its State Label is needs-human.
_Avoid_: blocked (reserved for a Claim), stuck

**Stuck**:
A Ticket whose State Label says in progress while no recoverable Execution Record is behind it.
_Avoid_: hung, orphaned

**Abandoned**:
An Execution Record retired, either because human action on GitHub superseded it or because a human abandoned it
with the work command.
_Avoid_: discarded, cancelled

**State Label**:
A GitHub label gg writes to mirror an Execution's state.
_Avoid_: status label, lifecycle label

**Await Label**:
A GitHub label gg writes to ask for a Decision at an Approval Vertex.
_Avoid_: request label, pending label

**Decide Label**:
A GitHub label a human writes to give a Decision.
_Avoid_: approval label, outcome label

**Decision**:
A human's answer at an Approval Vertex, read from the issue's event timeline; its value becomes the Vertex's Outcome.
_Avoid_: sign-off

**Approval Request**:
gg's ask for a Decision: a Pending Instance, an Approval Digest, an Await Label and an explanatory comment.
"Approval" alone names the whole protocol of request, Decision and admission.
_Avoid_: pause, prompt

**Pending Instance**:
The unique identity of one Approval Request.
_Avoid_: request id, approval id

**Approval Digest**:
The fingerprint of what a Decision covers; when it changes the Decision is stale.
_Avoid_: digest (alone), checksum

**Approver**:
An actor whose Decision gg accepts.
_Avoid_: reviewer (reserved for the review Node), owner

### Configuration and trace

**Node Library**:
The shared set of named Nodes that Vertices use or override.
_Avoid_: node registry, catalog

**Layer**:
One of the three configuration sources, defaults, user and repository, merged in that order. The defaults Layer is
harness-neutral: its Nodes name no Harness, model or effort, so a user or repository Layer supplies them.
_Avoid_: tier, override file

**Resolved Flow**:
A Flow after layering and Node expansion, as a Run actually uses it.
_Avoid_: compiled flow, effective flow

**Configuration Snapshot**:
The resolved configuration a Visit entered with, Persona contents included, which holds for the whole Visit.
_Avoid_: pinned config, frozen config

**Config Hash**:
The fingerprint of the pinned configuration an Execution runs under. It excludes live repository content, which has
its own Repository Content Digest.
_Avoid_: config id, variant id

**Pinned Configuration**:
The resolved configuration a Config Hash fingerprints: Resolved Flow, Persona bytes, harness settings, Launch Profile
and Declared Commands, stored by hash in the State Database so two hashes can be diffed.
_Avoid_: config snapshot (reserved for a Visit), config blob

**Repository Content Digest**:
The fingerprint of repository-owned agent content that a Launch Profile may expose, recorded per Attempt because it
can change mid-Visit.
_Avoid_: digest (alone), content hash

**Event**:
One recorded fact about a Run or an Execution. An Action Event records one Attempt and belongs to its Execution; a
Lifecycle Event records a Run or Execution starting or ending.
_Avoid_: log line, entry

**Trace**:
The ordered Events of one Execution, exportable as a Trajectory.
_Avoid_: log, timeline (except GitHub's own)

**Trajectory**:
The interchange-format export of a Trace, one per Execution, with one subagent trajectory per agent Attempt.
_Avoid_: export (alone), transcript (the raw Agent CLI file it is built from)

**Registry**:
The user-level list of repositories gg has run in, which the work listing reads.
_Avoid_: index (except git's), catalog
