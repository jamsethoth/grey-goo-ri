---
status: accepted
date: 2026-10-19
---

# The Node floor is the Node 24 LTS line, from 24.15.0

ADR 0008 set the floor at 22.13, the first line where `node:sqlite` loads without `--experimental-sqlite`. On every
22.x release, and on 24.x before 24.15.0, loading it still prints an `ExperimentalWarning` to stderr. Seven
multi-process tests assert that a child's stderr is empty, so the suite fails on the old floor, and nobody runs it
there: the owner works on a current release and CI tests one pinned 24 LTS release. We raise the floor to 24.15.0, the
first Node 24 LTS release where `node:sqlite` is a release candidate and loads silently. `engines.node` is `>=24.15`.

## Considered options

- Keep 22.13 and make the tests tolerate the warning. Rejected: it keeps a floor that CI does not test, and every
  user on 22 sees the warning on each `gg` run.
- Node 24 from 24.0. Rejected: 24.0 to 24.14 print the same warning, so the suite fails there too.
- Node 26. Rejected for now: it is not yet LTS; move when it is, with a new ADR.

## Consequences

- `package.json` `engines.node` is `>=24.15`; AGENTS.md and request section 2 say Node 24 LTS (24.15 or later).
- ADR 0008's floor consequence and ADR 0009's "the floor stays 22.13" are superseded; the rest of both stands.
- CI runs one exact Node 24 LTS release, bumped by pull request. A bump below 24.15 is not possible.
- `path.matchesGlob` is stable from 24.8.0, so the library survey's "revisit when the floor makes `matchesGlob`
  stable" condition is met; the decision itself is unchanged until that revisit.
- `node:sqlite` is Stability 1.2 (release candidate) on 24.15, so its API may still change, less likely than at 1.1.

## Sources

- node:sqlite history: flag removed in v22.13.0 and v23.4.0 "but still experimental"; "now a release candidate" in
  v24.15.0: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- path.matchesGlob "Marking the API stable" in v24.8.0: https://nodejs.org/docs/latest-v24.x/api/path.html
- Observed on Linux, 2026-10-19: `require('node:sqlite')` warns on 22.13.0, 22.22.0 and 24.14.0, and is silent on
  24.15.0 and 24.22.0; the suite at 3d7c597 fails the seven multi-process tests on 22.13.0 and passes them on
  24.15.0 and 24.22.0.
