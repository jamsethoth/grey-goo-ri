# User-defined Procedures, Actions and Outcomes: research and options

Research for the planning session on letting a repository owner define their own Procedures, Actions and Outcomes
without changing gg. 2026-10-21. Two independent research tracks were run from one brief and merged here:

- [user-defined-procedures-claude.md](user-defined-procedures-claude.md): Claude Opus, 19 platforms, 58 sources.
- [user-defined-procedures-astra.md](user-defined-procedures-astra.md): Codex gpt-6-astra at high effort, 11
  platforms in more depth.

The full comparison tables and source lists are in those two files. This document gives the vetted findings, the
three options, and the questions for the next planning step. Tags: **(observed)** comes from a cited source,
**(inference)** is a judgement, **(corrected)** fixes one of the tracks.

## Decisions this research builds on

From the planning session so far:

- D1. Use cases a–g are all in scope: a QA stage, merge on done, deploy preview, a scope gate, red and green on
  separate Vertices, a notification, a custom review shape.
- D2. Extensions are written by the repository owner. Copying someone else's config is the owner's act and carries the
  owner's trust.
- D3. No privileged built-in Procedures. If `tdd`, `fix` and `review` ship, they are ordinary definitions and their
  names are not reserved.
- Q1. An agent Phase that can change the worktree needs an orchestrator-run Check. A read-only Phase may advance on its
  Claim, with a `gg doctor` warning.
- Q2. Integrity Assertions cannot be switched off.

One more constraint, from the request's non-negotiables (`docs/requests/node-harness-dag.md:28`): "Topology is data.
Work is code. No per-node code; a node is only configuration." Options 1–3 below keep that line: a Procedure is a
composition (data), and an Action is work (code, gg's or the owner's executable). The rejected option (code modules)
crosses it.

## 1. What other platforms do

Both tracks found the same five families:

| Family | Examples | New step type | Outcome typing | Who routes | Recovery of user steps |
|---|---|---|---|---|---|
| Declarative state machine | AWS Step Functions, Serverless Workflow, Conductor, Kestra | A Task names work that runs elsewhere | Error-name strings, kept apart from output data; engine names reserved (`States.*`) | Engine: ordered `Retry` then `Catch` by name; `Choice` with a restricted expression | Engine owns state; executions pinned to an immutable version |
| Container or CI DAG | Argo, Tekton, GitHub Actions | A container or script; new kinds through a plugin protocol (Argo executor plugins, Tekton CustomRun, JS/Docker actions) | A small fixed status enum plus string or JSON outputs | Engine evaluates `when`/`if` expressions over outputs and statuses | Rerun of whole tasks; no replay |
| Python DAG scheduler | Airflow, Dagster, Prefect | User Python | Fixed state enum; Dagster has blocking checks | User code returns the next task IDs; trigger rules over upstream states | Tasks must be idempotent; Airflow 3 pins code per run only with versioned bundles |
| BPMN and DMN | Camunda 8 / Zeebe | A job type, done by an external worker | Business error codes kept apart from technical failures, which retry and then raise an incident | Engine: gateways, error boundary events, DMN decision tables with an explicit hit policy | At-least-once job delivery, so workers must be idempotent; instances stay on their version unless migrated |
| Durable code | Temporal, Inngest, Restate, DBOS, LangGraph's task layer | Any function registered as an activity or step | Whatever the code returns; failures typed by name | User code (`if` on recorded results) | Results memoised by stable step identity; workflow code must replay deterministically; pinned deployments |

