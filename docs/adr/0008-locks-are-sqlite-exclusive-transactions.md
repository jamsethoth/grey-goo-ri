---
status: accepted
date: 2026-10-15
---

# Locks are node:sqlite exclusive transactions

The ticket, epic and repo locks were lock files: a JSON file with the holder's pid, published by hard link, with a
claim-file protocol to take over a dead holder's lock and retries around Windows "delete pending" errors. The
takeover path kept growing races, and `test/locks.test.mjs` flaked under parallel load. We now hold each lock as an
open `BEGIN EXCLUSIVE` transaction on `<git common dir>/gg/locks/<name>.db` through `node:sqlite`, with
`busy_timeout = 0` so an attempt is a single try. SQLite takes the lock through the OS (`LockFileEx` on Windows), so
exclusivity and release when the holder dies come from the OS, and the takeover code, pid liveness check and
delete-pending handling are gone. A busy database (SQLITE_BUSY, code 5, which `BEGIN EXCLUSIVE` may itself return)
means the lock is held; any other error is thrown.

## Considered options

- Keep the link-and-claim scheme and fix its retry gap. Rejected: every fix so far exposed another race between
  readers, claimants and Windows pending deletes, and the scheme still has to guess liveness from a pid.
- A native OS-lock addon such as fs-ext. Rejected: a compiled dependency for something Node now ships, with
  per-platform builds to maintain.

## Consequences

- The Node floor is 22.13, the first line where `node:sqlite` loads without `--experimental-sqlite`. Node 20 is
  end of life. `node:sqlite` is Stability 1.1 (active development), so its API may still change.
- The lock holds no holder identity: nothing records which pid holds it. Add a sidecar when `gg doctor` or stuck
  detection needs one.
- The handle must keep its `DatabaseSync` referenced; a collected connection releases the lock.
- Windows releases a terminated process's locks after a delay that depends on system resources, so a waiter polls
  rather than expecting the lock at once.
- SQLite locking is unreliable on network filesystems, like any file lock; a repository on a network share is not
  supported.

## Sources

- node:sqlite: added in v22.5.0, `--experimental-sqlite` flag removed in v22.13.0, Stability 1.1 Active development:
  https://nodejs.org/docs/latest-v22.x/api/sqlite.html
- Node 20 end of life: https://nodejs.org/en/about/previous-releases
- BEGIN EXCLUSIVE and SQLITE_BUSY: https://www.sqlite.org/lang_transaction.html,
  https://www.sqlite.org/rescode.html (SQLITE_BUSY = 5; BEGIN IMMEDIATE and EXCLUSIVE may themselves return it)
- SQLite locking through LockFileEx on Windows, and the network-filesystem warning:
  https://www.sqlite.org/lockingv3.html
- The OS unlocks a terminated process's locks, in a time that depends on system resources:
  https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex
