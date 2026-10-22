# User-defined Procedures: handoff

State of the planning session on user-defined Procedures, Actions and Outcomes for gg, as of 2026-10-21, written so
a fresh session can continue without the conversation. Read this first, then the decisions file.

## Where things are

- **Branch** `research-user-procedures` in the worktree `C:\dev\worktrees\grey-goo-ri\research-user-procedures`,
  local only (not pushed), cut from main at ccfe163. Head at the time of writing: 103d950 plus this file.
- **Files** in `docs/research/`:

  | File | What it is |
  |---|---|
  | `user-defined-procedures-handoff.md` | This document |
  | `user-defined-procedures-decisions.md` | **The authority.** Every decision, in the order made; its reading guide says which later decision amends which earlier one |
  | `user-defined-procedures.md` | The vetted research and the three options (option 1 chosen) |
  | `user-defined-procedures-claude.md`, `-astra.md` | The two raw research tracks |
  | `user-defined-procedures-review.md` | Round-1 design review, merged (findings R1–R8, should-change S1–S7) |
  | `user-defined-procedures-review-astra.md`, `-review-fable.md` | Round-1 raw reviews |
  | `user-defined-procedures-review2.md` | Round-2 review, merged (findings T1–T14) |
  | `user-defined-procedures-review2-astra.md`, `-review2-fable.md` | Round-2 raw reviews |

- **Main** (`C:\dev\projects\grey-goo-ri`) has moved since the branch was cut: grey-goo-ri PR #92 (Node renamed to
  Agent, closes issue #91), PR #94 (gg's lines name their repository, issue #93) and PR #99 (Declared Commands come
  from the repository Layer's `commands`, ADR 0013, issue #95) are merged. This design's ADR is therefore **0014**.
  The branch has not been rebased; it only adds files under `docs/research/`, so a rebase is trivial.
- **Related issues:** grey-goo-ri issue #23 (the freeze; waits for all of option 1), #68 (Interrupted Attempt rescue;
  its Rescue Ref piece moves into this work, R5e), #89 (merge on done; becomes an `irreversible` effect in a
  publishing Vertex, option 3 era), #98 (backlog: scenario runs, V2).
- Nothing is running in the background.

## The model as decided now

This is the current state, consolidated. The decisions file has the history and the reasons.

**Scope and order.** Option 1 (Procedures as data over gg-owned Actions), with decision-table rules folded in, is
built in full **before** grey-goo-ri issue #23 freezes the record and Event schemas (Q8). Option 3 (user-defined
Actions as executables with `confirm`) comes after the freeze, into fields #23 reserves. Users can define Procedures
from gg's own Actions until then; use cases b, c and f (merge, deploy preview, notify) wait for option 3 (D4).

**Agents, Vertices, Procedures.**
- An **Agent** is a reusable agent declaration (harness, model, effort, Persona, tools, access). A **Vertex** is a
  placement in a Flow that uses an Agent and one Procedure and routes its Outcomes.
- A **Procedure** has **at most one agent step**, plus Vertex-level recovery. Zero agent steps makes a deterministic
  Vertex (a gate, `publish`). Multi-step work is **composed from Vertices** (R2); Sessions never cross Vertices.
- No Procedure or Phase name is special (D3). The shipped ones are ordinary defaults-Layer data. Rule tables belong
  to the Procedure; a later Layer replaces a table whole (R10).
- `tests: frozen | named: <input> | write` declares how much a Procedure may touch tests, default `frozen` (R3b).

**Claims and Checks.**
- Each Claim token is `{ requires: [<check ids>] }` or `{ stop: true }`. The shipped stop token is `blocked`, with a
  `reason` (`misscoped | needs-input | environment`) and a `diagnosis` (R9).
