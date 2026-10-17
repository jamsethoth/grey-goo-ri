---
status: accepted
date: 2026-10-15
---

# Execution Records, Events and Pinned Configurations live in one node:sqlite state database

Records were one JSON file each under `<git common dir>/gg/records/`, written through a temp file and rename, and
events were lines appended to `events.jsonl`. Both worked, but they repeat the Windows file trouble the locks had
(ADR 0008): a rename over a record another gg process has open, two processes appending to one file, a directory scan
that parses every record to find one worktree's activity, and a corrupt-line shim for a schema gg never wrote. Now
that `node:sqlite` is in the project, one state database `<git common dir>/gg/gg.db` holds them: a `records` table
with one JSON document per Execution Record and Epic Record, an `events` table with one row per Event, its identity
columns indexed and the full Event as JSON, and a `configs` table with the Pinned Configuration behind every Config
Hash a run has used. The write-ahead log stays inside the record document, so ADR 0005 and Reconciliation are
untouched. The database is opened in WAL mode with a short `busy_timeout`; locks keep their own files, because an
open exclusive transaction would block every record write if it shared the database.

## Considered options

- Keep the files and fix each race as it appears. Rejected: that is the path the locks took before ADR 0008.
- A write-ahead `log` table and normalised record columns. Rejected for now: a second schema to freeze in the
  interface freeze, and the record document is small enough to rewrite whole.
- Other libraries surveyed at the same time (`docs/library-survey.md`): none deleted more than it added except
  `node:util.parseArgs` for argument parsing, adopted separately; `ajv` is deferred to the slice 5 validator.

## Consequences

- The record is no longer a file a human opens in an editor; `sqlite3` or any SQLite client reads it now and
  `gg work show` prints it from slice 6. Request 3.5 says so.
- Database size grows with events only. Nothing is purged automatically; `gg work archive` (slice 6) exports and
  deletes by date, and `gg doctor` reports size.
- `node:sqlite` is Stability 1.1; the floor stays 22.13 (ADR 0008). SQLite locking inside the Codex Windows sandbox
  is unverified; the Codex reviewer cannot run the suite there for unrelated reasons, so nothing changes for review.
- Tests must close the database before removing a temp directory on Windows, so `record.mjs` exports a close.
- Two processes switching a new `gg.db` to WAL at once can get SQLITE_BUSY whatever `busy_timeout` says: the switch
  upgrades a SHARED lock to RESERVED, and SQLite skips the busy handler there to avoid deadlock (check-in d33771a3,
  https://sqlite.org/src/info/d33771a303d9c20d). `openDb` therefore takes `BEGIN EXCLUSIVE` on the lock file
  `gg/locks/open.db` around the switch. A transaction that starts from no lock does wait on the busy handler, so the
  switches queue (0 failures in 3,200 concurrent opens, against about 1 in 150 without the open lock). Every
  process's first open takes it, whether or not the database exists, so an open lock held past `busy_timeout` fails
  that open with SQLITE_BUSY. The switch must return `wal`, or `openDb` throws. The retry loop Effect-TS adopted for
  the same bug (https://github.com/Effect-TS/effect/pull/8708) was the alternative; the open lock was preferred
  because it removes the race rather than retrying through it.
- The frozen record and event schemas are the JSON documents, not the table layout; the table layout carries its own
  `user_version` and is documented with them.
