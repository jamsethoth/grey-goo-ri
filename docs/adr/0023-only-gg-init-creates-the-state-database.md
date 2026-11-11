---
status: accepted
date: 2026-11-11
---

# Only gg init creates the State Database

Supersedes the lazy creation of ADR 0009 (the open lock `gg/locks/open.db`, the WAL switch and the table creation on
open) and ADR 0015's line on the open lock's 5 s timeout.

Every gg command that touched the State Database created `<git common dir>/gg/gg.db` when it was missing. Two
processes could then race to create it, and switching a new database to WAL can return SQLITE_BUSY without calling the
busy handler, so ADR 0009 serialised the first open under an open lock with its own 5 s timeout, the one remaining
load-dependent bound in the open path (grey-goo-ri issue #150, found in the review of PR #149). Lazy creation also had
costs of its own (owner, 2026-11-06): a lost `gg.db` came back empty with no record of earlier Executions, and a
read-only command run in the wrong place left a stray database behind.

`gg init` now creates the State Database, and nothing else does. It builds the database whole in a temp file of its own
beside `gg.db` (WAL mode, which is stored in the file, its tables and `user_version`), closes it, and hard-links it to
`gg.db`. The link fails atomically when `gg.db` exists, so two inits at once leave one database, the losing init keeps
it, and no reader ever sees a database half built. No lock is taken. `gg init` is safe to repeat: it keeps an existing
database, and opens it once, so it never reports as kept a database no command can open. One it cannot open (a newer
version, or one without its tables) it leaves untouched and exits 1, telling the person to run the gg that wrote a newer
one, or else to move it aside and keep it, since it may hold Execution Records and is the evidence of what went wrong,
and run `gg init` again (owner, #150).

Every other command opens an existing database and never creates one: `open` uses SQLite's `mode=rw`, so a missing file
fails instead of being made empty, and it still refuses a version it does not read. `gg run`'s preflight and
`gg doctor` report a missing database as the error `state-database-missing` naming `gg init`, beside the configuration's
errors and before any GitHub read or write; `gg work abandon` refuses before it takes its ticket lock.

## Considered options

- Retry the WAL switch until a deadline, as Effect-TS does (https://github.com/Effect-TS/effect/pull/8708). Rejected:
  it keeps lazy creation and its silent empty database, and a deadline is a load-dependent bound again.
- Keep the open lock with a longer timeout. Rejected for the same reasons.
- Create under a lock in `gg init`. Rejected: the hard link needs no lock, and a lock file is one more file to leave.
- Move an unusable database aside in `gg init` and create a new one. Rejected by the owner: it may hold records, and
  it is the evidence of what went wrong; the person decides.

## Consequences

- `gg.db` lives in the git common dir and is not committed, so `gg init` runs once per clone, and a clone's worktrees
  share the result. A deleted `gg.db` recovers with the same command, empty, which the person now chooses.
- The hard link needs a filesystem that supports one; on one that does not (FAT, exFAT, some network shares), `gg init`
  fails with the link's error.
- On Windows the temp name unlinks while another process has `gg.db` open (probed for #150), so a creator's cleanup
  does not race the first opener. An init that crashes between the link and the unlink leaves a
  `gg.db.init-<pid>-<random>` file; gg never opens it, and it can be deleted once no gg process runs.
- Repositories that ran an older gg keep a stray `gg/locks/open.db`; nothing opens it, and it can be deleted.
- Tests create the database explicitly, as `gg init` would: `test/support/temp-directory.ts`'s
  `stateDatabaseDirectory`, the golden and run fixtures, and the parent of every child process that opens it.
  `docs/testing.md` loses the open lock's queue case from its real-time exceptions.
