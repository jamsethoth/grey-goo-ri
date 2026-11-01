---
status: accepted
date: 2026-11-01
---

# The Node floor is the Node 26 LTS line, from 26.13.0

ADR 0012 set the floor at 24.15.0 and named the move to Node 26 for when it became LTS. Node 26 entered LTS with
26.13.0 on 2026-10-28; Node 24 entered maintenance on 2026-10-20 and reaches end of life on 2028-04-30, against
2029-04-30 for Node 26. `@types/node`, the package tsc checks gg against (ADR 0018), moved to major 26 in grey-goo-ri
pull request #223, so the types described a Node newer than the floor. We raise the floor to 26.13.0, the first Node 26
LTS release, so the floor, the Node CI runs and the `@types/node` major name one line again. `engines.node` is
`>=26.13`.

## Considered options

- Stay on 24.15 and hold `@types/node` at major 24. Rejected: it keeps gg on a line in maintenance, and the next
  move would come sooner with less support left.
- Node 26 from 26.0. Rejected: releases before 26.13.0 are not LTS, and CI tests one pinned LTS release.

## Consequences

- `package.json` `engines.node` is `>=26.13`; AGENTS.md and request section 2 say Node 26 LTS (26.13 or later).
- ADR 0012 is superseded. Its reasons for leaving 22.13 and 24.0 to 24.14 still hold, since 26.13 is above both.
- CI runs Node 26.13.0 on both legs, bumped by pull request. A bump below 26.13 is not possible.
- A unit test fails when the `@types/node` major in `package.json` differs from the `engines.node` major, and
  Dependabot ignores semver-major `@types/node` updates, so a new major arrives with a decision about the floor.
- No Node 26-only API is in use yet; using one needs no further decision.

## Sources

- Observed on Windows, 2026-11-01, with Node 26.13.0 from nodejs.org (its SHA256 checked against SHASUMS256.txt):
  the full suite at 16f2961 runs 1557 tests, 1544 pass, 0 fail and 13 skipped, the same as on 24.15, and prints no
  `ExperimentalWarning` or `DeprecationWarning`. `require('node:sqlite')` prints nothing to stderr, and a `.ts` file
  runs with no flag and no warning.
- Node release schedule: https://github.com/nodejs/Release
