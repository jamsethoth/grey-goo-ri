# Library survey, 2026-10-15

Which hand-rolled behaviour a well-vetted npm package or Node built-in would delete, decided item by item with the
owner before epic 1 continued with #19 to #23. Constraints: AGENTS.md at ddd552d (dependencies allowed when they earn
their place, built-ins preferred, never an agentic workflow framework per ADR 0001), native Windows, Node 22.13+, and
the Codex Windows sandbox, which cannot build native addons. Line counts are from the repository at ddd552d.

| Behaviour | Where | Lines | Candidate | Risk | Windows and sandbox | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Execution Record and Epic Record save (temp file and rename), load, directory scan with corrupt handling | `lib/record.mjs` | 117 | `node:sqlite` (built-in, already used by locks) | Stability 1.1 API; records no longer plain files | Removes rename-over-open-file races; no build; SQLite locking in the mxc sandbox unverified | **Adopted**, ADR 0009: `records` table, record as one JSON document; API unchanged |
| Event log: JSON-lines append, tolerant parse, schema-1 shim | `lib/events.mjs` | 88 (about 20 storage) | `node:sqlite` | as above | Two processes append to one table instead of one file | **Adopted**, ADR 0009: `events` table with indexed identity columns; schema-1 shim deleted (gg never wrote it and never reads ff's state) |
| Other worktrees' activity: readdir and parse every record | `lib/integrity.mjs:55` | 3 | one `SELECT` | none | none | **Adopted** with the above; `readActivity` keeps its signature |
| Pinned Configuration behind a Config Hash | not stored | 0 | `configs` table in the same database | none | none | **Adopted**: insert-or-ignore by hash wherever a hash is computed; diff command in slice 6 |
| Write-ahead log as its own table | `lib/record.mjs` | 0 | `node:sqlite` | a second schema to freeze in #23 | none | **Kept inside the record document**; Reconciliation (#19) unchanged |
| Locks | `lib/locks.mjs` | 54 | already `node:sqlite` (ADR 0008) | an exclusive transaction locks a whole file | none | **Kept as separate files**; sharing `gg.db` would block record writes |
| Argument parsing | `lib/opts.mjs` | 42 | `node:util.parseArgs` (stable built-in); `commander`, `yargs`, `minimist` considered | no optional-value flags: `plan --finish` takes a required id | none | **Adopted**: `parseOpts` becomes a thin mapping onto `parseArgs`; own ticket |
| Canonical JSON for the Config Hash | #20 | ~1 | `fast-json-stable-stringify` | none | none | **Hand-rolled**: a sorted-key replacer in `JSON.stringify` |
| Layer merge (maps merge, arrays replace, null deletes) | slice 5; ff `lib/config.mjs:16-26` | 12 | `deepmerge`, `lodash.merge` | neither does null-delete; lodash merges arrays by index | none | **Hand-rolled**: port ff's merge and add null-delete |
| Config file format | `defaults/gg.json` | 0 | `yaml`, `smol-toml`, JSON5, `gg.config.mjs`, `cosmiconfig` | YAML quoting traps; executable config is unsafe for agent edits; three fixed Layer paths need no discovery | none | **JSON stays** |
| Structured Response and config shape validation | `lib/briefs.mjs:43-60`; slice 5 validator | ~25 | `ajv` (pure JS, about 1 MB) | the validator's graph checks are not shape checks; payoff unknown until slice 5 is sliced | pure JS | **Deferred**: decide in the slice 5 validator ticket |
| Reconciliation | #19 | git log and gh lookups | none applicable | | | **Hand-rolled** |
| Pool | #22; ff `lib/run.mjs:17-27` | 10 | `p-limit` | a dependency for ten tested lines | none | **Hand-rolled** |
| Two gg processes on one repository | #22 | | already serialised by the SQLite locks | | | **No change**; #22 gains the shared `events` table in its DoD |
| Test glob to regex | `lib/checks.mjs:63` | 6 | `picomatch`; `path.matchesGlob` | `path.matchesGlob` is experimental on the 22.13 floor | none | **Hand-rolled**; revisit when the floor makes `matchesGlob` stable |
| Process tree kill and job object | `lib/exec.mjs`, `lib/winjob.ps1` | 239 + script | `tree-kill`, `execa` | `tree-kill` is `taskkill /T`, which exec already has as fallback; job objects need a native addon | the sandbox cannot build addons | **Kept** |
| Version compare for `gg doctor` | slice 2 | ~5 | `semver` | none | none | **Hand-rolled** unless prerelease tags appear |
| Retry on git index lock with backoff | request 3.5 | ~8 | `p-retry` | none | none | **Hand-rolled** |
| GitHub access | `lib/github.mjs` | 97 | `@octokit/rest` | its own auth; `gh` uses the OS keyring | | **Kept on `gh`** |
| Trajectory export | slice 6 | | none; Harbor's validator is Python | | | **Hand-rolled** |

## Retention of the state database

Agreed with the owner: nothing is purged automatically. `gg work archive --before <date>` (slice 6) exports and
deletes events of ended executions, their run directories and unreferenced pinned configurations, then checkpoints
and vacuums. Execution Records are deleted with the merged worktree or by `gg work reset`; an Epic Record when the
epic is closed and its ticket records are gone. `gg doctor` reports database size and the oldest event, with no
threshold. Request 3.7 records this.
