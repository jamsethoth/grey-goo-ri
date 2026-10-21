<!-- Codex gpt-6-astra (effort high) research track, 2026-10-21, unedited. Vetted and merged in user-defined-procedures.md. -->

# User-defined workflow outcomes and deterministic use of LLM output

Web access was available. This report uses primary documentation, specifications, papers, and the permitted local source files. **Observed** means documented or directly inspected, not independently runtime-tested. **Inference** identifies interpretation, proposed design, or estimates.

**Recommendation — inference:** start with user-defined declarative Procedures and Actions composed from a small, trusted execution kernel. Keep domain Outcomes configurable while preserving engine-owned integrity enforcement, failure classification, retry accounting, and recovery. This offers substantial flexibility without requiring a general-purpose durable programming runtime.

## Platform comparison

A crucial distinction is between **execution status**—completed, failed, interrupted—and **domain results**, such as “changes required.” Most models below preserve engine-defined execution states while allowing arbitrary result data and user-authored routing.

| Platform/model | Defining steps and reporting results | Outcome typing and routing evaluator | Retries and compensation | Determinism and crash recovery | Versioning in-flight executions |
|---|---|---|---|---|---|
| **AWS Step Functions / ASL** | Implement work behind a Task resource; return JSON. Extensibility sits behind the Task interface rather than introducing arbitrary ASL state kinds. [ASL](https://states-language.net/spec.html#task-state) | Custom error-name strings are distinct from output data. The interpreter evaluates Choice predicates and ordered `ErrorEquals` handlers; Choice supports JSONPath comparisons or JSONata conditions. [ASL](https://states-language.net/spec.html#choice-state) | Ordered `Retry` policies run before `Catch`, with attempt/backoff settings. **Inference:** compensation can be authored as a Catch destination; Catch itself does not reverse effects. [Error handling](https://states-language.net/spec.html#error-handling) | AWS documents Standard execution as exactly-once unless retries are specified; asynchronous Express is at-least-once and synchronous Express at-most-once. These are workflow execution semantics, not a blanket transaction guarantee across external systems. [Execution guarantees](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html) | Published versions are immutable snapshots. Updating a state machine leaves running executions on their previous definition and role. [Versions](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-state-machine-version.html), [update semantics](https://docs.aws.amazon.com/step-functions/latest/apireference/API_UpdateStateMachine.html) |
| **Temporal** | Register ordinary functions as named Activities. Serializable arguments and return values enter Workflow history. [Activities](https://docs.temporal.io/activity-definition) | Workflow user code branches on Activity results or catches typed failures; retry exclusions match `ApplicationFailure.type`. Domain outcomes need not belong to a platform enum. [Workflow definitions](https://docs.temporal.io/workflow-definition), [failure matching](https://docs.temporal.io/encyclopedia/retry-policies) | Declarative Activity retry policies specify limits/backoff/non-retryable errors. Compensation is application-authored Saga logic. [Retries](https://docs.temporal.io/encyclopedia/retry-policies), [Sagas](https://temporal.io/blog/compensating-actions-part-of-a-complete-breakfast-with-sagas) | Workflow code must reproduce compatible Commands against recorded history. Recorded Activity completions are reused; an Activity whose completion was not recorded may execute again, so external effects need idempotency. [Determinism](https://docs.temporal.io/workflow-definition), [completion gap](https://docs.temporal.io/activity-definition#idempotency) | Worker Versioning can pin an execution to its starting deployment. Patching supports compatible changes along replayed code paths. [Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning), [patching](https://docs.temporal.io/workflow-definition#versioning-workflows) |
| **Argo Workflows** | Named container/script templates perform work; DAG/steps templates compose it; `WorkflowTemplate` supplies reusable definitions. Results use output parameters or captured stdout. [Templates](https://argo-workflows.readthedocs.io/en/latest/workflow-templates/), [outputs](https://argo-workflows.readthedocs.io/en/latest/walk-through/output-parameters/) | Engine task results include `Succeeded`, `Failed`, `Errored`, `Skipped`, `Omitted`, and `Daemoned`. The controller evaluates Boolean `depends` expressions. **Inference:** custom business outcomes belong in output data. [Dependencies](https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/) | `retryStrategy` supplies policies, limits, expressions, and backoff. `onExit` invokes authored cleanup regardless of success/failure; it is not automatic rollback. [Retries](https://argo-workflows.readthedocs.io/en/latest/retries/), [exit handlers](https://argo-workflows.readthedocs.io/en/latest/walk-through/exit-handlers/) | Workflow data resides in Kubernetes, optionally supplemented by SQL persistence. `argo retry` reruns failed steps using the same Workflow object. **Inference:** this is task re-execution, not deterministic replay of arbitrary code. [Recovery](https://argo-workflows.readthedocs.io/en/latest/disaster-recovery/), [retry](https://argo-workflows.readthedocs.io/en/latest/cli/argo_retry/) | Status retains `storedTemplates` and `storedWorkflowTemplateSpec`. **Unverified:** these fields alone do not establish one snapshot instant for every transitive reference or container image. [Status fields](https://argo-workflows.readthedocs.io/en/latest/fields/#workflowstatus) |
| **Tekton** | A Task defines container Steps and declared results. `CustomRun` delegates another execution model to a custom controller. [Tasks](https://tekton.dev/docs/pipelines/tasks/), [CustomRuns](https://tekton.dev/docs/pipelines/customruns/) | Results support string/object/array data, with release-dependent feature stages. The controller evaluates `when` guards over values; task conditions remain separate from domain results. [Results](https://tekton.dev/docs/pipelines/tasks/#emitting-results), [guards](https://github.com/tektoncd/pipeline/blob/main/docs/pipelines.md#guard-task-execution-using-when-expressions) | Task `retries`, `onError`, and `finally` express retry, continuation, and cleanup. **Inference:** a `finally` Task must implement any compensating operation itself. [Pipeline semantics](https://github.com/tektoncd/pipeline/blob/main/docs/pipelines.md) | PipelineRun/TaskRun status records execution state, specs, and results. The documented retry mechanism reruns Tasks; deterministic replay of user code is not established by these sources. [PipelineRuns](https://tekton.dev/docs/pipelines/pipelineruns/), [TaskRuns](https://tekton.dev/docs/pipelines/taskruns/) | Starting PipelineSpec and executed TaskSpec are recorded. Bundles support separately versioned task artifacts. **Unverified:** all external task references being frozen together at admission. [Run specs](https://tekton.dev/docs/pipelines/pipelineruns/), [bundles](https://github.com/tektoncd/pipeline/blob/main/docs/pipelines.md#tekton-bundles) |
| **GitHub Actions** | JavaScript, Docker, and composite actions define reusable steps; `workflow_call` exposes reusable workflows. Actions publish outputs. [Custom actions](https://docs.github.com/en/actions/concepts/workflows-and-actions/custom-actions), [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) | Step outputs are strings. `outcome` and `conclusion` use fixed status values, respectively before/after `continue-on-error`. The expression evaluator handles `if`; `fromJSON` enables typed comparisons over output text. [Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#steps-context), [expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions) | Jobs/workflows can be rerun. `failure()` and `always()` select authored cleanup paths. **Unverified:** a general native per-step retry/backoff or transactional compensation facility. [Reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), [status functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions) | Reruns execute jobs again using the original event SHA/ref. **Inference:** this is not instruction-level continuation or replay of recorded step outputs; interrupted-runner recovery internals were not established. [Rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) | References can use SHA/tag/branch. For reusable workflows, rerun-all can resolve a non-SHA reference again; failed/specific-job reruns use the first attempt’s referenced SHA. [Version behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs) |
| **Airflow 3** | Python TaskFlow functions or `BaseOperator` subclasses implement tasks; XCom carries serializable results. [Operators](https://airflow.apache.org/docs/apache-airflow/stable/howto/custom-operator.html), [XCom](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html) | User Python branching returns downstream task IDs; scheduler trigger rules evaluate upstream task states. Business data and scheduling states are separate. [Control flow](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#control-flow) | Task retries have count/delay/backoff settings; setup/teardown tasks handle resource cleanup. Authors are explicitly advised to make tasks idempotent. [Tasks](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html), [cleanup](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#setup-and-teardown), [idempotency](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html#creating-a-task) | Lost task heartbeats cause failure or retry. Failed-attempt XComs are cleared on retry. **Inference:** XCom is not a durable checkpoint for partially completed task code. [Heartbeat handling](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html#task-instance-heartbeat-timeout), [XCom](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html) | Versioned DAG bundles retain code for the run. Git bundles support versioning; documented Local/S3/GCS bundles are unversioned. Definition pinning therefore depends on bundle implementation. [DAG bundles](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/dag-bundles.html) |
| **Camunda / Zeebe / BPMN + DMN** | Service-task job types select external workers. Workers complete with variables, fail with remaining retries, or report BPMN errors. [Workers](https://docs.camunda.io/docs/components/concepts/job-workers/), [errors](https://docs.camunda.io/docs/components/modeler/bpmn/error-events/) | The engine evaluates gateway conditions over variables. DMN tables provide explicit hit policies such as Unique and First; BPMN error codes provide a separate error-routing channel. [Gateways](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways/), [DMN](https://docs.camunda.io/docs/8.9/components/modeler/dmn/decision-table-hit-policy/), [errors](https://docs.camunda.io/docs/components/modeler/bpmn/error-events/) | Workers report retry counts/backoff; exhausted retries raise incidents. BPMN compensation events invoke explicitly modeled compensation handlers. [Retries](https://docs.camunda.io/docs/components/concepts/job-workers/), [compensation](https://docs.camunda.io/docs/8.9/components/modeler/bpmn/compensation-events/) | Zeebe persists and replicates process-event streams. Job delivery is at-least-once; timeout can cause concurrent processing, so workers must be idempotent. [Persistence](https://docs.camunda.io/docs/components/zeebe/technical-concepts/partitions/), [delivery](https://docs.camunda.io/docs/components/concepts/job-workers/#timeouts) | Instances normally retain their starting process-definition version; explicit migration is available. Referenced worker implementations need separate compatibility/version management. [Versioning](https://docs.camunda.io/docs/components/best-practices/operations/versioning-process-definitions/) |
| **Serverless Workflow DSL 1.0** | Reusable functions/tasks and catalogs compose `call`, `run`, and other task kinds. Input/output schemas describe data. [Tagged specification](https://github.com/open-workflow-specification/specification/blob/v1.0.0/dsl-reference.md) | Runtime expressions drive `switch`; structured errors and filters support error routing. Evaluation is performed by the implementing runtime. [Switch/error definitions](https://github.com/open-workflow-specification/specification/blob/v1.0.0/dsl-reference.md#switch) | `try`/`catch` and retry policies express filters, limits, and backoff. **Inference:** compensating calls can be authored in handler tasks. [Try/retry](https://github.com/open-workflow-specification/specification/blob/v1.0.0/dsl-reference.md#try) | **Not established by the cited DSL:** a particular durable-storage, replay, or external-effect atomicity guarantee. A concrete runtime must supply and document those guarantees. [Specification scope](https://github.com/open-workflow-specification/specification/blob/v1.0.0/dsl-reference.md#abstract) | Documents identify DSL and workflow versions. **Unverified:** runtime pinning/migration guarantees; a semantic-version field alone does not establish them. [Document fields](https://github.com/open-workflow-specification/specification/blob/v1.0.0/dsl-reference.md#document) |
| **XState / statecharts** | User implementations supply actions and invoked actors. Actors report completion/output or errors; actions are fire-and-forget. [Invocation model](https://stately.ai/docs/invoke) | User-defined events/context feed guards. Guards should be pure synchronous Boolean functions; the engine chooses the first matching guarded transition. [Guards](https://stately.ai/docs/guards) | **Inference:** retry and compensation can be modeled as explicit states, transitions, and invoked work. Actor errors have transition handlers; this does not itself supply durable compensation. [Actor error handling](https://stately.ai/docs/invoke) | The host persists/restores snapshots. Restoration skips already-executed actions but restarts invocations. **Inference:** snapshot persistence alone does not close external-effect crash windows. [Persistence](https://stately.ai/docs/persistence) | The core persistence documentation warns that changed actor logic may be incompatible with saved state. Application-level compatibility is necessary for the mechanism compared here. [Caveats](https://stately.ai/docs/persistence#caveats) |
| **LangGraph** | User functions implement nodes and return state updates; `Command` can combine updates with a destination. [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) | Conditional-edge functions or `Command.goto` choose destinations in user code. State schemas describe data; domain routing is not restricted to success/failure. [Routing](https://docs.langchain.com/oss/javascript/langgraph/graph-api#conditional-edges) | Node retry policies support limits and predicates. Interrupts persist a pause for external input. **Inference:** compensation remains authored node/tool logic. [Retries](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api#add-retry-policies), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | Checkpoints occur at super-step boundaries; interrupted/retried nodes restart from their beginning. Completed task results can be restored, but task ordering must remain compatible. A persistent checkpointer is required for process-restart durability. [Re-execution](https://docs.langchain.com/oss/javascript/langgraph/graph-api#re-execution-and-idempotency), [storage](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Resumption uses saved state with the currently compiled graph. Removing/renaming nodes needed by interrupted threads is restricted; state changes require compatibility. [Graph migrations](https://docs.langchain.com/oss/javascript/langgraph/graph-api#graph-migrations) |
| **Restate** | User handlers contain code; `ctx.run` wraps operations whose serialized results should be journaled. [Handlers](https://docs.restate.dev/develop/ts/services), [durable steps](https://docs.restate.dev/develop/ts/durable-steps) | Ordinary user code branches on returned data; errors distinguish retryable failures from `TerminalError`. There is no required domain-outcome enum. [Services](https://docs.restate.dev/develop/ts/services), [error handling](https://docs.restate.dev/develop/ts/durable-steps) | Durable-step retry policies bound attempts/time and backoff. Sagas use authored compensation lists executed on terminal failure. [Retries](https://docs.restate.dev/develop/ts/durable-steps), [Sagas](https://docs.restate.dev/guides/sagas) | An execution journal supplies recorded results during replay; nondeterministic operations must use the durable APIs. **Inference:** journaling a result does not establish atomicity with an arbitrary remote write. [Durable steps](https://docs.restate.dev/develop/ts/durable-steps) | Immutable deployment endpoints keep an invocation and its retries on the same implementation; older deployments remain available until drained. Forced replacement can produce replay mismatches. [Versioning](https://docs.restate.dev/services/versioning) |

**Synthesis — inference:** these models offer three separable extension mechanisms: compose existing execution primitives, author decision logic over results, or implement new executable workers. None makes arbitrary user code deterministic merely by registering it as a step.

## LLM output in deterministic processes

### Structural validity is a limited guarantee

**Observed:** constrained decoding can restrict generation to a grammar derived from JSON Schema. Strict structured outputs and strict tool arguments constrain permitted shapes; an `enum` constrains vocabulary. Providers still document semantic mistakes, refusals, and incomplete responses. [Structured-output mechanism](https://openai.com/index/introducing-structured-outputs-in-the-api/), [current output handling](https://developers.openai.com/api/docs/guides/structured-outputs), [JSON Schema enums](https://json-schema.org/understanding-json-schema/reference/enum).

**Inference:** `{"claim":"ok"}` can be perfectly valid and wrong. Parse/schema success, valid classification, executable evidence, and authorization to advance must remain separate. Refusal, truncation, malformed output, valid negative output, and abstention should not collapse into one fallback value.

### Validation and bounded re-ask improve conformance

**Observed:** Instructor returns validation failures to the model and retries. Pydantic AI supports application validators and bounded `ModelRetry`; Guardrails provides re-ask, exception, filtering, and other failure handlers. [Instructor](https://python.useinstructor.com/learning/validation/retry_mechanisms/), [Pydantic AI output validation](https://pydantic.dev/docs/ai/core-concepts/output/), [retry budgets](https://pydantic.dev/docs/ai/core-concepts/retries/), [Guardrails](https://github.com/guardrails-ai/guardrails/blob/main/docs/how_to_guides/rail.md).

**Inference:** successful validation proves only the predicates evaluated. A validator implemented by another LLM remains probabilistic. Preserve every attempt and its validation failures, bound the retry budget, and distinguish a formatting repair from another attempt to perform the underlying work. Otherwise, a re-ask can accidentally repeat worktree mutations or external effects.

### Judges and voting supply evidence, not certainty

**Observed:** research on LLM judges documents position, verbosity, self-enhancement, and reasoning limitations. Self-consistency samples multiple reasoning paths and aggregates answers, improving results on the paper’s evaluated benchmarks. [MT-Bench judge study](https://arxiv.org/abs/2306.05685), [position-bias study](https://arxiv.org/abs/2406.07791), [self-consistency](https://arxiv.org/abs/2203.11171).

**Inference:** a rubric makes judgment inspectable; it does not make it objective. Multiple agreeing samples can share the same misconception. For deterministic aggregation, fix the sample count, answer normalization, tie policy, rubric version, and abstention rule, then record every sample. Voting increases inference cost and cannot override failed integrity or executable checks.

### Independent verifiers establish stronger, narrower facts

**Observed:** HumanEval evaluates generated code using executable tests. DeepSeek-R1 describes rule-based rewards, including checking code against predefined tests. These are concrete instances of externally evaluated evidence. [HumanEval paper](https://arxiv.org/abs/2107.03374), [DeepSeek-R1 paper](https://arxiv.org/abs/2501.12948).

**Inference:** tests establish behavior on their checked cases; type checkers establish properties within their type systems. Neither proves the complete specification, and training with verifiable rewards does not guarantee a subsequent answer.

For gg, acceptance should consume checks executed by the orchestrator against the actual candidate artifact. Evidence should identify the checked tree, command definition, termination status, and relevant output. A check result from an earlier tree must not authorize publishing a later tree.

### Confidence needs calibration; abstention needs a real route

**Observed:** *Language Models (Mostly) Know What They Know* reports useful self-evaluation in tested settings, while documenting difficulty transferring calibration to new tasks. [Paper](https://arxiv.org/abs/2207.05221).

**Inference:** a model-generated confidence percentage is not a portable probability. Allow explicit `unknown` or `abstain`, and calibrate any threshold against representative coding/review cases. Missing evidence, conflicting judgments, and failed checks should remain distinguishable.

### Deterministic replay requires recorded observations

**Observed:** Claude documentation explicitly warns that temperature zero does not guarantee identical output. OpenAI’s seed example describes best-effort reproducibility, not an identity guarantee. The latter is an older example and does not establish current model availability. [Claude temperature](https://platform.claude.com/docs/en/about-claude/glossary#temperature), [OpenAI reproducibility example](https://cookbook.openai.com/examples/reproducible_outputs_with_the_seed_parameter).

**Observed:** Temporal places LLM calls outside deterministic Workflow code and records Activity results. A completed Activity is not rerun during replay, but missing completion evidence can cause another execution. [Workflow determinism](https://docs.temporal.io/workflow-definition), [Activity recording](https://docs.temporal.io/activity-definition#idempotency).

**Inference:** replay consumes a previously recorded answer; another model call is a new observation. A content cache can reuse answers but is not an execution journal: identical prompts in separate Attempts do not necessarily represent the same work or authorization.

A useful record contains the Action/Attempt identity, pinned prompt/schema/policy versions, harness result, response, validation results, independent checks, selected rule, and final Outcome. Preserve evidence under the project’s existing secret-redaction rules. Recovering an answer and recovering work performed before that answer are separate problems.

### Typed extraction can feed a deterministic decision table

**Observed:** schemas constrain extracted fields, and DMN-style tables explicitly define how matching rules determine results. [JSON Schema](https://json-schema.org/understanding-json-schema/reference/enum), [DMN hit policies](https://docs.camunda.io/docs/8.9/components/modeler/dmn/decision-table-hit-policy/).

**Inference:** the useful pattern is:

```text
LLM observation → schema validation ─┐
                                    ├→ pinned rules → Outcome → bounded route
orchestrator checks → evidence ──────┘
```

The rule evaluation can be reproducible even when the original observation was probabilistic. False extracted facts can still produce the wrong decision; the table guarantees consistent policy application, not truthful inputs.

## Exactly three design suggestions for gg

**Observed local starting point:** `PROCEDURES` already describes named Actions, Claims, Checks, and Outcomes, but the interpreter still dispatches fixed Action kinds and named conditions. Resolution uses an ordered table. The Visit snapshot stores the Procedure name, while execution obtains its definition from the running code. [Procedure definitions](C:/dev/projects/grey-goo-ri/lib/procedures.mjs:2), [resolution](C:/dev/projects/grey-goo-ri/lib/outcome.mjs:16), [Visit loading](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:414), [Action dispatch](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:632).

The current request describes Procedures as code and requires one resolution owner, mandatory integrity assertions, bounded graph traversal, and Visit-level configuration pinning. Moving Procedures into user configuration is therefore an intentional contract change. [Request](C:/dev/projects/grey-goo-ri/docs/requests/node-harness-dag.md:228).

All three proposals below are **inference**, and their configuration is illustrative rather than existing syntax. They share these required constraints:

- Engine-owned integrity and read-only enforcement cannot be removed or shadowed by custom Outcomes.
- Every mutating agent Action declares orchestrator-run verification. Missing, stale, or failed evidence cannot authorize acceptance or publication.
- Infrastructure failures, invalid responses, domain Claims, and computed Outcomes remain separate.
- Definition bytes, schemas, rule semantics, and Action identities are pinned for the Visit. An old record is never silently interpreted using changed definitions.
- Retry counts and decisions are persisted before continuation. Interrupted mutation with insufficient recovery evidence goes to Hold.

Build costs below are **unvalidated estimates**, assuming one engineer familiar with gg and including compatibility work, documentation, and focused regression/crash-recovery coverage.

### 1. Declarative recipes over trusted execution primitives

**Borrowed model:** ASL task composition and reusable action/template definitions. Users define named Actions by configuring or composing engine primitives; Procedures sequence those Actions. Shipped `tdd`, `fix`, and `review` become ordinary definitions loaded through the same schema. [ASL](https://states-language.net/spec.html), [reusable templates](https://argo-workflows.readthedocs.io/en/latest/workflow-templates/).

```yaml
version: 1

actions:
  implement:
    kind: agent
    access: workspace-write
    prompt: prompts/implement.md
    responseSchema: schemas/implementation.json
    verify: [unit-tests]

checks:
  unit-tests:
    command: test
    expect: {exitCode: 0}

procedures:
  repair:
    outcomes: [ready, blocked, needs-rework]
    steps:
      - {id: edit, use: implement}
    resolve:
      first:
        - when: {claim: blocked}
          outcome: blocked
        - when: {claim: ok, checksPassed: [unit-tests]}
          outcome: ready
      otherwise: needs-rework

vertices:
  repair:
    procedure: repair
    route:
      ready: publish
      blocked: needs-human
      needs-rework: {to: repair, max: 2}
```

**Evaluation and LLM handling.** The referenced schema defines a closed Claim enum. A small engine-owned predicate vocabulary evaluates recorded Claims and check results; no arbitrary JavaScript expression runs from configuration. The central resolver handles mandatory failures first, then evaluates user rules. Custom “ready” labels gain no special power to bypass verification.

**Recovery and versioning.** Expand recipes into stable, named leaf Actions at Visit entry and persist that expansion. Journal each leaf separately using the existing intent/evidence mechanism. Reuse completed call evidence; retain the current conservative Hold behavior for interrupted agent mutations. Existing commit/push/PR handlers retain their reconciliation logic. Recipe recursion is rejected or bounded.

**Pros:** smallest conceptual extension; readable copied configuration; preserves the current interpreter architecture; no privileged built-in Procedures.

**Cons:** new Actions are compositions of supported primitives. A genuinely new effect mechanism still requires an extension to the execution kernel. Complex branching can become awkward.

**Build cost:** **3–5 engineer-weeks.** Main work is definition/schema loading, stable expansion and pinning, generic Claim schemas, predicate evaluation, removal of procedure-name special cases, and compatibility fixtures. A data-file export of `PROCEDURES` alone would be incomplete.

### 2. State-oriented Procedures with explicit decision tables

**Borrowed model:** BPMN/DMN separates work from policy; statecharts separate states from pure guards. Users define Actions, intermediate states, typed observations, and an independently versioned table that selects the next state or Outcome. [DMN](https://docs.camunda.io/docs/8.9/components/modeler/dmn/decision-table-hit-policy/), [guards](https://stately.ai/docs/guards).

```yaml
version: 1

actions:
  revise-api:
    kind: agent
    access: workspace-write
    prompt: prompts/revise-api.md
    responseSchema: schemas/api-review.json
    verify: [contract-tests]

checks:
  contract-tests:
    command: test-contract
    expect: {exitCode: 0}

procedures:
  api-change:
    outcomes: [ready, breaking-change, uncertain]
    initial: revise
    states:
      revise:
        action: revise-api
        next: classify
      classify:
        decision: api-policy

decisions:
  api-policy:
    hitPolicy: unique
    inputs:
      compatibility: {from: revise.response.compatibility}
      verified: {from: revise.checks.contract-tests.passed}
    rules:
      - when: {compatibility: compatible, verified: true}
        outcome: ready
      - when: {compatibility: breaking}
        outcome: breaking-change
    otherwise: uncertain

routes:
  ready: publish
  breaking-change: needs-human
  uncertain: needs-human
```

Here the response schema defines `compatibility` as `compatible | breaking | unknown`; the `verified` input is supplied exclusively by the orchestrator.

**Evaluation and LLM handling.** The model extracts or assesses typed features rather than directly choosing a destination. The engine evaluates a restricted decision language over those features and trusted evidence. `unique` rejects overlapping matches; no match produces the explicit fallback. Missing values and expression errors cause Hold rather than implicit false/coercion behavior.

**Recovery and versioning.** Persist the table version/hash, input values and provenance, matched rule, Outcome, and continuation together. Replay uses those recorded inputs. A new table does not reinterpret an already committed decision; adoption occurs at the established configuration boundary. Actions still use per-Action recovery, and any compensation is an explicit journaled Action.

**Pros:** policy is inspectable separately from prompts; custom Outcomes need not mirror Claims; good fit for several evidence sources and owner-defined priorities.

**Cons:** larger language and validation surface; rule overlap, missing-value semantics, and schema evolution need careful treatment. A deterministic table can still accept incorrect model-derived features.

**Build cost:** **5–8 engineer-weeks as a standalone design.** It includes the extensible Action/configuration foundation plus state validation, table evaluation, provenance, decision persistence, diagnostics, and migration handling. A restricted table format is substantially smaller than implementing full BPMN/DMN.

### 3. Extensible worker Actions behind a durable protocol

**Borrowed model:** Temporal Activities and Camunda job workers allow new executable work while the engine owns orchestration. Users supply versioned executables implementing a small request/result protocol; Procedures remain declarative. [Temporal Activities](https://docs.temporal.io/activity-definition), [Camunda workers](https://docs.camunda.io/docs/components/concepts/job-workers/).

```yaml
version: 1

actionTypes:
  inspect-contract:
    executable: node
    args: [tools/inspect-contract.mjs]
    artifact: {sha256: "<pinned package digest>"}
    inputSchema: schemas/inspect-input.json
    outputSchema: schemas/inspect-output.json
    access: read-only
    network: false
    recovery: {incomplete: rerun}

actions:
  inspect:
    type: inspect-contract

procedures:
  contract-review:
    outcomes: [accepted, changes, unknown]
    steps:
      - {id: inspect, use: inspect}
    resolve:
      first:
        - when: {output: {verdict: pass}}
          outcome: accepted
        - when: {output: {verdict: fail}}
          outcome: changes
      otherwise: unknown

routes:
  accepted: next
  changes: fix
  unknown: needs-human
```

**Evaluation and LLM handling.** Workers report schema-validated data and execution status, never authoritative routing instructions. The central resolver combines those results with mandatory integrity evidence. A worker using an LLM must expose the model response and validation provenance; its declared verdict remains an observation.

**Recovery and versioning.** Each invocation receives a durable Action identity and recorded input. Completed results are reused. An incomplete operation may rerun only when its effect contract allows it. Other operations require a reconciliation handler distinguishing found, absent, conflicting, and unknown; unknown causes Hold. External operations need stable idempotency identity or effect-specific reconciliation, not an `idempotent: true` promise.

Pin the worker artifact and dependency closure, or verify them and Hold when unavailable or changed. Retain the old protocol evaluator for in-flight records. GitHub/git writes remain brokered through gg-owned effect handlers.

**Integrity boundary.** Execute workers through the existing process and permission machinery, with preflight rejection where requested confinement cannot be enforced. Do not treat a subprocess or an in-process module loader as a sandbox. Integrity assertions remain unconditional; trusted-command limitations must stay explicit.

**Pros:** genuinely new Action implementations without changing gg; language-independent workers; small routing language; Procedures remain ordinary configuration.

**Cons:** largest trust and compatibility surface; copied configuration can reference executable code. Schemas cannot prove idempotency, confinement, or correct reconciliation. Arbitrary plugins cannot receive an automatic exactly-once guarantee.

**Build cost:** **8–12+ engineer-weeks.** Work includes the generic definition foundation, worker protocol, artifact pinning, permission integration, durable invocation identity, recovery contracts, diagnostics, and interruption coverage. Remote workers, plugin distribution, and general-purpose code replay are outside this estimate.

## Uncertain claims and research limits

- **Unverified:** Argo and Tekton freeze every transitive task/template reference at one admission-time snapshot. Their documented stored specs establish less than that.
- **Unverified:** GitHub Actions’ internal interrupted-runner recovery and external-effect guarantees. Public rerun semantics were verified.
- **Version-sensitive:** several sources use moving `latest`, `stable`, or `main` URLs. XState’s current navigation also includes alpha material; the comparison concerns the cited core actor/snapshot behavior. Deployment-specific feature support needs release pinning.
- **Unverified:** direct provider structured-output guarantees map exactly to the installed Claude Code/Codex harness behavior. Those adapters were outside this inspection.
- **Unverified generalization:** judge accuracy, confidence calibration, and voting gains from the cited papers transfer to gg’s coding tasks.
- **Inference:** implementation estimates and option ordering are based on limited source inspection, not a complete dependency or ADR audit.

No files were edited and no tests were run; platform behavior was researched, not exercised.  
The principal risk is mistaking persisted results or valid LLM output for verified correctness or exactly-once external effects.