LLM-agent frameworks (LangGraph's graph API, CrewAI Flows, Haystack) put routing in a user function or template and add
checkpointing. Haystack warns that its unsafe template mode is a remote-code-execution risk when users can edit the
rules **(observed, Claude track S32)**.

### Lessons both tracks agree on

1. **Two outcome channels.** Every mature engine keeps technical failure (retried by policy, owned by the engine)
   apart from the business result (routed by the author). Examples: Step Functions error names versus `Choice`,
   Camunda incidents versus BPMN errors, Conductor `FAILED` versus `FAILED_WITH_TERMINAL_ERROR`, Temporal `type` plus
   `nonRetryable` **(observed)**. gg already has three: Harness Result, Claim and Checks.
2. **An engine-owned, reserved prefix.** Step Functions reserves `States.*`, and `States.Runtime` cannot be caught.
   gg's integrity, harness-failure and parse rows play the same part. User rules run after them and cannot shadow them.
3. **Restricted rule languages, not code.** ASL comparators or JSONata, Tekton `in`/`notin`, GitHub `if:`, DMN tables.
   Rules must not run code, because the owner may copy rules written by someone else.
4. **Ordered first match, or a strict unique hit.** Most engines use first match. DMN's `UNIQUE` hit policy rejects
   overlapping rules, which catches authoring mistakes in copied config.
5. **In-flight work is pinned to the definition it started with.** Step Functions versions, Temporal Pinned, Restate
   deployments, Camunda, Airflow versioned bundles **(observed)**. Moving in-flight work needs an explicit migration
   (Camunda) or replay-safe code (Temporal Auto-Upgrade).
6. **Plugin step kinds speak a tiny protocol.** A request goes in; a status, outputs and evidence come back. The
   engine owns retries and timeouts (Argo executor plugins, Tekton CustomRun, Conductor and Camunda workers).
7. **Registering a step does not make it safe.** No platform gives arbitrary user code exactly-once effects. Temporal
   may run an activity again when its completion was not recorded, Zeebe delivers jobs at least once, and Restate's
   journal does not make a remote write atomic **(observed, Astra track)**. Effects need an idempotency key or an
   effect-specific lookup. gg's Action Marker plus finder is that lookup.

## 2. Using LLM output in a deterministic process

| Pattern | What it guarantees | What it does not | gg implication |
|---|---|---|---|
| Structured output, constrained decoding | The output parses and matches the schema | Truth. Anthropic: a refusal (`stop_reason: refusal`) or `max_tokens` truncation may not match the schema; "Structured outputs don't guarantee the capitalization of string `enum` and `const` values", with no error raised; numeric and string-length constraints are unsupported **(observed, vetted)** | Compare Claim tokens case-insensitively and forbid tokens that differ only in case. Treat refusal and truncation as parse failures, not Claims. Validate locally anyway. Both Agent CLIs accept a schema: `claude --json-schema` and `codex exec --output-schema` **(observed)** |
| A closed enum as the decision token | Free text becomes a closed set the engine can route on | Restricting the format can lower reasoning quality | Reason in free text first and emit the token last. That is gg's Claim |
| Validate and re-ask (Instructor, Pydantic AI, Guardrails) | A bounded loop until validation passes | A re-ask without outside feedback is weak, and can degrade results (Huang et al.). A re-ask can also repeat worktree work | A re-ask carries the validator's or Check's error. Keep "fix the format" (the parse retry) apart from "do the work again" (a recovery Phase) |
| LLM as judge, rubric, majority vote | Scalable judgement; voting raised GSM8K accuracy by 17.9 points | Position, verbosity and self-enhancement biases; voters can share one misconception; costs N calls | A judge's verdict is an observation. It may route sideways but never overrides a failed Check |
| Verifier-gated acceptance | Acceptance rests on a deterministic check of the real artefact | Agents game verifiers. ImpossibleBench: GPT-5 "cheats 54.0% of the time on Conflicting-SWEbench"; Claude models and Qwen3-Coder "cheat primarily (>79%) through modifying test cases"; read-only tests prevent "test modification attempts" but not special-casing; an abort option cut GPT-5 from 54% to 9%, while for Claude Opus 4.1 "the effect is much less pronounced" **(observed, vetted)** | Keep stop Claims (`blocked`, `misscoped`, or the user's equivalents). Test Immutability blocks the most common Claude cheat. Special-casing needs another Check, such as review, mutation tests or held-out tests, and that is a reason for user-defined Checks |
| Calibrated confidence, abstention | Larger models are fairly well calibrated on some tasks | Calibration transfers poorly to new tasks | Never gate on a self-reported confidence number. An explicit `unknown` Claim needs a real route |
| Record and replay | The model runs once; its recorded answer is reused | Calling the model again is a new observation. Claude's docs say temperature 0 is "not fully deterministic". Thinking Machines got 80 distinct outputs from 1,000 temperature-0 runs, due to batch non-invariance | Recovery reads the recorded Claim and never re-asks. gg already does this (`state.settled`, `visitState`) |
| The LLM proposes, deterministic rules decide | Rule evaluation is reproducible even though the observation was probabilistic | Wrong extracted facts still produce a wrong decision | Cross-check extracted fields against evidence, as the Red Check does with the test names the agent reports |

**Corrected:** the Claude track said `temperature` is unsupported "after Claude Opus 4.6". The sources found say
non-default sampling parameters are rejected from Claude Opus 4.7 on (secondary sources only; Anthropic's own wording was
not retrieved). This does not change any recommendation: replay never calls the model again either way.

## 3. Three options

All three share a fixed core that users cannot reach:

- The engine-owned rows: integrity violation, harness failure classes, run stop, timeout and parse.
- The advance precondition: a completed result, a valid Claim and every declared Check passing.
- The Q1 rule: a worktree-changing agent step reaches no commit without a Check on every path.
- Pinning: the resolved definitions are hashed into the Config Hash and snapshotted in the Execution Record, and a
  resumed record runs its snapshot, never the current file.

### Option 1: Procedures as data over gg-owned primitives

Borrows from Step Functions (closed step kinds, ordered handlers by name, a reserved prefix), GitHub composite actions
(a step list built from known primitives) and DMN hit policies. Both tracks ranked this first.

```yaml
procedures:
  qa:
    claims: { pass: advance, defects: route, blocked: stop }    # token -> role
    steps:
      - { id: qa,        do: agent, brief: qa.md, schema: qa.schema.json, access: write, session: fresh }
      - { id: suite,     do: check, kind: command, command: test }
      - { id: scope,     do: check, kind: changes, only: ["test/**"] }
      - { id: commit,    do: commit, type: test, when: { worktree: changed } }
      - { id: push,      do: push }
    outcomes:                     # evaluated after gg's fixed rows; hit policy unique
      - { when: { check: suite, is: failed }, outcome: defects }
      - { when: { check: scope, is: failed }, outcome: needs-human }
```

- **Evaluation:** a match object over a closed input record (harness status and class, Claim token and role, typed
  Claim fields, each Check as passed, failed, exhausted or relaxed, retry counts). It is not an expression language, so
  copied rules cannot run code. A row that advances still needs the engine's advance precondition.
- **Recovery:** each step has a stable `id`, which becomes the marker's identity in place of the Phase plus ordinal.
  Primitives keep today's write-ahead and finders.
- **Covers:** a, d, e (with Vertex outputs, below), g (custom schema and Claims). Not b, c or f: those need new effect
  kinds.
- **Cost (inference):** the smallest. `PROCEDURES` is already data and `ROWS` is already an ordered table. The work is
  removing the name special cases (`phase === 'red'`, `state.calls.review`), a schema loader, the static validators,
  the snapshot, and porting the shipped three.

### Option 2: Typed observations plus a separate decision table

Borrows from BPMN and DMN (work kept apart from policy) and statecharts (pure guards). The Astra track's second option.
The agent fills typed fields; it does not choose the destination.

```yaml
decisions:
  review-policy:
    hitPolicy: unique
    inputs:
      worst:    { from: review.response.worstSeverity }   # schema enum: none | minor | major | blocker
      repeat:   { from: findings-hash.repeat }             # set by gg
      verified: { from: suite.passed }                     # set by gg
    rules:
      - { when: { worst: [none, minor], verified: true }, outcome: ok }
      - { when: { worst: [major, blocker], repeat: false }, outcome: changes }
      - { when: { repeat: true }, outcome: needs-human }
    otherwise: needs-human
```

- **Evaluation:** a restricted table over typed LLM fields and gg-set evidence. `unique` rejects overlapping rules. No
  match takes `otherwise`. A missing input holds the Ticket, rather than counting as false.
- **Recovery:** the table's hash, its inputs with their provenance, the matched rule and the Outcome are saved
  together. Replay reads them.
- **Covers:** g very well, plus a, d and e as in Option 1. Policy is visible apart from prompts, and several evidence
  sources combine cleanly.
- **Cost (inference):** Option 1 plus the table language, overlap and missing-value rules, and provenance. It is
  larger, and a deterministic table still accepts wrong extracted features.
- **Overlap with Option 1:** Option 1's `outcomes` rows are a small decision table. Option 2's ideas (unique hit,
  typed Claim fields as inputs, a missing input holds) fold into Option 1's rows, so this need not be a separate
  mechanism.

### Option 3: User Actions and Checks as executables behind a durable protocol

Borrows from Argo executor plugins, Tekton CustomRun, Conductor and Camunda workers, and Temporal activities. Both
tracks proposed it, layered on Option 1 (`do: <name>` resolves to a gg primitive or a declared Action).

```yaml
actions:
  deploy-preview:
    kind: effect
    run: [node, .agents/gg/actions/deploy-preview.mjs]    # argv, no shell
    find: [node, .agents/gg/actions/deploy-preview.mjs, --find]
    retry: { transient: 2 }
  types:
    kind: check
    run: [node, .agents/gg/actions/typecheck.mjs]
    reads: worktree                                        # gg asserts the tree is unchanged after it
```

- **Protocol:** one JSON request on stdin (operation `run` or `find`, Action Marker, payload, Ticket, branch, PR,
  worktree). One JSON result on stdout: `{ status, error, retryable, outputs, evidence }`. A missing or invalid result
  is a fault, never a pass. Error names in gg's reserved namespace are rejected.
- **Recovery:** gg owns intent, evidence, completion, the retry budget, cooldown, the human-override check and the stop
  check. `find` answers found, absent, conflicting or unknown. Unknown holds the Ticket. A Check re-runs on resume,
  because it changes nothing, which gg asserts.
- **Trust (I5):** the executable is a Protected File, or is pinned by hash at Run start, so no agent can change what
  gg runs with its credentials. Git and GitHub writes stay gg primitives.
- **Covers:** b, c and f, plus user verifiers such as type checks, mutation tests and held-out tests, which
  ImpossibleBench suggests matter.
- **Cost (inference):** the largest of the three. A protocol runner on the existing job-object runner, `find` wired
  into Reconciliation, preflight trust display, pinning, and contract tests with fixture executables.

### Considered and rejected: Procedures as durable-step code modules

Borrows from Temporal, Inngest, DBOS and Restate: a Procedure is a JS module. On resume it runs again from the top, and
each `ctx.*` call returns its recorded result. It is the most expressive option. Both tracks' evidence counts against
it for gg:

- It crosses "No per-node code".
- `gg doctor` could not print a code Procedure's Checks without running it.
- Copied config would run JS inside the process that holds the git and gh credentials.
- Replay determinism would be the author's job, and Temporal's whole versioning apparatus exists because people get
  it wrong.

## 4. Where the two tracks disagreed, and how it was settled

| Point | Claude track | Astra track | Settled as |
|---|---|---|---|
| Effects with no lookup | Reject an effect with no `probe` at preflight | Not an `idempotent: true` promise; rerun only where the effect contract allows | **For the owner (Q5 below).** Both reject a bare promise. The earlier sketch in this session allowed `idempotent: true`; neither track supports that as written |
| Hit policy | `unique` for user rows | `first` in option 1, `unique` in option 2 | **For the owner (Q4).** `unique` catches overlap in copied rules; `first` matches gg's current `ROWS` |
| Cost | Relative to Option 1 (×1.5–2, ×3–5) | Engineer-weeks (3–5, 5–8, 8–12+) | Both are inference. gg is built by agent Tickets, so the relative sizes are the useful part |
| LangGraph recursion default | 1000 | (not stated) | **Unsure.** Sources say 25 or 1000 depending on version. Not relevant to gg's design |
| ImpossibleBench ">79%" | Claude models | (not cited) | **Corrected:** the figure covers Claude models together with Qwen3-Coder |

## 5. New design facts this research surfaced

1. **Data between Vertices.** Use case e, red and green on separate Vertices, needs a Vertex to read another Vertex's
   outputs (the test list, the red evidence, maybe a Session to resume). Today outputs live in fixed `rec.outputs`
   slots (`red`, `implementation`, `reviews`).
2. **A generic record shape.** D3 forbids slots named after built-in Procedures, so outputs become keyed by Vertex,
   Visit and step `id`. That is a record schema change, and grey-goo-ri issue #23 freezes the record schema.
3. **Step identity.** The marker's `phase:ordinal` becomes a user step `id`. Markers are carried in commits and PR
   comments, so this needs care before the freeze too.

## 6. Recommendation (inference)

Build Option 1, with Option 2's table rules folded into its `outcomes` rows. Design Option 3's protocol now so that
`do: <name>` covers both primitives and declared Actions without a grammar change, and build it second. Reject code
modules. Before grey-goo-ri issue #23 freezes, reserve: a generic outputs shape keyed by step `id`, the snapshot of
resolved Procedure and Action definitions, and an open `intent.action` string.

## 7. Questions for planning step 3

- Q4. Hit policy for user outcome rows: `unique` (overlap is an error) or `first` (order decides)?
- Q5. An effect Action with no `find`: never allowed; allowed with an explicit `rerun: safe` shown loudly by
  `gg doctor`; or allowed, holding for a human whenever it was interrupted?
- Q6. Should a stop Claim be routable (as `misscoped → replan` is today), defaulting to `needs-human`?
- Q7. Data between Vertices for use case e: explicit `inputs: { tests: red.outputs.tests }` on the Vertex, or a shared
  Execution-wide output namespace?
- Q8. Does grey-goo-ri issue #23 wait for this design, or freeze now with reservations and take a version bump later?

## Sources checked while merging

- Anthropic, Structured outputs (capitalisation, refusal, `max_tokens`, unsupported features):
  https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Zhong, Raghunathan and Carlini, ImpossibleBench, arXiv:2510.20270: https://arxiv.org/html/2510.20270v1
- Sampling parameter changes on newer Claude models (secondary sources):
  https://platform.claude.com/docs/about-claude/model-deprecations ,
  https://github.com/BerriAI/litellm/issues/26444
- LangGraph recursion limit (unsure): https://docs.langchain.com/oss/javascript/langgraph/errors/GRAPH_RECURSION_LIMIT
- Local: `claude --help` (`--json-schema`), `docs/requests/node-harness-dag.md:28,138,162`

Every other claim cites its source in the two track reports.