- A **Check** has an id, a kind, parameters, an optional `recoverBrief` and `recoverable: false`. Option 1 kinds:
  `command` (a Declared Command from the repository Layer), `tests-fail`, `changes`, `response` (conditions over the
  agent's recorded response, including `none`/`any`/`all`/`count` over arrays, R4), `repeat` (findings compared
  with earlier reviews by the same Vertex). Its state is `passed`, `failed` or `not-run`, with the tree it checked;
  a Check must leave the tree unchanged (T1b).
- **Recovery** is per Vertex: `recover: { max, brief }`. After a pass in which a required Check failed recoverably,
  the agent's Session resumes with the Vertex's frame plus every failing Check's section, then every Check runs again.
  `pass` (Recovery Number + 1) runs from 1 to 1 + `max` and is matchable in rules (T4, R1).
- **Integrity Assertions** are gg's fixed rows after every agent Attempt, never switchable, recoverable or routable:
  Protected Files, read-only enforcement, and **Test Immutability** against a gg-kept baseline (the last gg commit),
  over the repository Layer's `testPaths` (default in code) (Q2, R3).

**Deciding the Outcome** (Q3d, R12, R14), once per Visit:
1. gg's fixed rows: integrity, harness failure (timeout, transient, unparsed become routable `harness-*` Outcomes,
   default `end: needs-human`; run-stop classes stop the Run), parse.
2. A `stop` token: the `stopped` table, else the token.
3. Did every Check the claimed token requires pass, fresh? Yes: the `passed` table, else `otherwise`, else the token.
   No: the `failed` table, else `otherwise`, else the routing default (T7, on hold, proposes an engine `failed`
   Outcome). After a final required failure, the remaining Checks still run; later work is skipped.
- Rules are first match over enum, boolean and integer fields (gg facts, Claim tokens, typed response fields through
  dotted paths, matchable inputs, `pass`), integers against constants only. Admission computes, exactly, rules that
  are unreachable or never fire (errors) and partial overlaps (warnings with an example), by box subtraction, with a
  brute-force cross-check in tests (Q4, R8, R13).

**Effects and publishing.**
- A commit runs only when every Check the claimed token requires passed and is fresh; every passing path of a write
  Vertex must commit (S2, T1c, R2d). A write Vertex starts only on a clean worktree, or one gg's records explain.
- A failed or stopped write Vertex routing to another Vertex rescues its work to a Rescue Ref and resets (ADR 0011
  layout); routing to an end leaves the work in place (R5).
- `implement` and `fix` push and keep a draft PR (T2). **Publishing Actions** (`pr-ready`, later merge) run only in a
  Vertex that requires at least one Check, when each required Check's tree equals the tree of the commit being
  published and the worktree is clean (R11d, T1a). Every path to `end: ready-for-qa` must run `pr-ready` (R11e).

**Routing and ends.**
- A Vertex routes each Outcome to a Vertex or to `end: ready-for-qa | needs-human | needs-replan` (the existing State
  Labels, a fixed set) (R11). `then` is gone (R12a). A Flow declares default `routes` every Vertex inherits; the
  shipped defaults are `misscoped: { end: needs-replan }` and `"*": { end: needs-human }` (T3). Every Outcome a
  Vertex can produce must be routed by the Vertex or the Flow (R12b).
- Back edges carry `max` and `exhausted`; Vertices carry `maxVisits`; the Ticket has an Action Cap. `maxVisits` and
  the Action Cap are **not on main** and are built before #23 (T5).
- Data between Vertices goes through explicit `inputs` (`from`, `optional`, `pick`), checked per Outcome at
  admission, snapshotted with provenance at Visit entry; `latest` is the latest Visit that produced the value (Q7,
  S4, R13).

**Identity and versions.** An Action's identity is execution, Vertex, Visit, **Action id**, Recovery Number, Run and
Attempt; the marker is `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>` (R6, S1). No version
bumps before the freeze and no migration code for now (R7; the owner will revisit migration).

