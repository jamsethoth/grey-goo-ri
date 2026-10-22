<!-- Codex gpt-6-astra (effort high) design review, 2026-10-21, unedited. Merged in user-defined-procedures-review.md. -->

**REQUEST CHANGES** The design is implementable in principle, but several semantics must be s...
[codex] Turn completion inferred after the main thread finished and subagent work drained.
**REQUEST CHANGES**

The design is implementable in principle, but several semantics must be settled before slicing. References below are to the requested main checkout. Counterexamples involving the proposed model are **design inferences**, not executed failures.

## Blocking

1. **Q3a–Q3d, S2 — Recovery can leave required Checks falsely satisfied.**

   Consider `ok.requires: [scope, suite]`: scope passes, suite fails, recovery edits a forbidden file while fixing the tests, and only suite reruns. Both Checks now appear passed, and a commit requiring both satisfies Q3a because suite ran after recovery—even though scope no longer holds.

   **Fix:** bind worktree-dependent evidence to the state checked and invalidate affected results after modifying Actions. Rerun all affected requirements before commit or acceptance. Today’s green recovery recomputes both the suite and Test Immutability in [interpreter.mjs:672](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:672). Historical evidence such as the Red Check needs an explicit, different lifetime.

2. **Q3, Q3d, S2 — The controlling Claim and evaluation boundary are undefined for multiple Phases.**

   The proposed shipped `tdd.ok` requires both red and green. After the red Phase, green is necessarily `not-run`; immediately applying Q3d would stop before green executes. Deferring everything until Procedure completion instead needs rules for intermediate commits, recovery Claims, and earlier routing decisions. Current code preserves a non-`ok` decision across subsequent Actions at [interpreter.mjs:461](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:461).

   **Fix:** distinguish Phase completion from Procedure completion. Specify which response each Check consumes, when future requirements become due, how recovery replaces a Claim, and which Claim controls the final table. Already-observed failures must remain distinct from requirements whose steps have not yet been reached.

3. **D3, Q2, Q3b, S2 — The primitive contract does not yet preserve shipped verification.**

   The listed Check kinds omit `review-pass`. Today it deterministically checks `dodMet`, `tddEvidenceOk`, and every finding’s severity; scalar rules cannot express the findings-array reduction. Replacing that reduction with an agent-supplied summary boolean weakens verification. See [checks.mjs:102](C:/dev/projects/grey-goo-ri/lib/checks.mjs:102).

   Test Immutability also needs more than a generic Check name: its baseline moves after an accepted fix commit, and exceptions apply to tests named by the review being answered. Those behaviors currently live at [interpreter.mjs:675](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:675) and [interpreter.mjs:727](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:727).

   **Fix:** retain a gg-owned review-evidence primitive with explicit field references. Define immutability’s mandatory scheduling, baseline source, permitted-path source, and baseline update. It must retain integrity precedence independently of token `requires`, including on stop Claims.

4. **Q4b, V1, S4 — “Testing boundary values” is insufficient to establish exact overlap analysis.**

   **Design inference:** take integer rows `x = 0`, `x = 10`, then `0 <= x <= 10`. Testing only constants `0` and `10` incorrectly makes the third row appear fully covered; `x = 1` reaches it.

   **Fix:** specify a finite partition using every comparison constant, singleton boundaries, and representatives of every nonempty intervening and outer interval. Multiple fields require combined assignments, and never-fires analysis must subtract the **union** of earlier rows. Include schema restrictions and table-specific facts, such as `not-run ⇒ runs = 0`.

   This can be exact over a defined abstract input domain. It cannot prove that external commands or agents will actually produce every admitted combination. V1 must distinguish logical coverage from execution reachability.

