<!-- Codex gpt-6-astra (effort high) design review round 2, 2026-10-21, unedited. -->

## Blocking Reviewed decisions at `486babf` against main at `bd60df9`. Proposed execution cou...
[codex] Turn completion inferred after the main thread finished and subagent work drained.
## Blocking

Reviewed decisions at `486babf` against main at `bd60df9`. Proposed execution counterexamples below are **design inferences**, not observed failures.

1. **R1b, R11d — Freshness must bind to the commit being published.**

   R11d compares Check evidence with the current worktree, but does not require that tree to equal the published commit. A publishing Check could generate or repair tracked source, pass on tree T1, and then push committed tree T0. Declared Commands are not enforced as read-only: [interpreter.mjs:716](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:716). Push selects the last recorded commit at [interpreter.mjs:791](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:791).

   **Fix:** require publishing evidence to match the exact target commit’s tree, and hold if the publishing Checks leave tracked changes. Preserve the target SHA and evidence through retries and reconciliation. This closes the gap between “fresh passing Checks” and “verified published work.”

2. **R1a/R1d, R8b — The analyser’s Check-run domain excludes legal executions.**

   R8b bounds a Check’s `runs` by its own recovery `max + 1`, but R1a reruns **every** Check after another Check’s recovery. Example: scope has no recovery; suite has `max: 1`. Scope passes, suite fails, recovery runs, and both rerun. Scope now has `runs: 2`, outside its declared analysis domain. A rule matching that reachable count could be incorrectly rejected as impossible.

   **Fix:** define `runs` as an execution count distinct from recovery-budget consumption. Derive its bound from every recovery that can rerun that Check—at most `1 + Σ recover.max` for this model—and use that domain consistently in R8 and the frozen signal. Round-one R8 is therefore only partly resolved.

3. **R9, R12e, R13d — The shipped Flow contradicts its routing and input contracts.**

   R9 emits `replan` for `blocked` with `reason: misscoped`. Every shipped agent Vertex sends that Outcome through `"*"` to `needs-human`; reviewer’s explicit `misscoped` route names the wrong Outcome. Thus a misscoped first red Visit never requests replanning.

   The fix Procedure also declares `tests: named: inputs.findings`, but that input contains finding objects, not the string list R13d requires. Main confirms the object shape at [briefs.mjs:30](C:/dev/projects/grey-goo-ri/lib/briefs.mjs:30); senior uses the same Procedure.

   **Fix:** add `replan: { end: needs-replan }` to every shipped agent Vertex. Preserve full findings for Briefs, add a separate `testFiles` input using `pick: file`, and reference it from `tests: named`.

## Should change

1. **Q7, S4, R12e — Specify how reviewer selects the latest implementation evidence.**

   Reviewer declares no inputs, although its Brief needs the implementation report and captured red/green evidence. Main currently supplies those through special output slots at [interpreter.mjs:604](C:/dev/projects/grey-goo-ri/lib/interpreter.mjs:604), and [briefs.mjs:172](C:/dev/projects/grey-goo-ri/lib/briefs.mjs:172) consumes them.

   **Design inference:** a single `from: green…` would become stale after fix or senior; requiring either fix producer fails on the first review. **Fix:** specify the generic selection mechanism across green/fix/senior and declare the corresponding reviewer inputs. S4 defines latest production within one producer, but does not select among producers.

2. **R14a, R12 — The failed-table fallback still lacks a defined result.**

   R14a says an unmatched failed table falls to “the routing default,” but R12 defines routing for an existing Outcome; it does not define which Outcome this case produces, or the result when `"*"` is absent.

   **Fix:** explicitly choose either direct `end: needs-human`, or an engine-owned failure Outcome with that default and documented override precedence. Never reuse the successful Claim token. Owner question 2 is partly resolved: `then` and harness defaults are settled, this fallback is not.

3. **R7, R3e, reading guide — Correct the remaining misleading wording.**

   R7’s closing sentence says “no version bump” holds **after** the freeze, contradicting R7b’s requirement to bump after frozen-shape changes. R3e says test globs “plus the dependency directories,” whereas today dependency directories are **excluded** at [checks.mjs:79](C:/dev/projects/grey-goo-ri/lib/checks.mjs:79).

   **Fix:** state that pre-freeze changes keep the versions under the accepted disposable-state policy, while post-freeze shape changes require bumps; say “with dependency directories excluded.” The reading guide handles most superseded text, but these statements are inside the replacement decisions themselves.

## Resolved

- **Round-one R1:** rerunning all Checks and checking tree freshness resolve stale evidence after recovery; publication-target binding remains above.
- **Round-one R2:** one agent Action per Procedure removes multi-Phase Claim ambiguity; dropping cross-Vertex Session resume is explicit.
- **Round-one R3:** mandatory Test Immutability, declared test permissions, and a gg-owned moving baseline resolve omission and baseline ambiguity.
- **Round-one R4:** response reductions express review-pass; repeat comparison and bounded escalation are explicitly included.
- **Round-one R5:** rescue, write-ahead reset, provenance, and holding unproven changes settle failed-Vertex handoff policy.
- **Round-one R6:** Recovery Number distinguishes repeated executions and extends retry, settled-result, and event identity.
- **Round-one R7:** the owner explicitly accepts disposable pre-freeze state and no migration; this is resolved as a policy decision, subject to the wording correction above.
- **Round-one R8:** box subtraction and the logical-versus-runtime distinction resolve the algorithmic approach; the run-count domain remains blocking.
- **Owner question 1:** publishing uses its own required Checks rather than inheriting all earlier failed obligations; exact published-tree binding remains necessary.
- **Owner question 2:** explicit routes replace `then`, with defaults for harness Outcomes; unmatched failed-table handling remains partial.
- **Owner question 3:** repeat routing is expressly completed.
- **Owner question 4:** nested scalar paths, response-array Checks, and typed `pick` projections are settled.
- **Owner question 5:** pre-freeze upgrade handling is explicitly chosen under R7.
- **Owner question 6:** removal of `onFail` and `visits: all`, retention of useful stop/optional/harness routing, and shared evaluation/reference machinery are settled.
- **Main alignment:** the Agent rename and repository-only Declared Commands agree with current main and ADR 0013.
- **Flow bounds:** all Outcomes have catch-all coverage. Every shipped cycle crosses either a traversal-limited retest/changes edge or senior’s `maxVisits: 1`; existing request counting semantics make these bounds survive restart.
- **Flow progression:** red → green → reviewer, changes → red/fix, and repeat → senior are coherent. The identified replan and input errors prevent full behavioral equivalence.

## Ready to slice: no

Settle publication-target binding, the Check-run domain, evidence selection, and failed-table fallback; correct the shipped Flow. The remaining architecture is sufficiently decided—there is no need to reopen the accepted migration policy or deferred Option 3 scope.

No files were edited, tests run, or GitHub accessed. Runtime and crash behavior remain unverified.