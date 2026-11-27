---
status: accepted
date: 2026-11-20
---

# An agent past its contextBudget hands off to a fresh Session in place of compaction

Amends request 3.1's `contextBudget` row and the frozen Execution Record (#23, `docs/interfaces/record.md`) for
grey-goo-ri issue #430, part of epic #421. Request 3.1 translated an Agent's `contextBudget` into the Harness's
compaction threshold. Compaction keeps a Session going but drops detail, and every request still costs its whole
context: #133's one implementer Session reached 645k tokens. The gg-ticket plugin's context-cap hook never compacts:
past a role's cap it asks the agent to wrap up with what remains, and a fresh agent takes the work on. The owner
decided planning's G17 B on 2026-11-16 and Clarify's Q1 to Q5 A on 2026-11-20.

1. **Past its budget an agent hands off, in place of compaction (G17 B).** gg's Claude settings file installs a
   PostToolUse hook for an Agent with a `contextBudget`. Once the latest request's context passes the budget, the hook
   asks the agent to finish with the hand-off Claim, again each further 40,000 tokens, as the plugin's hook does.
   `--autocompact` stays set at 125% of the budget as the backstop, and the Usage's `compactions` count still logs
   each compaction. The hook joins the settings file `launchArgs` builds, so the Claude launch profile's version bumps
   to 3 (ADR 0027).
2. **The hand-off is the agent's Claim (Q3 A, ADR 0004).** For an Agent with a `contextBudget`, gg sends the
   Procedure's schema widened with the Claim token `handed-off` and a required root string `handoff`, the note of what
   remains, empty unless it hands off. No Procedure changes; one that declares `handoff` or `handed-off` itself is
   refused (`reserved-handoff-name`). Read-only Agents hand off too, since the note rides in the answer.
3. **A new fixed row, `handed-off`, retries the Action in a fresh Session (Q2 A).** It follows the failure and parse
   rows, so an Integrity Violation, a run stop or a failed call decides first, and precedes `claimed`. It spends the
   retry kind `handoff`, 3 an Action by default; once spent, `handoff-exhausted` gives the engine Outcome
   `harness-handoff`, routable like the other `harness-*` Outcomes and ending at `needs-human` by default. Each
   hand-off is a new Attempt, so it also counts against the Action Cap.
4. **The next Attempt starts a fresh Session whose Brief carries the note**, after the Attempt's own Brief, in gg's
   `handoff.md` section, with the line that asks the handed-off Session. Its Action Event names that Session as its
   Session Lineage.
5. **The handed-off Session stays on the record, resumable but unused (Q4 A, G17).** The Action's session entry keeps
   naming the Session a resume or recovery pass takes, now the fresh one, and gains `handedOff`: each Session the
   Action handed off, oldest first, with its `sessionId`, `transcriptPath`, `cumulativeUsage` and the `attempt` that
   ran it.
6. **The new agent asks a handed-off Session through `gg ask-session` (Q1 A).** It questions a fork of the Session
   (`--resume` with `--fork-session`) read-only under the launch profile, prints the answer, and leaves the kept
   Session unchanged, so two questions never see each other. The command's allow rule joins the Agent's list once its
   Action has handed off. A question is not an Attempt: it counts against no budget, and its Usage stays off the
   record. Amended by ADR 0033 point 3 (#485): an agent whose Harness runs its commands in a sandbox is not offered
   it, since there the nested CLI cannot write its home.
7. **`gg doctor --probe` checks the hook under the real CLI (Q5 A, ADR 0028).** The launch profile's probe sets a tiny
   budget and fails when the hook does not fire. No recording shows a hook, so the owner runs the probe once before
   this merges.
8. **`RECORD_SCHEMA_VERSION` goes to 3** under ADR 0024's rule: the retry kind `handoff`, the fixed rows `handed-off`
   and `handoff-exhausted` and the `handedOff` list are saved, and a version 2 row, which holds none, still reads.
   The Epic Record shares the version. `EVENT_SCHEMA_VERSION` stays at 3, as in ADR 0027: no Event's declared shape
   changes, since an Action Event's `outcome`, `rule.row` and `sessionLineage` are strings already.

## Considered options

- Let the agent run `claude --resume` itself (Q1 B). Rejected: an allow rule matches by prefix, so the nested call
  could drop the profile's isolation, write, or resume without forking and change the kept Session.
- Only name the handed-off transcript in the fresh Brief (Q1 C). Rejected: G17 asked for a question to the old
  Session, and a transcript past the budget is costly to read whole.
- The Action Cap as the only bound (Q2 B). Rejected: a looping agent could spend the whole Cap on one Action, 180
  Attempts in this repository's Flow.
- The note in a file the hook names (Q3 B). Rejected: a read-only Agent cannot write it.
- One session entry per Attempt (Q4 B). Rejected: every lookup by the Action's key would change.
- A recording in this ticket (Q5 B) or no real check (Q5 C). Rejected: the first reverses planning's batch 1 Q4 A for
  one ticket, and the second leaves a hook the CLI ignores looking like compaction.

## Consequences

`contextBudget.byModel` stays for later (G9). Codex's hand-off is slice 3's, with Codex's launch; until then its
module declares no Capability for `contextBudget`. A Procedure's own schema never names the note, so every answer of
a budgeted Agent carries `"handoff": ""`. Codex's hand-off is ADR 0033's (#485).
