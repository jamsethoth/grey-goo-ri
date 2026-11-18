---
status: accepted
date: 2026-11-18
---

# The Harness contract for slice 2, and the rule for every version bump

Changes the frozen Harness contract (#23, `docs/interfaces/harness.md`), the Action Event (`events.md`) and the Execution
Record (`record.md`) once for request slice 2 (grey-goo-ri issue #422, part of epic #421). The Claude Harness (#425)
must receive and report what the contract had no slot for: no cancel, no previous Usage, no Run directory, no CLI
version or repository digest, a stored session id overwritten by every Attempt, and a fake whose key gave every recovery
pass the same Phase. The owner decided 1 to 8 on 2026-11-16 and Clarify's Q1 to Q4 on 2026-11-17.

1. **The signal travels beside the call.** `run(call, hooks)`'s `hooks` is `{ started, signal }`. gg copies the call
   for the Harness with `structuredClone`, which turns an `AbortSignal` into `{}`, so the signal cannot travel inside
   it. The signal is the Run's own, one for every call: `gg run` makes it when the Run starts, in the Run's state beside
   its run stop, which every Execution shares, and a caller of `runExecution` may hand in its own there (Q1 A). Nothing aborts it until #220 wires run stops
   and overrides to it. A cancelled call resolves `killed` and keeps the timed-out/killed Transition row for now; #220
   must give a cancel its own route (G3).
2. **The call gains `previousUsage` and `runDirectory`.** `previousUsage` is the Session's saved `cumulativeUsage` for
   a resumed call, null for a fresh one, so a Harness can report the call's share; `runDirectory` is
   `<common dir>/gg/runs/<run>`, where the persona file belongs (G16, request 3.2).
3. **The Harness Result gains `repositoryDigest`, `agentCliVersion`, `effectiveModel` and `effectiveEffort`**, each
   `string | null` and optional, carried to the agent Action Event. The Event's `agentCliVersion` is filled from the
   Result instead of always null; the other three are new agent fields.
4. **A resumed call never replaces the stored session id.** A fresh call stores its own id; a resumed call that
   reports another keeps the stored one, though its cumulative Usage is still saved, so the next resume's previous
   Usage is this call's. A retry still resumes the id the last Attempt reported (Q3 B), and a context hand-off's fresh
   Session (#430) becomes the stored one.
5. **The fake's scripting moves to version 2.** A script's failure is a `HarnessFailure`, its class under
   `failureClass` (the frozen `failure.kind` had no use). Its key is `<vertex>/<visit>/<action>/<recovery>/<attempt>`,
   the Action and the Recovery Number read from the call's Action Marker (Q2 A, G2), so two recovery passes of one
   Action take different scripts and the call real Harnesses receive gains no field for it.
6. **`resolveTools(agent, { commands, platform })` is the one declaration.** Preflight passes the repository's Declared
   Commands, the agent Action the Visit's pinned ones, and both `process.platform` (G13), since the Claude Harness must
   allow the Declared Commands (#411 item 3).
7. **The versions bump:** `FAKE_HARNESS_VERSION` 2, `EVENT_SCHEMA_VERSION` 3 and `RECORD_SCHEMA_VERSION` 2, the last
   because the Harness Result is saved in `visitState.call.harnessResult` and read by the closed reader (G1). The Epic
   Record shares `RECORD_SCHEMA_VERSION`, so it bumps too.
8. **The rule for this and every later bump:** a reader accepts the version before its own, and a field new in the
   bump is optional when absent (G1). The event reader reads a version 2 row without the three agent fields version 3
   added; the record reader reads a version 1 row, whose Harness Result lacks the four optional fields. Every record
   save writes the current version, whichever version it was read at, so a row's version always says which fields it
   may hold (Q4 A); an Event is written once, at the version of the gg that wrote it.

gg is not yet in use, so no record or event of the previous version exists (owner, 2026-11-17): the rule protects later
bumps, and the fixtures `test/fixtures/record-rows-version-1.json` and `test/fixtures/events-version-2.json` hold it.

## Considered options

- An optional signal that gg passes only from #220 (Q1 B). Rejected: the defect, a signal lost on gg's own call path,
  would stay untested until then, and every Harness would have to handle a missing signal.
- A third `run` argument for the signal. Rejected: #68 made the second argument the per-call hooks, and decision 1 names
  `{ signal }` as that object.
- `action` and `recovery` as call fields for the fake's key (Q2 B). Rejected: two more frozen fields every Harness
  receives and none uses.
- A retry that resumes the stored Session (Q3 A). Rejected: if a Harness forks the Session on resume, the retry would
  lose the failed Attempt's turns and pair one Session's total with another's.
- Keeping the version a record was read at (Q4 B). Rejected: a row labelled with the old version could hold the new
  fields, and every later reader would inherit that mix.
