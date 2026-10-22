# User-defined Procedures: handoff

State of the planning session on user-defined Procedures, Actions and Outcomes for gg, as of 2026-10-22, written so
a fresh session can continue without the conversation. Read this first, then the decisions file, then the example
Flow. The design is fully decided through four review rounds; the next step is slicing.

## Where things are

- **Branch** `research-user-procedures` in the worktree `C:\dev\worktrees\grey-goo-ri\research-user-procedures`,
  local only (not pushed), cut from main at ccfe163. It only adds files under `docs/research/`, so a rebase is
  trivial.
- **Files** in `docs/research/`:

  | File | What it is |
  |---|---|
  | `user-defined-procedures-handoff.md` | This document |
  | `user-defined-procedures-decisions.md` | **The authority.** Every decision, in the order made; its reading guide says which later decision amends which earlier one |
  | `user-defined-procedures-example-flow.md` | **The example Flow** `gg init` writes, in full: Agents, five Procedures with their tables, the Flow, what admission sees, and what changes from today |
  | `user-defined-procedures.md` | The vetted research and the three options (option 1 chosen) |
  | `user-defined-procedures-claude.md`, `-astra.md` | The two raw research tracks |
  | `user-defined-procedures-review.md` (+ `-astra`, `-fable`) | Round 1: R1–R8, S1–S7 |
  | `user-defined-procedures-review2.md` (+ `-astra`, `-fable`) | Round 2: T1–T14 |
  | `user-defined-procedures-review3.md` (+ `-astra`, `-fable`) | Round 3: U1–U15, including the grey-goo-ri issue #95 session's handoff (U13–U15) |
  | `user-defined-procedures-review4.md` (+ `-raw`) | Round 4: W1–W10, the last review before slicing |

- **Main** (`C:\dev\projects\grey-goo-ri`) is at bd60df9: grey-goo-ri PR #92 (Node renamed to Agent), PR #94 and
  PR #99 (Declared Commands in the repository Layer, ADR 0013) are merged. This design's ADR is **0014**. Reviewers
  read main from the worktree with `git show bd60df9:<path>` (Codex's sandbox cannot read the main checkout).
- **Related issues:** grey-goo-ri issue #23 (the freeze; waits for all of option 1), #68 (Interrupted Attempt rescue,
  ADR 0011; its Rescue Ref piece moves into this work, R5e), #89 (merge on done; option 3 era), #96 (faking a green
  run through what `test` delegates to; P4 is its option 1, U15), #97 (unaffected), #98 (backlog: scenario runs, V2).
- Nothing is running in the background.

## The model as decided now

This is the current state, consolidated. The decisions file has the history and the reasons; the example Flow shows
all of it in use.

**Scope and order.** Option 1 (Procedures as data over gg-owned Actions, with first-match rule tables) is built in
full **before** grey-goo-ri issue #23 freezes the record and Event schemas (Q8). Option 3 (user-defined Actions as
executables with `confirm`) comes after the freeze, into fields #23 reserves (D4).

**What gg ships and where config lives** (P1–P4, U13).
- gg ships **no default Flow and no library** of Procedures, Briefs, Personas or schemas. gg's code holds only its
  Actions, Check kinds and fixed integrity rows. `gg init` writes the example (Flow, Agents, Procedures, Briefs,
  Personas, schemas) into the repository, which then owns it. Without a Flow, preflight and `gg doctor` fail, naming
  `gg init`.
- `flows`, `procedures`, `commands` and `testPaths` may be declared **only in the repository Layer**
  (`<repo>/.agents/gg/gg.json`); in the defaults or user Layer (`~/.agents/gg/gg.json`) they are a load error. The
  user Layer keeps per-person settings such as an Agent's harness, model and effort.
- `testPaths` is **required**, like `commands.test`; `gg init` writes today's `DEFAULT_TEST_GLOBS`. One pinned value
  feeds every consumer (U9), replacing `events.diffStats`' own regex.
- Procedures, Checks and gates name Declared Commands, never command lines; the validator errors on an undeclared one.

**Agents, Vertices, Procedures.**
- An **Agent** is a reusable agent declaration (Persona, tools, access; harness, model and effort from the user
  Layer). A **Vertex** is a placement in a Flow that uses an Agent and one Procedure and routes its Outcomes.
- A **Procedure** has at most one agent step (R2). Zero agent steps is a deterministic Vertex (`publish`).
  Multi-step work is composed from Vertices; Sessions never cross Vertices. No name is special (D3).
- A Procedure declares `tests: frozen | named: <input> | write` (R3b), may declare `access: read-only`, which caps its
  Agent (U12), and declares `recover: { max, brief }` (W1). A variant is a second Procedure; no Vertex overrides a
  Procedure (U7, W1).

**Claims and Checks.**
- Each Claim token is `{ requires: [<check ids>] }` or `{ stop: true }`. The example's stop token is `blocked`, with
  a `reason` (`none | misscoped | needs-input | environment`, plus `no-test-needed` in the red schema) and a
  `diagnosis` (R9, U3, U11).
- A **Check** has an id, a kind, parameters, an optional `recoverBrief` and `recoverable: false`. Kinds: `command`,
  `tests-fail`, `changes`, `response` (with `all-of`, P5d), `repeat`. State `passed | failed | not-run`, with the
  tree it checked; a Check must leave the tree unchanged (T1b). The Check-to-command binding is data (U14).
- **Recovery** (T4, W1): one budget per Visit. After a pass in which a required Check failed recoverably, the
  agent's Session resumes with the Procedure's `brief` plus every failing Check's section, then every Check runs
  again. `pass` is matchable in rules.
- **Integrity Assertions** are gg's fixed rows after every agent Attempt, never switchable, recoverable or routable:
  Protected Files, read-only enforcement, Test Immutability over `testPaths` (Q2, R3).