5. **Q8, S1 — Changing identity without an old-record policy jeopardizes reconciliation.**

   Existing records are accepted by `schemaVersion` alone, while markers encode `phase:ordinal`: [record.mjs:159](C:/dev/projects/grey-goo-ri/lib/record.mjs:159), [marker.mjs:2](C:/dev/projects/grey-goo-ri/lib/marker.mjs:2). **Design inference:** a comment lands, completion is lost, and the upgrade cannot recognize its old marker. Treating the lookup as absent can post it again.

   **Fix:** choose an explicit cutover before S1: drain existing Executions using the old binary, or detect and safely refuse incompatible records while preserving them for recovery. Migration is another option, but is not required if draining is acceptable. “No readers for old markers” must come with that operational prerequisite; retaining the version number alone is unsafe.

## Should change

1. **D4, Q3, Q6, Q8 — Expand the ADR amendment beyond “Procedures are code.”**

   ADR 0004 fixes acceptance on every declared Check passing; Q3 instead makes requirements token-dependent and allows non-pass routing. The research also describes replaying an Execution snapshot, whereas request §3.5 and ADR 0005 pin configuration per Visit and permit changes at the next entry.

   **Fix:** explicitly amend the meaning of acceptance versus sideways routing, declared versus required Checks, and the configuration lifetime. Update [ADR 0004](C:/dev/projects/grey-goo-ri/docs/adr/0004-three-layer-outcome-model.md), affected request sections, and glossary identity terms together. The current glossary defines Action identity using Phase and ordinal and reserves “step” as an avoided competing term.

2. **Q3b–Q3d, S2 — Preserve recovery eligibility, Session lineage, and rollback semantics explicitly.**

   Today still-green recovery happens only when the runner exits zero. A Red Check also fails for timeout, command-not-found, or insufficient named-test evidence; those failures do not all trigger another agent call. See [checks.mjs:37](C:/dev/projects/grey-goo-ri/lib/checks.mjs:37) and [interpreter.mjs:26](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:26).

   **Fix:** give recovery a typed eligibility condition, preserving the existing named-test evidence algorithm. Specify still-green → red Session, test-fix → green/fix Session, fresh fix Visits, optional green → red, and missing-transcript fallback. Also preserve rollback to the first red baseline and invalidation of red evidence when no tests were committed.

3. **Q7, V1, S5 — Input availability needs Action-level path analysis and Visit selection semantics.**

   **Design inference:** producer A dominates consumer B, but A takes a stop or failed route before producing `A.commit.sha`. Vertex dominance alone would incorrectly validate B’s required input. On repeated Visits, “latest completed” could also select a Visit that skipped the requested step, despite an older Visit having produced it.

   **Fix:** analyze paths through Action execution and early exits, not merely Vertex reachability. Define completed Visits, skipped outputs, ordering and missing entries for `visits: all`, and whether latest means latest Visit or latest production. Preserve runtime holding for absent required data. For split red/green, pin the selected producer Visit and evidence before starting the consumer.

4. **D3, Q3d, Q6, S5 — Reporting cannot simply move into ordinary effect Actions.**

   Q3d skips later comments after required failure, and stop Claims skip remaining Actions. Yet today review rejection can still produce a review comment, while Terminal reporting formats blocked notes and sends replan diagnoses to both ticket and epic. The latter still depends on literal tokens at [interpreter.mjs:874](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:874).

   **Fix:** define saved reporting data and template references for Terminal reporting, including targets and response provenance. Decide separately whether review-rejection comments remain permitted before routing. Templates must retain canonical markers, persisted payloads, and existing publication redaction.

5. **Q5, Q8, #23 — The reservations are necessary but do not establish a complete frozen contract.**

   An open `intent.action`, evidence slot, and `onInterrupt` do not specify custom Action outputs, pinned executable definitions, retry state, or their event representation. Events currently reject unknown fields at [events.mjs:43](C:/dev/projects/grey-goo-ri/lib/events.mjs:43). Unknown action finders currently default to absent at [reconcile.mjs:138](C:/dev/projects/grey-goo-ri/lib/reconcile.mjs:138), which cannot be carried into Option 3’s default-hold contract.

   **Fix:** before #23, document concrete record/event examples covering a custom effect, Confirmation, interrupted execution, and recovery. Include durable identity for repeated recovery executions, engine-generated Actions, output provenance, and generic payload/result extension points. Explicitly reject or hold unsupported action kinds. No Option 3 execution implementation is needed yet.

