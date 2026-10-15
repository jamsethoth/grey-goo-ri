# grey-goo-ri

The language of gg: a tool that takes GitHub tickets to reviewed pull requests by sending persona agents through a
bounded workflow graph, with every decision to advance backed by deterministic evidence.

## Language

### Work

**Epic**:
A GitHub issue that groups Tickets under one Plan.
_Avoid_: feature, project, milestone

**Ticket**:
A GitHub issue that is one unit of implementation, carried through a Flow in its own git worktree.
_Avoid_: issue (when a ticket is meant), task, story

**Work Item**:
A Ticket or an Epic as something gg manages: it has an Execution Record and can be listed, resumed or reset.
_Avoid_: job, item, unit

**Execution**:
One Work Item's complete passage through its Flow, from first entry to a Terminal, across any number of Runs.
_Avoid_: journey, instance, ticket run

**Run**:
One invocation of gg over a target such as an Epic or a Ticket.
_Avoid_: session (reserved for agents), job, process

**Flow**:
A named, authored bounded workflow graph with a plan section used at Epic level and a ticket section used per Ticket.
_Avoid_: workflow, pipeline, DAG, graph (alone)

**Plan**:
The Epic-level artefact a planner produces, from which Tickets are published.
_Avoid_: spec, roadmap

### Graph

**Node**:
A reusable declaration of agent work: harness, model, effort, Persona, tools, permission intents and Quality Gates.
_Avoid_: agent, stage, role, persona (for the whole declaration)

**Vertex**:
A Node placed in a Flow with a Procedure and Edges.
_Avoid_: step, state, node (when placement is meant)

**Visit**:
One entry of a Vertex during an Execution.
_Avoid_: round, iteration, pass

**Edge**:
A route from one Vertex to another, selected by an Outcome and carrying a Bound.
_Avoid_: transition, link

**Bound**:
The limit on traversals of an Edge or Visits of a Vertex, with the Vertex to go to when it is exhausted.
_Avoid_: cap (reserved for the ticket action cap), limit, max

**Gate Vertex**:
A Vertex that runs a declared repository command and routes on pass or fail.
_Avoid_: gate (alone), check vertex

**Approval Vertex**:
A Vertex that pauses an Execution until a human gives a Decision.
_Avoid_: approval (alone), human gate, pause

**Terminal**:
A built-in end of an Execution: done, needs-human or replan.
_Avoid_: end state, sink, exit

### Procedure

**Procedure**:
A named sequence of Actions the interpreter performs for a Vertex, with declared options, Checks and an Outcome enum.
_Avoid_: recipe, stage, script, playbook

**Phase**:
A named agent call within a Procedure: red, green, still-green, test-fix, fix or review.
_Avoid_: step, turn, call

**Action**:
The smallest unit the interpreter performs and records: an agent call, a Check, a commit, a push, a pull request write, a comment or a label.
_Avoid_: step, task, operation

**Attempt**:
One try of an Action; a retry is a further Attempt of the same Action.
_Avoid_: try, retry (as a noun), iteration

**Brief**:
The task text given to an agent for one Phase.
_Avoid_: prompt (the whole model input), instructions, task

**Persona**:
The text that defines how a Node's agent behaves, supplied as its system prompt.
_Avoid_: role, system prompt, character, agent

**History**:
The account of earlier failed Attempts on a Ticket that is fed back into a Brief.
_Avoid_: context, log, memory

### Evidence

**Check**:
A deterministic verification the orchestrator performs itself: a Red Check, a Green Check, a Quality Gate or an Integrity Assertion.
_Avoid_: gate (alone), test (when a check is meant), validation (reserved for configuration)

**Red Check**:
The Check that the tests an agent wrote fail before implementation, for the right reason.
_Avoid_: red gate, red verification

**Green Check**:
The Check that the declared test command passes after implementation.
_Avoid_: green gate, test gate

**Quality Gate**:
A Check a Node declares over a named repository command, such as lint, format or coverage, that must pass before the Node's output is accepted.
_Avoid_: gate (alone), persona gate, quality check

**Integrity Assertion**:
A Check that an agent changed nothing outside what it was allowed to: its worktree only, no protected file, no committed test outside a fix round.
_Avoid_: ownership check, tamper check, git assertion

**Integrity Violation**:
A failed Integrity Assertion. It always stops the Execution.
_Avoid_: tampering, breach

**Test Immutability**:
The rule that committed tests do not change between the red commit and the Green Check, except through a fix round that says so.
_Avoid_: tamper check, test protection

**Evidence**:
Captured output that proves a Check's result and travels with the Ticket into pull request bodies and the Trace.
_Avoid_: proof, output, artefact

### Outcome