**Deciding the Outcome**, once per Visit (Q3d, R14, S3, T7):
1. gg's fixed rows: integrity, harness failure (`harness-*` Outcomes, routable, default `end: needs-human`), parse.
2. A `stop` token: the `stopped` table, else the token.
3. Every required Check passed, fresh? Yes: `passed` table, else `otherwise`, else the token. No: `failed` table,
   else `otherwise`, else the engine Outcome `failed`.
- Rules are first match over enum, boolean and integer fields; admission computes unreachable rows (errors) and
  partial overlaps (warnings) exactly (R8). An absent optional input is the value `absent` (T10).

**Data between Vertices** (Q7, S4, T6, U1, W2, W3).
- References are `<vertex>.<action id>.<field>`, an agent Action's output being `response`; a Vertex's own outputs
  omit the Vertex; `<vertex>.rescue` is `{ ref, diffStat, output }` when R5a rescued it. `from:` may be a list (the
  latest Visit across it wins). Inputs are `optional` or required, with `pick`, checked per Outcome at admission.
- Briefs and templates read gg's own context only when they name it, never inserted (the Ticket, base, diff,
  commands, History, provenance, marker, changed test files; the Terminal Reason and end in stop templates), the
  Vertex's own outputs, and `inputs`.

**Effects, publishing and ends.**
- A commit runs only on fresh required Checks; every passing write path commits (S2, T1c); nothing to commit is a
  no-op (U2). `pr-upsert` creates a draft and never changes draft state (W4); `comment` takes `target: pr | ticket`
  (W5). Publishing (`pr-ready`) runs only in a Vertex requiring a Check, on that Check's tree (R11d, T1a).
- A failed or stopped write Vertex whose **effective** target is another Vertex rescues to a Rescue Ref and resets;
  one ending at an end leaves the work in place, red included (R5, U5, U10).
- Ends are `ready-for-qa | needs-human | needs-replan` (R11). A Flow's default `routes` are inherited (T3). A stop
  template replaces the end comment and goes to the Ticket, and to the Epic at `needs-replan` (U6, W9).
- Back edges carry `max` and `exhausted`; Vertices `maxVisits`; the Ticket an Action Cap (`maxVisits` and the Cap are
  not on main, T5).

**Identity, versions, validation.** The marker is `gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>`
(R6, S1). No version bumps before the freeze, no migration code for now (R7). One validator for `gg doctor` and
admission (V1).

## Open, in the order to take them

1. **Slicing (step 7)**, which the owner asked to start in a fresh session. The round-1 S1–S6 proposal is out of date.
   Slices must cover:
   - Procedures as data with Vertex-composed red/green; one-agent-step Procedures.
   - Recovery per Visit (T4, W1).
   - Test Immutability with a required `testPaths` through every consumer (P4, U9).
   - The `response` (`all-of`) and `repeat` Check kinds; the rule tables and their analysis (R8).
   - The engine `failed` Outcome, and removing `gate-failed`/`CHECK_NAMES` (T7, U14).
   - The Rescue Ref piece of #68 with the effective-target rule (R5, U5, W3).
   - End states and the `publish` Vertex; Flow default routes; stop templates and end comments (U6, W9).
   - `maxVisits` and the Action Cap (T5).
   - Inputs with lists, `pick`, `absent`, and gg context (T6, T10, U1, W2).
   - Templates for Briefs, the PR body and comments (`with:`, `target`), replacing `render.*` and `briefs.*` builders.
   - Repository-Layer-only `flows`/`procedures` and asset loading (P2, P3).
   - A working `gg init` and `gg doctor` writing the example, before the defaults Layer loses `agents` and `flows`
     (U8). Name the tests that load the shipped Flow, and give this repository its own config.
   - The validator, including named commands (U13), and the deferred `ajv` decision.
   Keep S7's rules: one interpreter-touching ticket in flight, and each slice names its golden traces, glossary
   entries and `gg doctor` output. File as an Epic with sub-issues, with the owner's go-ahead; mark #23 blocked by
   the last option 1 slice.
2. **ADR 0014** ("Procedures are data"). It amends request sections 2, 3.3, 3.4 and 3.6 and ADR 0004. It records:
   - no default Flow (P1);
   - repository Layer only (P2);
   - `testPaths` required (P4), with #96's `package.json` limit (U15);
   - the tree-fingerprint limit (R1).
3. **Glossary changes** with their slices: Action id and Action identity, Recovery Number, pass, publishing Action,
   end state, Vertex input, Rescue Ref output, Claim token `requires`, Confirmation (option 3).
4. **grey-goo-ri issue #23 additions** (S6, T4f): the Check signal `{ id, kind, state, tree }`, rule identity
   `{ table, row }`, inputs snapshot, Recovery Number, definition hash, Rescue Ref output, the Event without
   `requireTestPass`/`repeat`/`exhausted`, unknown `intent.action` holds, `record.md` worked examples.
5. **Revisit migration** of old records (R7d), when the owner wants to.

## How the session worked

- One question or small group at a time, each with a recommendation; the owner accepts, adjusts or rejects, and the
  decision is recorded in the decisions file and committed on the branch (no push) before moving on.
- Reviews ran as two independent read-only reviewers from one brief: Codex `gpt-6-astra` at high effort (through the
  codex-rescue agent, `--wait`) and Fable at high effort; their findings were merged, checked against main, and
  brought back with recommendations.
- The owner prefers nothing silently defaulted for what a repository configures, and is wary of context bloat in
  agent prompts.
- GitHub numbers are written "grey-goo-ri issue #N" or "grey-goo-ri PR #N". Pushing, PRs, issue comments and new
  issues need the owner's go-ahead.
