---
status: accepted
date: 2026-10-25
---

# The suite launcher takes a stage and boundary names from a closed set

Supersedes the part of ADR 0010 that says the launcher never forwards its arguments; the rest of ADR 0010 stands.

`docs/testing.md` splits the suite into a fast stage (the small tests under `test/unit/`, plus the contract suite of each
boundary a change touched) and the full stage (everything), and grey-goo-ri issue #145 puts the fast stage in
`scripts/run-suite.mjs`. That launcher is the one command Codex may run outside its Windows sandbox (ADR 0010), and it
was safe to allow because nothing a caller types can steer it into running other code. A fast stage needs the caller to
say which stage and which boundaries.

`node scripts/run-suite.mjs` with no arguments still runs the full suite; it is what CI and `npm test` run.
`node scripts/run-suite.mjs fast [boundary ...]` runs `test/unit/` and `test/contract/<boundary>/` for each boundary
named. The launcher accepts nothing else: the first argument must be `fast`, and each later one must equal the name of
a directory under `test/contract/`, read from disk when the launcher runs. Any other argument, a flag, a path or an
unknown name, stops it with a usage message and exit code 2 before anything runs. The paths it hands node are built from
those directory names, never from the argument text, and the environment is cleaned as before.

The execpolicy rule's prefix `node scripts/run-suite.mjs` already matches trailing arguments; its justification and
examples now say what the launcher accepts.

Amended 2026-11-02 (grey-goo-ri issue #239): the closed set is `fast [boundary ...]`, `check`, or nothing.
`node scripts/run-suite.mjs check` runs the format check, ESLint and `tsc` (ADR 0018) and no tests, so CI can show them
as their own `check` job beside the suite jobs. It takes no further argument: `check` followed by anything is a usage
error with exit code 2. The full and fast stages still run the three checks before their tests, so no agent run skips
them. The rule's prefix is unchanged; its justification and examples name `check`.

Amended 2026-11-03 (the coverage ratchet): the closed set adds `coverage` and `coverage update`.
`node scripts/run-suite.mjs coverage` runs `test/unit/` alone, with node's built-in coverage over `lib/` (every module,
loaded or not, minus `lib/exec.mjs`, `lib/git.mjs` and `lib/containment.ts`, which `test/unit/` may not reach), writes
`coverage/lcov.info`, and compares the line and function percentages with `coverage-baseline.json`'s figures for the
running platform. A fall fails, and so does a rise not yet recorded, so the figures only climb; `coverage update` records
a rise and never lowers a figure. Lowering one is a hand edit a reviewer sees. Branch coverage is printed but not held:
node merges each test process's V8 branch ranges, and the branches found in a file move by one or two between runs of
the same tree. Each platform keeps its own figures because the win32 and POSIX branches of `lib/` are covered
differently. The stage runs no format check, lint or type check: CI's `check` job and the suite stages run them. Any
other argument after `coverage` is a usage error with exit code 2. The rule's examples name `coverage`.

## Considered options

- A second launcher, `scripts/run-fast.mjs`, that also ignores its arguments and runs `test/unit/` with every contract
  suite, under its own rule. Rejected: no per-boundary selection, so the fast stage would run every contract suite, git's
  included, and a second rule to keep in step.
- Forwarding arguments to `node --test`. Rejected: a caller could pass `--import` or a file outside the suite, which is
  what ADR 0010 exists to prevent.
- Choosing the stage with an environment variable. Rejected: the execpolicy rule matches the command line only, and the
  launcher's job is to drop the environment that could change what node loads.

## Consequences

- The launcher's arguments are a closed set: adding a stage, or a flag such as a name filter, needs a new ADR.
- A new `test/contract/<boundary>/` directory becomes a valid argument without a change to the launcher.
- Rules load from the checked-out tree, so the PR that changes `.codex/rules/test.rules` needs human review before Codex
  reviews it (ADR 0010).
