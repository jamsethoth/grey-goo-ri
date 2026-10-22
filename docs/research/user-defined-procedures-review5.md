# User-defined Procedures: review round 5, the filed Epic, merged

A review of the filed Epic (grey-goo-ri issue #101), its tickets (issues #102–#123), and the edits to issues #23 and #68.
Astra (gpt-6-astra, high) and Fable reviewed them on 2026-10-22 from one brief, against an export of the issues. Their
reports are in [the raw reviews](user-defined-procedures-review5-raw.md). Each finding below was checked against main
at 30bcf99.

Both reviewers found the filing faithful: every body matches its draft after the id substitution, every blocked-by
link matches its "Depends on" line, and all 22 tickets are sub-issues of the Epic. Fable also found the cited code
lines accurate. The pre-rewrite text of issue #68 was not in the export; this merge checked the rewrite against it.

## Should fix before `ff run`

- **Y1. Rescue scope falls between issues #118 and #68 (Astra FR-1, Fable FR-4).** Issue #68's Out of scope hands
  issue #118 the temporary-index commit, the no-overwrite `update-ref`, verification and crash resumption. Issue
  #118's scope names only the ref layout, never-overwrite, the write-ahead `reset` and a History item. The old #68 also
  verified the ref and the reset ("else hold") and kept ignored Protected Files and tests. Today `restoreUntracked`
  (`lib/integrity.mjs:146-157`) removes or overwrites ignored test files, so without this a failed `tests: write`
  Vertex loses ignored test changes. Recommendation: issue #118 owns the whole mechanism:
  - it commits tracked, untracked, and ignored Protected Files and `testPaths` files through a temporary index;
  - it creates the ref only when absent, verifies the ref against the worktree, and holds on a mismatch;
  - it resets, verifies the worktree against the baseline, and holds on a mismatch;
  - it retries `fs.rm` on Windows EBUSY and EPERM, and resumes after a crash at each step.

  Issue #68 drops its "if #118 does not yet…" hedges and names the `gg work` ticket (request slice 6) for ref cleanup.
- **Y2. Two existing items in issue #23 are stale (Astra FR-2, Fable FR-5).**
  - The item that reserves `rescue` for #68 is outdated, because issue #118 builds `rescue` before the freeze. It
    becomes: document the `rescue` Action and the Rescue Ref output as #118 built them, and reserve #68's `crash`
    retry budget and retried-Attempt fields.
  - "Hold Actions carry the `hold` Phase" becomes "carry the Action id `hold`" (issue #111 removes Phases).
  - The Terminal Reason item says its `rule` is the new rule identity `{ table, row }`.
- **Y3. The generic Execution owner (issue #23) must cover Action Events (Astra FR-6).** `ticket` is required in
  `ACTION_REQUIRED` (`lib/events.mjs:30-33`), and unknown fields are rejected (`:23-27`). The item becomes: "in the
  Execution Record and every Execution-scoped Event: Action Events, `ticket_start`, `ticket_end`".
- **Y4. Issue #122's standalone test cannot be reached (Astra FR-3).** X2d makes a non-null `plan` a validation
  error, so the standalone rejection (`lib/run.mjs:105-114`) never fires. Recommendation: drop that bullet and its test
  from issue #122. Instead, update the `shortcut:` comment at `lib/run.mjs:110` to say that its advice names `--flow`
  once request slice 7 allows a non-null `plan`.
- **Y5. The parallel validator tickets and serial engine tickets share `lib/flow.mjs` (Fable FR-1, Astra FR-4).**
  `resolveFlow` is the live loader (`VERTEX_FIELDS`, `lib/flow.mjs:5`), and it requires an Agent (`:12`). Issues
  #112 (`then`, an agent-less `publish`), #113 (`inputs`) and #117 (`maxVisits`) must change it.
  - Recommendation: issues #106 and #107 build the validator as a separate entry point in a new module
    (`lib/validate.mjs`, added to the Layout table), and leave `resolveFlow` alone. Issue #116 switches admission to the
    validator. This keeps the validator parallel. Astra's alternative, blocking #106 on #112, would put the validator
    behind E3.
  - Issues #104 and #105 both edit `lib/briefs.mjs`, so mark issue #105 blocked by #104 as well (issue #104 has no
    dependencies, so this costs nothing).
- **Y6. No ticket builds the `changes` Check kind (both).** ADR 0014 (line 13) and the request list it, but only Q3b
  names it: it has no decided parameters, and the example Flow does not use it. The owner decides: defer it (the
  Epic's Out of scope gains it, and ADR 0014's line says "named, built later"), or build it in issue #114 with its
  contract written into the ticket first. Recommendation: defer.
- **Y7. No ticket builds `with:` bindings (Fable FR-3).** The example binds the PR body's template names on every
  `pr-upsert` (`example-flow.md:92, 117, 150, 174`). Recommendation:
  - Issue #113 gains: "`with: { <name>: <reference> }` on `pr-upsert` and `comment` binds template names to the
    Vertex's own outputs or `inputs` (W2)".
  - Issue #106's shape lists Action parameters (`brief`, `schema`, `command`, `with`, `target`, `decisions`,
    `recoverBrief`, `recoverable`).
- **Y8. Issue #109's test forbids the reporting it requires (Astra FR-7).** "Terminal reporting stays exempt"
  conflicts with "ends at needs-human with no GitHub write". The item becomes: "the queued effect, a push included, is
  not made; only the needs-human reporting writes", and the test name changes with it.

## Nits

- **Y9.** Issue #110: there are six `golden:` cases, not five (`test/interpreter.test.mjs:38, 376, 470, 660, 684, 1154`). (Fable FR-6)
- **Y10.** Issue #105: also port `render.terminalComment` (`lib/render.mjs:177`) as a gg-shipped template for ends without a stop token (R11a). (Fable FR-7)
- **Y11.** Issue #108: define `approvers` as a list of GitHub logins passed to the reader. Issue #119 decides where the Flow sets it. (Fable FR-8)
- **Y12.** Issue #123's "does not run while #23 is in flight" is not encoded as a dependency. Mark #123 blocked by #23, since cleanup after the freeze changes no shape. (Fable FR-9)
- **Y13.** Issue #116: say what `lib/procedures.mjs` keeps (the Action and Check kind definitions), and update its Layout row. (Fable FR-11)
- **Y14.** Issue #120: this repository's Layer already exists, so its Flow is merged by hand from `gg init`'s output in a temp directory. (Fable FR-12)
- **Y15.** Issue #119: add "Awaiting" to its Glossary line. (Fable FR-13)

## Round 5b: the altered issues

Astra and Fable re-reviewed the 16 altered issues on 2026-10-22 ([raw](user-defined-procedures-review5-raw.md)),
with issue #68's original text this time. Both found Y1–Y15 applied as recommended. They also found every
requirement of the original issue #68 owned by exactly one of issues #68 and #118. Each finding below was checked
against main.

- **Y16. Y5's split, finished (Fable FB-1, FB-2; Astra FRB-3, FRB-5).** Issues #106 and #107 name their tests in
  `test/flow.test.mjs`; they belong in `test/validate.test.mjs`. Issue #116's "whatever else in `lib/flow.mjs`" would
  delete `writeResolved`, which `gg run` uses (`lib/run.mjs:7, 118`). Issue #117 depends on #116, which deletes the
  loader, so it extends the validator's shape, not `resolveFlow`. Issues #112 and #113 do not say they adapt
  `resolveFlow` (#112's `publish` Vertex has no `use`, which `lib/flow.mjs:12` requires).
- **Y17. Ignored files belong in the Rescue Ref itself (Astra FRB-2, Fable FB-3).** Issue #118 copies ignored
  Protected Files and test files into the intent payload, but its done-check wants them in the Rescue Ref, and
  `add -A` skips ignored files. The original #68 had the same gap. Recommendation: force-add those paths to the
  temporary index, so `git show <ref>:<path>` holds their bytes. Also name the two untested done-checks
  (crash-resume, a locked file). #118's own holds name the Rescue Ref, as #68's do.
- **Y18. End reporting needs distinct Action ids (Astra FRB-1).** End reporting is a ticket comment, an Epic comment
  (replan) and a label (`lib/interpreter.mjs:935-954`), told apart today only by ordinal. Under issue #111's
  `<action>:<recovery>` identity, a single `hold` id would collide, and one Action's evidence would complete another.
  Recommendation: issue #111 gives each end reporting Action a fixed id (`end-comment`, `end-epic-comment`,
  `end-label`), and issue #23's item points to them.
- **Y19. `rule` is not always `{ table, row }` (both: FB-5, FRB-7).** Request 3.3 makes it null for a hold, and
  abandonment and faults write null (`lib/interpreter.mjs:412, 422, 440`). Recommendation: `{ table, row }` when a
  table row or one of gg's fixed rows decided (fixed rows under the table name `fixed`). Null for a hold, an
  abandonment or a fault.
- **Y20. Template names (Astra FRB-4, Fable FB-4).** Y7's "a template name with no binding … is an error" forbids
  the direct `{{test.evidence}}` references that issue #105 and the example allow. The check also needs templates,
  which only load in issue #116. Recommendation: a template may name gg context, the Vertex's own outputs and its
  `inputs`, plus `with` aliases. Admission rejects any other name, a check enabled in #116. Issue #106's parameter
  list gains `body`, `type` and the stop token's `comment`.
- **Y21. The Terminal Reason comment template must survive the defaults cutover (Astra FRB-6).** Issue #105 puts it
  beside the shipped Personas, and issue #121 deletes those along with "the template files". Recommendation: it is
  engine-owned and lives with gg's code (`lib/templates/`), and #121 keeps it.