6. **S1–S6, V2 — Make dependency and acceptance coverage explicit; keep the implementation smaller.**

   S2 combines the largest behavioral rewrite with removal of existing special cases. S4 and S5 are called parallel, but both can change the interpreter; request §6 requires one interpreter-touching ticket in flight at a time.

   **Fix:** separate S2’s generic execution model from conversion of shipped Procedures, with behavioral fixtures defining their equivalence. Parallelize isolated validator/template work only; serialize interpreter integration. Attach crash traces, recovery freshness, renamed-Procedure equivalence, stop reporting, and `gg doctor` output checks to their owning slices. Backlogging the scenario-run product does not defer these regression checks.

   For simplification, retain the existing deterministic verifier functions as primitives, use one evaluator for the three table contexts, and use one template/reference resolver across Briefs and effect bodies. Avoid adding a general expression language to replace a small missing verifier.

## Questions for the owner

1. **Q3g, Q6, Q3f — May a later Vertex replace failed verification obligations?**

   **Design inference:** A commits after a passing scope Check, then its required suite fails. A routes to B; B requires only lint, which passes, then pushes, creates the PR, and routes to `done`. Every local fence condition can hold although the suite remains failing.

   The new authority explicitly permits intermediate routing, so this is a policy ambiguity rather than an unequivocal violation of Q3g. **Proposed resolution:** either carry unresolved verification obligations with the work, or explicitly document that B’s chosen Checks supersede them. Apply the fence to effective exhaustion targets and irreversible Actions as well as direct routes.

2. **Q3e, Q6, Q3f, S2 — Which Outcomes require explicit routes, and what replaces `then`?**

   Q3e rejects unrouted non-Terminals, while stop and harness Outcomes default to `needs-human`. Removing `edge()`’s literal `ok` handling also leaves `then` undefined; the shipped Flow uses it.

   **Proposed resolution:** define route precedence and exempt documented engine defaults from missing-route errors. Define whether `then` accepts every passed-table Outcome or an explicitly declared subset.

3. **Q3c, Q3a — Does relaxing a token requirement also relax commit requirements?**

   Removing green from `ok.requires` does not preserve `requireTestPass: false` if commit still requires green.

   **Proposed resolution:** specify the option’s transformation of both requirement lists, and show both effective lists in `gg doctor`; retain the warning and mandatory integrity protection.

4. **Q3b, Q4, S2 — Is repeat routing being completed or merely preserved?**

   Main computes the findings hash but deliberately routes repeats as changes at [interpreter.mjs:758](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:758); the request requires repeat routing.

   **Proposed resolution:** explicitly include completion of that behavior. Preserve comparison within the same reviewer Vertex and Execution, define eligible Claims, and decide whether review comments still run before the repeat route.

## Confirmed sound

- **D3/D4:** data-defined Procedures over gg-owned primitives fit the existing architecture and the no-framework ADR. Deferring new effect kinds preserves the accepted Option 1 scope.
- **Q3d/Q2:** fixed integrity precedence preserves the existing protection against prohibited changes surviving malformed or failed Attempts.
- **Q5:** distinguishing absent, conflicting, and unknown Confirmation results—and holding interrupted effects without Confirmation—is sound. Current write-ahead payload reuse and atomic record/Event completion provide reusable foundations.
- **V1/Q8:** a shared admission validator and completing Option 1 before the freeze are the right direction. They need the contracts and cutover above to support the promised stability.

No files were edited, tests run, or GitHub accessed. Runtime behavior remains unverified; the counterexamples identify design gaps, not observed failures.