# User-defined Procedures: review round 6, raw reviews

The two independent reviews of all 25 issues (the Epic issue #101, issues #102–#123, #23 and #68), 2026-10-22,
condensed from their reports; the reviewers did not read earlier reviews. [Merged](user-defined-procedures-review6.md).

## Astra (gpt-6-astra, high, fresh)

- **IR1 — #108, #119 — should fix.** The optional approver list has no configuration owner: #108 delegates "where a
  Flow sets it" to #119, whose scope defines only `decisions`, request writes, consumption and label checks; #106's
  shape omits `approvers`; request 3.5 accepts write permission or "the optional `approvers` list"
  (`node-harness-dag.md:413-414`). Proposed: `flows.<name>.approvers`, an array of GitHub logins, omission meaning
  empty, validated, pinned in the Config Hash, passed to #108's reader; tests for a listed actor below write, an
  unlisted one, and malformed config.
- **IR2 — #101, #68, #119, #23, #123 — should fix.** #68 is blocked only by #118, so it can run beside #119, #23 or
  #123, all touching admission or Reconciliation (`lib/run.mjs:305`, `lib/reconcile.mjs:189-205`,
  `lib/interpreter.mjs:603-645`), and change recovery fields while #23 freezes them. Proposed: #68 blocked by #123.
- **IR3 — #23 — should fix.** "the key set of `createExecution(...)`" cannot verify every persisted field:
  `admission` (`lib/run.mjs:278`), `visitState` (`lib/interpreter.mjs:485`), `terminalReason`, `terminalStop`
  (`:388-389`) are added later. Proposed: distinguish fresh from persisted fields; representative persisted records
  (admission, Visit, recovery, approval, rescue, hold, fault, abandonment, completion) whose union has no undocumented
  field; the same for the Epic Record.

No findings in the interpreter sequence, validator/loader split, template ownership, Checks and recovery, publishing,
inputs, routing, the #118/#68 split, or the freeze's markers, Action ids and Terminal Reason.

## Fable (fresh)

- **Z1 (B) — #119, #106, #107.** Nobody validates `decisions` (#106 puts them out of scope, #107 never mentions them)
  and nobody creates the Await and Decide Labels (`ensureLabels`, `lib/github.mjs:47-62`, makes State Labels only).
  Proposed: #119 extends the validator; labels listed in the Resolved Flow, created by `ensureLabels`, missing ones
  reported by `gg doctor`; `gh` verbs for timeline events and collaborator permission.
- **Z2 (B) — #117.** The Action Cap has no key anywhere; proposed `actionCap`, a required positive integer on the Flow,
  example value 40, owner to choose.
- **Z3 (S) — #104, #106, #107, #120.** The example's schemas, Briefs and Personas exist nowhere; the example-flow doc
  only names them. Proposed: #104 writes the three schemas as fixtures from today's constants plus the decided
  changes; #120 names its Brief and Persona sources.
- **Z4 (S) — #23.** Items that change shapes inside a no-behaviour-change ticket, mostly without an Epic owner:
  `rule` as `{ table, row }` (today `r.row`, `lib/interpreter.mjs:307, 547`) to #115; unknown `intent.action` holds
  (`lib/reconcile.mjs:140`) to #118; the Procedure definition hash to #116; the `exhausted` field
  (`lib/interpreter.mjs:672`) to #117; `owner` beside the unchanged `ticket`.
- **Z5 (S) — #111, #23.** The abandonment report (`terminalAt`, phase `abandoned`, label only) and the corrupt-record
  hold (`lib/run.mjs:251`) have no Action id; `terminalReason.decidedBy` should key on `action` and `recovery`.
- **Z6 (S) — #114.** U2 (no changed test file is a non-recoverable `tests-fail` failure; an empty commit is a no-op
  with `files: []`) is built by no ticket.
- **Z7 (S) — #106.** R11f's implicit Claim `ok` of an agentless Procedure is in neither #106 nor #107.
- **Z8 (N) — #119.** "Awaiting" competes with the glossary's "Pending".
- **Z9 (N) — #105.** W6's stop-template change is unnamed under the byte-identical rule.
- **Z10 (N) — #112.** Preflight, `harnessOf` and `runVisit` read the Agent of every Vertex (`lib/run.mjs:58-61`,
  `lib/interpreter.mjs:331, 464`).
- **Z11 (N) — #68.** Admission's `dirtyState` (`lib/run.mjs:305`) holds an open `call` intent (`asRecorded`,
  `lib/reconcile.mjs:49-54`) before #68's path runs.
- **Z12 (N).** #103 should name `lib/rules.mjs`; #122's lines are 109-114; #120 should drop `flow`; #113's `from` has
  a trailing dotted path; #23's `createExecution` key test misses later fields.

No findings in the order and links, the cited facts, the #118/#68 split, or the consistency of #110–#116 with ADR 0014
and the example.