**Claim**:
What an agent reports about its own work, as exactly one enum token in its structured output.
_Avoid_: status, result, response, outcome (for the agent's view)

**Verdict**:
A reviewer's Claim: PASS, CHANGES or REPEAT.
_Avoid_: review result, judgement

**Harness Result**:
How an agent process ended: completed, failed with a Failure Class, timed out or killed.
_Avoid_: exit status, response, return value

**Failure Class**:
The typed category of a failed Harness Result: auth, quota, budget, rate-limited, transient or unknown.
_Avoid_: error type, error code

**Outcome**:
The value the orchestrator derives from the Claim, the Harness Result and the Checks of an Action, which selects an Edge.
_Avoid_: result, status, decision (reserved for humans), verdict (reserved for reviewers)

**Direction**:
The kind of an Outcome: advance, retry or stop.
_Avoid_: class, category, severity

**Resolution Policy**:
A Node's ordering among non-advance Outcomes when one Action signals several.
_Avoid_: priority, precedence, conflict rule

**Findings Hash**:
The normalised fingerprint of a review's findings, used to recognise a repeated review.
_Avoid_: review hash, signature

### Harness

**Harness**:
The module that drives one agent CLI for a Node and returns a Harness Result with normalised Usage.
_Avoid_: adapter, provider, backend, CLI (for the module)

**CLI**:
The external agent program a Harness drives: Claude Code or Codex.
_Avoid_: harness (for the program), model, agent

**Capability**:
A Harness's declared support for a Node field: exact, hint or unsupported.
_Avoid_: feature, support level

**Launch Profile**:
The fixed set of flags and environment a Harness starts every Session with.
_Avoid_: isolation mode, bare mode (one specific profile), launch config

**Confinement**:
What keeps an agent from acting outside its worktree: a sandbox, or Trusted-Command Mode where none exists.
_Avoid_: permissions (the intents), isolation, sandboxing (alone)

**Trusted-Command Mode**:
The Confinement on Claude under native Windows, where declared commands run without a sandbox and Integrity Assertions detect but do not prevent.
_Avoid_: unsandboxed mode, Windows mode

**Session**:
One agent conversation with a CLI, which later Phases may resume.
_Avoid_: thread, run, context, conversation

**Session Lineage**:
Which Phase's Session a later Phase resumes.
_Avoid_: resume chain, parent session

**Usage**:
Normalised token counts and cost for one Attempt: uncached input, cached, cache-write, output and peak context.
_Avoid_: tokens, cost (alone), metrics

### State and approval

**Execution Record**:
The persisted state of one Execution: position in the graph, Bounds consumed, Sessions, Evidence, pending Approval Requests and the action log.
_Avoid_: journal, checkpoint, state file, record (alone)

**Epic Record**:
The persisted state of an Epic: its plan Decision and Epic-level pending state.
_Avoid_: epic state, plan record

**Action Marker**:
The identity of an Action, carried into the side effects it produces so recovery can recognise them.
_Avoid_: correlation id, tag

**Reconciliation**:
The comparison of an Execution Record with GitHub and git at resume, to decide whether and where an Execution continues.
_Avoid_: recovery, sync, repair

**Held**:
An Execution stopped for a human because gg cannot decide safely.
_Avoid_: blocked (reserved for a Claim), paused, stuck

**Abandoned**:
An Execution Record retired because human action on GitHub superseded it.
_Avoid_: orphaned, discarded, cancelled

**Stuck**:
A Ticket whose State Label says in progress while no live Execution is behind it.
_Avoid_: hung, orphaned, held

**State Label**:
A GitHub label gg writes to mirror an Execution's state.
_Avoid_: status label, lifecycle label

**Await Label**:
A GitHub label gg writes to request a Decision at an Approval Vertex.
_Avoid_: pending label, request label

**Decide Label**:
A GitHub label a human writes to give a Decision.
_Avoid_: approval label, outcome label

**Decision**:
A human's answer at an Approval Vertex, read from the issue's event timeline.
_Avoid_: approval (the general term), outcome, sign-off

**Approval Request**:
gg's ask for a Decision: a Pending Instance, a Digest, an Await Label and an explanatory comment.
_Avoid_: approval (alone), pause, prompt

**Pending Instance**:
The unique identity of one Approval Request.
_Avoid_: request id, approval id

**Digest**:
The fingerprint of what a Decision approves; when it changes the Decision is stale.
_Avoid_: hash (alone), checksum, snapshot

**Approver**:
An actor whose Decision gg accepts.
_Avoid_: reviewer (reserved for the review Node), owner

### Configuration and trace

**Node Library**:
The shared set of named Nodes in configuration that Vertices use or override.
_Avoid_: node registry, catalog

**Layer**:
One of the three configuration sources, defaults, user and repository, merged in that order.
_Avoid_: level, tier, override file

**Resolved Flow**:
A Flow after layering and Node expansion, as written to disk for a Run.
_Avoid_: compiled flow, effective flow

**Configuration Snapshot**:
The resolved configuration a Visit entered with, Persona contents included, which holds for the whole Visit.
_Avoid_: pinned config, frozen config

**Config Hash**:
The fingerprint of everything that changes how an Execution runs, recorded on every Event.
_Avoid_: config id, variant id

**Event**:
One recorded Attempt of an Action, with its identity, Outcome and Usage.
_Avoid_: log line, record, entry

**Trace**:
The ordered Events of an Execution, exportable as a Trajectory.
_Avoid_: log, timeline, history

**Trajectory**:
An Agent Trajectory Interchange Format document: one parent per Execution with one subagent trajectory per agent Attempt.
_Avoid_: ATIF file, transcript, export

**Registry**:
The user-level list of repositories gg has run in, which the work listing reads.
_Avoid_: index, catalog
