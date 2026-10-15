---
status: accepted
date: 2026-10-15
---

# A write-ahead execution record per work item, with GitHub as the source of truth for human state

feature-flow held a ticket's position in process memory, so a crash lost it and an approval needed a running process to wait. gg keeps one persisted record per ticket and per epic, written before and after every action with a side effect: the intent and its payload first, then the effect's evidence, then completion. Recovery recognises effects by an action marker carried in commit trailers, pull request bodies and comments, never by mere existence. The split of authority is fixed: GitHub labels and events decide whether a work item runs and what humans decided; the record decides where the machine continues. When they disagree, GitHub wins and the record is marked abandoned.

## Considered options

- Defer persistence to a later version and keep the in-memory loop. Rejected: approvals, crash recovery, cross-process usage deltas and the work listing all need the record, and retrofitting it means rewriting the interpreter loop a second time.
- Make the record the single source of truth and mirror to GitHub. Rejected: a human must be able to intervene on GitHub without gg's cooperation, and a lost local file must never lose a human decision.

## Consequences

Configuration is pinned per vertex visit, persona bytes included. Unknown dirty state in a worktree is held for a human, never discarded. The first delivery slice is larger than a pure harness-interface start would be; that was accepted knowingly.
