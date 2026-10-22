# User-defined Procedures: design review round 2, merged

Round-2 reviews of the decisions at 486babf, by the same reviewers, 2026-10-21:
[Astra](user-defined-procedures-review2-astra.md) and [Fable](user-defined-procedures-review2-fable.md). Both: **not
ready to slice**. Both confirm every round-1 finding and owner question is resolved or narrowed to the items below.
Checked against main at bd60df9.

## Blocking

**T1. The published commit must be the checked tree. (Both.)** R1b compares a Check's tree with the current worktree,
and R11d gates publishing on that, but `push` publishes the last recorded commit (`interpreter.mjs`,
`record.lastCommit`). A write Vertex with no commit Action (or a Check command that edits tracked files) can pass on
an uncommitted tree while an older commit is pushed and marked ready. Fix: (a) publishing Actions require the Check's
tree to equal the tree of the commit being published, and the worktree to be clean at that commit, else hold; (b) a
Check must leave the tree unchanged, or it fails with that reason (Fable S1: a formatter or a stray coverage
directory would otherwise stale every earlier Check); (c) admission requires a commit on every passing path of a
write Vertex, which makes R2d enforceable.

**T2. The draft PR disappeared from the shipped Flow. (Fable.)** R12e puts push and pr-upsert only in `publish`, but
the reviewer comments on the PR (`rec.pr`), which would not exist yet. Fix: `implement` and `fix` keep push and
pr-upsert (a draft) after their commit; only `pr-ready` and later merge are publishing Actions under R11d; `publish`
re-renders the body and marks the PR ready.

**T3. `misscoped` is routed only from the reviewer. (Both.)** R9's `misscoped` Outcome from `red`, `green`,
`implementer-fix` and `senior-dev` falls to `"*"` and ends at `needs-human`, losing the replan. Today every
implementer Phase's `misscoped` replans. Fix: every shipped agent Vertex routes `misscoped: { end: needs-replan }`,
and R9b names the Outcome `misscoped`, not the removed Terminal `replan`.

**T4. A Check's `runs` can exceed its own recovery bound. (Astra.)** R1a re-runs every Check after any recovery, so a
Check with no `recover` can run twice. R8b's domain (`1` to its own `max + 1`) would wrongly reject a rule matching
`runs: 2`. Fix: `runs` is bounded by `1 + Σ recover.max` over the Vertex's Checks, the same bound for every Check.

**T5. Bounds that the shipped Flow relies on are not built. (Fable; verified.)** Main has no Action Cap and no Vertex
`maxVisits`; I3 relies on both. In R12e, `repeat: senior-dev` has no edge bound, so reviewer → senior-dev → reviewer
is bounded only by `senior-dev`'s `maxVisits`. Fix: give `repeat` an edge bound (`max: 1`), and build `maxVisits` and
the Action Cap no later than the slice that ships the new Flow.

## Should change

- **T6. Inputs from several producers. (Both.)** The reviewer's Brief and the PR body need "the latest implementation
  report and Green Evidence", which may come from `green`, `implementer-fix` or `senior-dev`. Fix: `from:` accepts a
  list, taking the latest by Visit order across it.
- **T7. An unmatched `failed` table has no Outcome. (Astra.)** R14a falls to "the routing default", but routing needs
  an Outcome. Fix: an engine Outcome `failed`, routable, defaulting to `end: needs-human`; never the Claim token.
- **T8. `tests: named` needs a list of strings. (Both.)** R12e's `tests: named: inputs.findings` names finding
  objects. Fix: a `testFiles` input with `pick: file`.
- **T9. `senior-dev.previous` is never produced. (Fable.)** A rescue exists only when a failed Vertex routes to
  another Vertex, but `implementer-fix` routes failures to `needs-human`. Fix: route `implementer-fix`'s failures to
  `senior-dev` (escalation of a failed fix), so `previous` is meaningful; or drop the input.
- **T10. An absent `optional` input in a rule. (Fable.)** D4 holds on a missing input; an optional one is absent on
  purpose. Fix: `absent` is a value in the R8 domain for optional inputs.
- **T11. Q1's read-only warning fires on the shipped reviewer. (Fable.)** `changes: { requires: [] }` is intended.
  Fix: drop Q1's warning; R11d already guards publishing.
- **T12. Where `testPaths`' default lives. (Fable.)** ADR 0013 lets only the repository Layer set such keys, so the
  default globs live in code, not `defaults/gg.json`.
- **T13. Write the shipped tables out. (Fable.)** The `failed` and `stopped` tables of `review`, `implement`, `fix`
  and `publish` are prose only (R4b, R9b), including review's `review-pass failed → changes`.
- **T14. Wording.** R7's closing sentence (it should say versions stay fixed before the freeze and bump after it);
  R3e (dependency directories are **excluded**, `checks.mjs:79`); R12b still lists `onFail`; S7's `session` field
  now only applies to recovery Phases; R6d also forbids whitespace in Action ids (`marker.mjs:14`). Add the
  superseded names to the reading guide.

## Confirmed by both

All round-1 Blocking findings R1–R8 and owner questions 1–6 are resolved by R1–R14 and S1–S7, except the parts named
above (T1 narrows question 1, T4 narrows R8, T7 narrows question 2). The cycles red → green → reviewer → red and
reviewer → implementer-fix → reviewer are bounded by their edge `max`; the end states match today's labels; the
architecture needs no reopening.
