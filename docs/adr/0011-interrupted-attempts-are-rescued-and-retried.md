---
status: accepted
date: 2026-10-18
---

# An interrupted agent Attempt is rescued to a ref, reset in place and retried

ADR 0005 holds every uncommitted change no open intent proves the agent's, so a gg process that dies during an agent
call leaves its Ticket Held even when nothing but that agent touched the worktree. We now save each agent Attempt's
baseline as a write-ahead intent before the harness launches. At resume, an Interrupted Attempt (an open Attempt
intent) is recovered in place: the leftovers are committed, untracked files included, to a Rescue Ref, the worktree is
reset to the baseline and its snapshotted Protected Files and tests restored, and the Action gets a new Attempt in a
fresh Session, within a crash-retry budget of one. Each step is a write-ahead Action of its own, so a second crash
during recovery neither repeats nor skips a step. Nothing is discarded: the Rescue Ref keeps whatever was in the
worktree, whoever made it.

The baseline proves what to restore, not who made the later changes, and gg cannot tell them apart: a human edit
made between the crash and the resume is rescued with the agent's leftovers, moves out of the worktree into the
Rescue Ref, and is not lost. A worktree that does not match its Rescue Ref after the rescue holds the Ticket.

Amended 2026-10-22 (decision V9 in `docs/research/user-defined-procedures-decisions.md`): this ADR first held the
Ticket when a file was modified after the Attempt's last recorded heartbeat, on the grounds that the agent's process
tree dies with gg. The heartbeat is saved about every 60 seconds, so the agent can write after the last one; on
Ctrl+C, a closed console, a tree kill or power loss no process survives to record when the agent died; and on POSIX
the agent's process group does not die with gg. The rule mostly held ordinary crashes, so it was dropped.
Merge conflicts, a moved branch and an exhausted budget hold as before.

## Considered options

- Keep holding every Interrupted Attempt that left changes. Rejected: a crash costs a human round trip even when the
  record shows the agent alone was running.
- Retry in a fresh worktree created from the baseline and keep the old one untouched. Not chosen for now: git checks a
  branch out in one worktree only, so the old worktree must be detached or forced, and the new one lacks the ignored
  build state (dependencies, caches) the agent and the Checks rely on. Kept in the backlog for the case where in-place
  reset proves unsafe, for instance Windows file locks that stop the reset or rescued human edits in practice.
- Treat every change after a crash as the agent's and reset without a rescue. Rejected: it discards a human's work
  whenever the guess is wrong.

## Consequences

- Request 3.5's rule that rollback is limited to changes the record proves this run's agent made gains a third case,
  the Interrupted Attempt, whose changes are preserved rather than proven.
- Rescue Refs live under `refs/gg/rescue/<digest of the Action Marker>`, since a marker's colons are not valid in a
  ref name, and are created only when absent so a repeated recovery cannot overwrite an earlier rescue. They keep the
  rescued objects from garbage collection and are removed only with the Execution Record (`gg work reset`, slice 6).
- Ignored files outside the Protected Files and test paths are still neither rescued nor restored, as before.
- A retried agent call is not a replay: it may produce a different result, and every Check after it runs again.
- Tools the agent ran that changed anything outside the worktree are not undone.
- The worktree is reset only after the interrupted Attempt's writers are confirmed gone (decision N1, 2026-10-23): the
  call intent records the containment (a Windows job object with kill-on-close, or none) and the job helper's process
  identity; at resume a helper still running is killed and confirmed gone first. An uncontained Attempt (POSIX, or a
  helper that failed to start) is rescued and held, never reset, since a surviving writer could write after the
  rescue's verification. A tool that explicitly breaks away from the job is an accepted residual risk. Linux cgroup
  containment is backlogged (grey-goo-ri issue #128).
- A human edit made between the crash and the resume leaves the worktree; the History and any hold comment name the
  Rescue Ref that keeps it.

## Sources

- Activities and steps run at least once and are retried within a bounded policy: https://docs.temporal.io/encyclopedia/retry-policies,
  https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/
- Compensation must account for concurrent changes by other actors:
  https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction
- Recovery that logs its own undo work so a second recovery does not repeat it (ARIES compensation log records):
  https://www.cs.cmu.edu/~15849g/readings/mohan92.pdf
- Snapshot before acting, in coding agents: https://docs.cline.bot/core-workflows/checkpoints,
  https://code.claude.com/docs/en/checkpointing
- `git stash create` has no untracked option, so the rescue builds its commit from a temporary index:
  https://git-scm.com/docs/git-stash
- Ref names may not contain colons; `update-ref` with a zero old value creates only when absent:
  https://git-scm.com/docs/git-check-ref-format, https://git-scm.com/docs/git-update-ref
- A branch is checked out in one worktree at a time: https://git-scm.com/docs/git-worktree
