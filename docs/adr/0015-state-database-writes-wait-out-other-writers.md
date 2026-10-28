---
status: accepted
date: 2026-10-24
---

# State Database writes wait out other writers

ADR 0009 opened `gg.db` with a short `busy_timeout` (5 s). On Windows CI about one suite run in eight then failed
with `database is locked` (SQLITE_BUSY) in the two-process tests, on trees that passed on the next run (grey-goo-ri
issue #136). SQLite's busy handler is not fair: a waiter sleeps on a back-off of up to 100 ms, while a process writing
in a loop takes the lock again as soon as it commits, so one writer's burst held another off past 5 s on a loaded
runner. gg runs several processes against one `gg.db` (the Epic pool, two gg processes), so a run could stop the same
way. `gg.db` connections now wait up to 60 s for the write lock. gg's write transactions are synchronous and short,
so the wait ends when the other writer's burst does, and only a lock truly held for a minute fails.

## Considered options

- `synchronous = NORMAL` in WAL mode, which makes each commit shorter. Rejected for now: a power loss could roll
  back committed write-ahead intents, which ADR 0005 relies on.
- A retry loop around each write. Rejected: it is the same unfair wait, written by hand.
- Fewer writes in the tests. Rejected: the tests describe what gg must survive.

## Consequences

- The 60 s bounds only the wait for another connection's lock. A write that holds the lock is never timed out, so a
  slow save of gg's own, a disk stall for example, finishes however long it takes.
- A write behind a writer that holds the lock longer fails after 60 s instead of 5 s, with SQLITE_BUSY before it
  takes the lock, so nothing of it reaches `gg.db`. A record save becomes a `RecordSaveError`: the Ticket's
  interpreter saves nothing more of that record and runs no further Action, so no side effect follows an intent that
  was not saved (ADR 0005). The pool reports that Ticket as a fault, other Tickets carry on, and `gg run` exits
  non-zero. The issue keeps `gg:state:in-progress` and gets no comment, since every GitHub write is a write-ahead
  Action and none can be saved; only the run's log names the error. The next `gg run` finds the record as a crash
  leaves it: a failed call result rolls back with its Event, so files the agent wrote look like a stranger's and the
  Ticket holds at `needs-human` with them in place, until grey-goo-ri issue #68 rescues an Interrupted Attempt. A
  lock held that long means a hung process, which this surfaces instead of making every other gg process wait.
- The open lock (`gg/locks/open.db`) keeps its 5 s timeout, and the locks keep `busy_timeout = 0` (ADR 0008).
- `test/contract/sqlite/record.test.mjs` has another process hold the write lock for 8 s and checks that a save waits
  it out for longer than 5 s.
