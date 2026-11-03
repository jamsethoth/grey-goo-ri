# Library survey, 2026-10-15

Which hand-rolled behaviour a well-vetted npm package or Node built-in would delete, decided item by item with the
owner before epic 1 continued with #19 to #23. Constraints: AGENTS.md at ddd552d (dependencies allowed when they earn
their place, built-ins preferred, never an agentic workflow framework per ADR 0001), native Windows, Node 22.13+
(since raised to 26.13, ADR 0020), and the Codex Windows sandbox, which cannot build native addons. Line counts are
from the repository at ddd552d.

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
| Test glob to regex | `lib/checks.mjs:63` | 6 | `picomatch`; `path.matchesGlob` | `path.matchesGlob` is experimental on the 22.13 floor; stable from 24.8, below every floor since ADR 0012 | none | **Hand-rolled**; revisit when the floor makes `matchesGlob` stable |
| Process tree kill and job object | `lib/exec.mjs`, `lib/containment.ts` | about 540 | `tree-kill`, `execa` | `tree-kill` is `taskkill /T`, which exec already has as fallback; the job object is a few kernel32 calls through `node:ffi`, built into Node 26 (ADR 0021) | none | **Kept** |
| Version compare for `gg doctor` | slice 2 | ~5 | `semver` | none | none | **Hand-rolled** unless prerelease tags appear |
| Retry on git index lock with backoff | request 3.5 | ~8 | `p-retry` | none | none | **Hand-rolled** |
| GitHub access | `lib/github.mjs` | 97 | `@octokit/rest` | its own auth; `gh` uses the OS keyring | | **Kept on `gh`** |
| Trajectory export | slice 6 | | none; Harbor's validator is Python | | | **Hand-rolled** |
| Durable execution of Visits | `lib/interpreter.mjs`, `lib/reconcile.mjs` | | Temporal, Restate, Inngest, DBOS (TypeScript needs Postgres) | each needs a server or database | | **Hand-rolled** (2026-10-18): the write-ahead Action log stays; ADR 0001 |
| Retry of GitHub writes and push | `lib/interpreter.mjs` | | `p-retry`, `cockatiel`; `@octokit/plugin-retry` and `plugin-throttling` | in-memory budgets, while gg's must survive a crash; Octokit leaves `gh` | | **Hand-rolled** (2026-10-18); revisit Octokit only if `gh` cannot expose rate-limit headers |
| Rescue Ref and workspace snapshot | ADR 0011 | | `isomorphic-git`, Jujutsu | a second git implementation or binary | | **git plumbing** (2026-10-18): temporary index, `write-tree`, `commit-tree`, `update-ref` |
| Retry of file removal on Windows locks | `lib/integrity.mjs` | | `fs.rm` `maxRetries` (built-in) | none | retries EBUSY and EPERM | **Built-in**, in the Interrupted Attempt ticket (ADR 0011) |

## Toolchain, 2026-10-31

The first dependencies, all dev, for grey-goo-ri epic #193's rules (ADR 0018). None ships with gg or runs in a Run;
ESLint and tsc run in every suite stage.

| Package | Version | Reason | Decision |
| --- | --- | --- | --- |
| `typescript` | `~6.0.3` | `tsc --noEmit` checks the `.ts` modules Node runs by stripping types | **Adopted**; held below 6.1, the newest typescript-eslint 8.72 supports, and TypeScript 7's native compiler waits for it |
| `@types/node` | `^26.6.6` | without it tsc resolves no `node:` module; major 26 matches the Node floor (ADR 0020) | **Adopted**, named in `types` since TypeScript 6 loads no `@types` package unlisted |
| `eslint` | `^10.14.0` | the epic's rules (names, lengths, nesting, imports, module state), each failure at its line | **Adopted**; a hand-rolled checker would be an AST walker gg would own |
| `typescript-eslint` | `^8.72.1` | the parser ESLint needs to read `.ts`; no type-aware rules | **Adopted**, parser only |
| `@stylistic/eslint-plugin` | `^5.10.0` | `max-len` and `max-statements-per-line`, which left ESLint core | **Adopted** |
| `prettier` | `^3.9.10` | one formatting, so diffs and reviews carry no style noise | **Adopted**; configured here, run and checked from grey-goo-ri issue #196 |

`npm audit` reports GHSA-g3hv-75wg-m249 (CVE-2026-118764, moderate) in minimatch 10.2.6. It is a denial of service that
needs an attacker-supplied glob pattern, and is fixed only in minimatch 11.0.1. `eslint`, `@eslint/config-array` and
`@typescript-eslint/typescript-estree` all require `^10`. The only patterns minimatch sees here are the repository's
own config globs and the launcher's `.`, and it never runs during a gg Run, so the owner chose to wait (2026-11-01)
rather than force minimatch 11 with an npm `overrides` entry. That entry was probed: it cleared the audit, and ESLint
linted the same 131 files with identical results. The fixes upstream are eslint/eslint#21476, eslint/rewrite#532 and
typescript-eslint/typescript-eslint#13125; Dependabot's weekly npm update picks them up when they ship.

## Locating a Layer's JSON error, 2026-11-02

gg's first runtime dependency, for grey-goo-ri issue #216. Node's `SyntaxError` from `JSON.parse` carries only
`message` and `stack`. V8's message names no position for an early end or an unexpected token, such as a trailing
comma, and quotes the Layer's text with its line breaks. `JSON.parse` still decides what a Layer holds; the package
only locates the first error once it has thrown. The pattern is the one nx (`packages/nx/src/utils/json.ts`) and
npm-check-updates (`src/lib/utils/parseJson.ts`) use. Unlike them, gg never returns the package's value: it parses
leniently, never throws, and sets an object's prototype from a `"__proto__"` key.

| Package | Version | Probe (5,404 texts, 4,659 that `JSON.parse` rejects) | Decision |
| --- | --- | --- | --- |
| `jsonc-parser` (Microsoft, VS Code's JSON parser; MIT, no dependencies) | `^3.3.1` | flags every text V8 rejects and none it accepts; its visitor gives line and column, counting CRLF, CR and LF | **Adopted**: `lib/config.mjs` `readLayer` |
| `@humanwhocodes/momoa` (Apache-2.0, no dependencies) | `3.3.13` | accepts 55 texts V8 rejects (a raw control character in a string); reports every early end at line 1 column 1 | Rejected |
| `json-parse-even-better-errors` (npm), `parse-json` | | read the position out of V8's message, which has none in the cases above | Rejected |
| Hand-rolled: binary search over `JSON.parse` prefixes, reading V8's message | | matched V8's position wherever V8 gives one, but read V8's wording, which is no contract | Replaced by `jsonc-parser` |

## Retention of the state database

Agreed with the owner: nothing is purged automatically. `gg work archive --before <date>` (slice 6) exports and
deletes events of ended executions, their run directories and unreferenced pinned configurations, then checkpoints
and vacuums. Execution Records are deleted with the merged worktree or by `gg work reset`; an Epic Record when the
epic is closed and its ticket records are gone. `gg doctor` reports database size and the oldest event, with no
threshold. Request 3.7 records this.
