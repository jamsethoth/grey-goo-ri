# User-defined Procedures: review round 5, raw reviews

The two reviews of the filed Epic (grey-goo-ri issue #101), 2026-10-22, as returned, from the brief "Review brief: the
filed option 1 Epic" (filing fidelity, implementability, order against the code, coverage, contradictions, issues #23
and #68). [Merged](user-defined-procedures-review5.md).

## Astra (gpt-6-astra, high)

1. **FR-1 — #118, #68 — blocks implementation: rescue completeness is deferred to the later caller.**
   Evidence: #68 says, "If #118's rescue does not yet keep the ignored Protected Files and tests … add that … here".
   #118 requires rescue followed by reset without specifying that coverage. The existing snapshot uses `git add -A`
   (`lib/integrity.mjs:32`), while restoration separately removes or overwrites ignored tests
   (`lib/integrity.mjs:146–157`). A failed `tests: write` Vertex can therefore lose ignored test changes before #68
   lands. Replacement: "#118 owns the complete shared rescue/reset mechanism. Before resetting, preserve tracked and
   untracked changes, including ignored files under Protected Files and the pinned testPaths; verify the saved state
   still matches before reset. Persist everything needed to resume both steps. Add a routed-failure regression proving
   ignored test contents survive in the rescue. #68 reuses this mechanism without extending its file coverage."
2. **FR-2 — #23 — blocks implementation: the freeze still requires the removed Phase identity.** "Hold Actions carry
   the `hold` Phase in their Action Markers and Action Events" contradicts #111's replacement marker and the final
   identity in `docs/requests/node-harness-dag.md:330–335`. The preceding item also calls `rescue` merely reserved for
   #68, although #118 implements it before the freeze. Replacement: "Hold reporting Actions use the final Action id
   and Recovery Number in their markers and Events; no Phase/ordinal identity remains. Golden traces distinguish hold
   reporting from ordinary Procedure Actions." and "Document the implemented rescue/reset intent and evidence shapes
   from #118. #68 reuses those shapes; explicitly document its reserved persisted crash-retry budget and continuation
   state so it requires no later schema change."
3. **FR-3 — #122 — blocks implementation: its planned-Flow regression is unreachable under the required validator.**
   #122 requires "a standalone Ticket under a planned Flow is told to pass a null-plan Flow". But #106 requires
   `plan: null` until planning lands (X2d). Preflight precedes issue lookup and the standalone rejection
   (`lib/run.mjs:98–109`), so a non-null plan must fail before this test's scenario. Replacement: "Until Epic planning
   lands, a non-null plan fails validation with 'Epic planning is not built yet.' Replace the standalone planned-Flow
   test with that preflight regression. Defer the standalone-specific suggestion of a null-plan Flow via --flow to the
   ticket that enables non-null planning Flows."
4. **FR-4 — #101, #104–#107, #112–#113 — should fix before `ff run`: the parallel schedule overlaps shared
   implementation files.** #104 and #105 both change `lib/briefs.mjs` and its tests. #106 targets the Flow resolver,
   while #112 must also adapt it for deterministic `publish`: today `resolveFlow` requires an Agent
   (`lib/flow.mjs:12–21`) and preflight dereferences it (`lib/run.mjs:57–59`). "Not yet called by `gg run`" needs an
   explicit API boundary because `gg run` already calls `resolveFlow`. Replacement: "#105 depends on #102 and #104.
   #106 depends on #103, #104 and #112; #107 remains dependent on #106; #113 depends on #112 and #107. #106 adds a
   separate final-shape validation entry point for doctor and fixtures, preserving the runtime resolveFlow contract
   until #116 switches admission. Remove #106/#107 from the Epic's parallel list."
5. **FR-5 — #114, #106 — should fix before `ff run`: no ticket builds the `changes` Check.** #114's list is
   "`command`, `tests-fail`, `response` … and `repeat`". ADR 0014 includes `changes` (line 13), as does the amended
   request (`node-harness-dag.md:241–242`). No implementation exists in `lib/checks.mjs`. Replacement: "#114 also
   implements the changes Check kind, including its only-path restriction, comparison baseline, treatment of
   additions/deletions/renames/untracked files, failure evidence and recoverability. #106 validates those parameters.
   Add regressions where test-only edits pass and an additional source edit fails, with the offending path recorded.
   State the complete parameter contract in this ticket before implementation."
6. **FR-6 — #23 — should fix before `ff run`: the generic owner reservation omits Action Events.** The item names
   only `ticket_start`, `ticket_end`. `ticket` is also mandatory in `ACTION_REQUIRED` (`lib/events.mjs:30–33`), and
   Action Events reject unknown fields (`lib/events.mjs:23–27`). Replacement: "An Execution's owner is represented as
   { kind: ticket | epic, number } in the Execution Record and every Execution-scoped Event, including Action Events,
   ticket_start and ticket_end. Define the disposition and null rules of the existing ticket field consistently.
   Runtime writes ticket owners only until slice 7; schema fixtures verify both owner kinds before freezing."
7. **FR-7 — #109 — should fix before `ff run`: its acceptance test forbids the reporting it requires.** "Terminal
   reporting stays exempt" conflicts with "ends the Ticket at needs-human with no GitHub write"; the test repeats it.
   Ending at needs-human requires reporting writes; the queued operation can itself be a git push
   (`lib/interpreter.mjs:269–275`). Replacement: "A sibling's run stop during a repo-lock wait prevents the queued
   normal-work effect, including push. Only the required needs-human reporting Actions may write afterward." Test: "a
   run stop during a repo-lock wait suppresses the queued effect while completing needs-human reporting."

No findings in filing fidelity, the declared recovery, input-selection or approval-consumption contracts. Blocked: the
pre-rewrite body of #68 was not supplied.

## Fable

Filing fidelity: no findings (a mechanical diff shows every ticket byte-identical apart from the heading form; every
"Depends on" matches its blocked-by list; all 22 sub-issues listed). Cited code checks hold (`lib/record.mjs:139`,
`bracket()` at `interpreter.mjs:88-98`, `lockGuard` at `:271`, `fakeGh`'s one label set at
`test/support/golden.mjs:180`, the `run.mjs:94/110`, `interpreter.mjs:463/811` and `config.mjs:56` shortcuts, the
967-line interpreter, the `TERMINALS` copies, the issue #123 dead-code list, `DEFAULT_TEST_GLOBS` vs `TEST_PATH`).

- **FR-1 — #106, #107 vs #112, #113, #117 — should fix.** The parallel validator tickets rewrite `lib/flow.mjs` while
  serial tickets must edit it: `resolveFlow` is the live loader (`VERTEX_FIELDS`, `lib/flow.mjs:5`); #112 removes
  `then`, #113 adds `inputs`, #117 adds `maxVisits`/`exhausted`. Add to #106: "The validator and its Resolved Flow are
  new exports (`validateFlow`, in `lib/flow.mjs` beside `resolveFlow` or a new `lib/validate.mjs`); `resolveFlow`
  stays the interpreter's loader untouched until #116 replaces it. #112, #113 and #117 extend `VERTEX_FIELDS` and
  `resolveFlow` only." Same note on #107.
- **FR-2 — the `changes` Check kind — should fix.** ADR 0014 line 13, request 3.4 and the handoff list `changes`; #114
  builds only four kinds; no decision defines it (only Q3b names it). Either add it to #114 with its parameters, or add
  it to the Epic's Out of scope and amend the ADR line.
- **FR-3 — `with:` bindings — should fix.** The example binds template names on `pr-upsert` with
  `with: { report, red, green }` (`example-flow.md:27, 92, 117, 150, 174`); nothing builds it, and #106's shape lists
  no Action parameters. Add to #113: "`with: { <name>: <reference> }` on `pr-upsert` and `comment` binds template names
  to the Vertex's own outputs or `inputs` (W2); a template name with no binding and no gg-context meaning is an
  admission error." Add Action parameters to #106's shape line.
- **FR-4 — #118 and #68 — should fix.** #68 hands #118 the temporary-index commit, no-overwrite `update-ref`,
  verification and crash resumption, but #118 names only the layout, never-overwrite, `reset` and History item; the
  ADR 0011 verification rule and the ignored Protected Files/tests are in neither. Replace #118's second In-scope bullet
  with: "Rescue commits tracked, untracked and the ignored Protected Files and test files under `testPaths` through a
  temporary index (ADR 0011) to `refs/gg/rescue/<digest of the Action Marker>`, created only when absent; after the
  rescue a worktree that does not match the ref holds; then reset through the write-ahead `reset`; a History item
  naming the failure and the ref." Delete #68's conditional and "unless #118 added it" hedges. Nit: "Note this in that
  ticket" should name "the `gg work` ticket (request slice 6)".
- **FR-5 — #23 — should fix.** The `rescue` reservation for #68 is wrong twice (#118 builds it before the freeze; #68
  is not before #23). Replace with documenting `rescue` and the Rescue Ref output as #118 built them, and reserving
  #68's `crash` budget and retried-Attempt fields. "Hold Actions carry the `hold` Phase" becomes "carry the Action id
  `hold`". The Terminal Reason item's `rule` becomes the rule identity `{ table, row }`.
- **FR-6 — #110 — nit.** Six `golden:` cases, not five (`test/interpreter.test.mjs:38, 376, 470, 660, 684, 1154`).
- **FR-7 — #105 — nit.** `render.terminalComment` (`lib/render.mjs:177`, called at `interpreter.mjs:938`) is not in
  the ported list; port it as a shipped template (R11a).
- **FR-8 — #108 — nit.** `approvers` is undefined; make it a list of GitHub logins passed to the reader, with #119
  deciding where the Flow sets it.
- **FR-9 — #123 vs #23 — nit.** "does not run while #23 is in flight" is not encoded; block #123 by #23 or drop it.
- **FR-10 — #104 and #105 — nit.** Both edit `lib/briefs.mjs`; note a mechanical merge or block #105 by #104.
- **FR-11 — #116 — nit.** State what `lib/procedures.mjs` keeps and update its Layout row.
- **FR-12 — #120 — nit.** The repository's Layer exists, so `gg init` refuses it; merge by hand from a temp directory.
- **FR-13 — #119 — nit.** Add "Awaiting" to the Glossary line.

No findings in the serial chain's order against the code, in contradictions for #110–#115, #117, #121, #122, or in the
remaining cover-list items.

## Round 5b (the altered issues)

### Astra

- **FRB-1 — #23 — blocks.** "Hold Actions carry the Action id `hold`": a hold performs separate comment and label Actions (`lib/interpreter.mjs:935–954`), told apart today by ordinal, which #111 replaces with the Recovery Number; both would collide, and the comment's evidence could suppress the label write. Replacement: distinct stable ids (`hold-comment`, `hold-label`) with Recovery Number 0, distinct from fault and end reporting; golden traces and crash-resume tests prove completing one never completes another.
- **FRB-2 — #118, #68 — blocks.** Ignored files are "copied into the intent payload", but the done-check wants them to "survive in its Rescue Ref"; `add -A` does not add ignored untracked files. Replacement: explicitly add the selected ignored paths to the temporary index; persist the payload before effects; verify the ref and all rescued contents before reset; test retrieving an ignored test's bytes from the ref.
- **FRB-3 — #116 — should fix.** "whatever else in `lib/flow.mjs` the validator does not use" includes `writeResolved` (`lib/run.mjs:7,118`). Preserve it and its regression, or move it with every caller updated.
- **FRB-4 — #113, #106 — should fix.** "A template name with no binding and no gg-context meaning is an admission error" rejects the direct own-output and `inputs` references #105 and `example-flow.md:19–22` allow. Replacement: templates may name gg context, own outputs and declared inputs; `with` adds aliases; admission rejects anything else; #113 resolves, #106 validates, #116 enables it.
- **FRB-5 — #106, #107, #116, #117 — should fix.** Validator cases are still in `test/flow.test.mjs`; #106 assigns loader edits to #117, but #116 deletes the loader first and #117 depends on #116. Replacement: tests in `test/validate.test.mjs`; #112 and #113 adapt the interim loader; #116 replaces it; #117 uses the validator's resolved `maxVisits` and `exhausted`.
- **FRB-6 — #105, #121 — should fix.** The engine's end-comment template sits beside shipped Personas, which #121 deletes with "the template files". Keep it outside the defaults library; #121 retains it.
- **FRB-7 — #23 — should fix.** `rule` "is the rule identity `{ table, row }`" loses request 3.3's null for a hold; hold, abandonment and fault paths write null (`lib/interpreter.mjs:412,422,440`).

### Fable

Y1–Y15 applied correctly; every requirement of the original #68 is owned by exactly one of #68 and #118.

- **FB-1 — #106, #107, #116 — should fix.** Validator tests named in `test/flow.test.mjs`; move to `test/validate.test.mjs`. #116 should delete `resolveFlow` and its cases, and keep or move `writeResolved` (`lib/run.mjs:117`).
- **FB-2 — #112 — nit.** #112 never says it edits `resolveFlow`, and its agent-less `publish` fails `lib/flow.mjs:12`. Add it; #113 and #117 likewise for `VERTEX_FIELDS`.
- **FB-3 — #118 — nit.** No test for "a crash at each step resumes…", nor for the locked-file reset hold; #118's holds should name the Rescue Ref.
- **FB-4 — #106, #113 — nit.** Parameter list lacks `body`, `type` and the stop token's `comment`; #113's binding check needs templates only #116 loads.
- **FB-5 — #23 — nit.** `rule` is null for a hold, and fixed rows and the token fallback match no table row.