**Validation.** One validator, shared by `gg doctor` and admission, checks everything decidable from the definition;
only runtime facts are runtime errors (V1). Scenario runs are backlogged (V2, grey-goo-ri issue #98).

**The shipped Flow** is in the decisions file, R12e: `red → green → reviewer → publish → end: ready-for-qa`, with
`retest → red` and `changes → implementer-fix` loops (`max: 2`, exhausted to `senior-dev`), `repeat → senior-dev`,
and `senior-dev` (`maxVisits: 1`). It must be updated for T1–T5 (draft PR in `implement`/`fix`, Flow default routes,
`max: 1` on `repeat`) and T8/T9 when those are accepted.

## Open, in the order to take them

1. **Round-2 items on hold, with the recommendations given:**
   - T6: `from:` accepts a list (latest by Visit order across it), for the reviewer's and the PR body's
     "latest implementation report" from `green`, `implementer-fix` or `senior-dev`.
   - T7: an unmatched `failed` table produces an engine Outcome `failed`, routable, default `end: needs-human`.
   - T8: `tests: named` uses a `testFiles` input with `pick: file`.
   - T9: route `implementer-fix`'s failures to `senior-dev`, making its `previous` (rescued work) input real.
   - T10: `absent` is a value in the rule domain for `optional` inputs.
   - T11: drop Q1's read-only warning (R11d guards publishing).
   - T12: `testPaths`' default lives in code (ADR 0013 lets only the repository Layer set it).
   - T13: write the shipped `failed` and `stopped` tables out in full, including review's `review-pass failed →
     changes`.
   - T14: wording fixes (R7's closing sentence; R3e's dependency directories are excluded, `checks.mjs:79`; R12b's
     `onFail`; S7's `session` field now applies only to recovery; Action ids also forbid whitespace) and the reading
     guide.
2. **Rewrite the shipped Flow and its tables in full** with every accepted change.
3. **A short round-3 review** of the shipped Flow and the decisions changed since round 2, by the same reviewers.
4. **Slicing (step 7).** The S1–S6 proposal in the round-1 review is out of date. It must now also cover: Vertex-level
   recovery; Test Immutability in the fixed row with `testPaths`; the `response` and `repeat` kinds; the Rescue Ref
   piece of #68; end states and the `publish` Vertex; Flow default routes; `maxVisits` and the Action Cap; the
   validator with the rule analysis and the deferred `ajv` decision. Keep S7's rules: one interpreter-touching
   ticket in flight, each slice names its golden traces, glossary entries and `gg doctor` output. File as an Epic
   with sub-issues; mark #23 blocked by the last option 1 slice.
5. **ADR 0014** ("Procedures are data"): amends request sections 2 ("Work is code"), 3.3 (Terminals become end
   states; publishing is an Action), 3.4 (Procedures are code; blocked and misscoped defaults) and ADR 0004
   (acceptance follows the claimed token's `requires`; stops are routable); notes the tree-fingerprint limit
   (ignored files, R1).
6. **Glossary changes** with their slices: Agent (done), Action id and Action identity, Recovery Number, pass,
   publishing Action, end state, Vertex input, Confirmation (option 3), Claim token `requires`.
7. **grey-goo-ri issue #23 additions** (S6, T4f): the Check signal `{ id, kind, state, tree }`, rule identity
   `{ table, row }`, inputs snapshot, Recovery Number, definition hash, Rescue Ref output, the Event without
   `requireTestPass`/`repeat`/`exhausted`, unknown `intent.action` holds, `record.md` worked examples.
8. **Revisit migration** of old records (R7d), when the owner wants to.

## How the session worked

- One question or small group at a time, each with a recommendation; the owner accepts, adjusts or rejects, and the
  decision is recorded in the decisions file and committed on the branch (no push) before moving on.
- Reviews ran as two independent read-only reviewers from one brief: Codex `gpt-6-astra` at high effort (through the
  codex-rescue agent, `--wait`) and Fable at high effort; their findings were merged, checked against main, and
  brought back as Blocking, Should change and questions.
- GitHub numbers are written "grey-goo-ri issue #N" or "grey-goo-ri PR #N". Pushing, PRs, issue comments and new
  issues need the owner's go-ahead.
