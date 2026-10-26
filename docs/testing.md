# Testing

How gg's tests are designed: the rules a test follows, which test doubles it may use, what size it is, and where
it lives and runs. AGENTS.md's Tests section holds the file conventions; this document holds the design. A ticket
that adds or changes tests follows both.

Owner decisions of 2026-10-24 and 2026-10-25, from the suite-speed work behind grey-goo-ri PR #141 and the research
under [Sources](#sources), and the #145 audit's decisions D1-D5 (grey-goo-ri issue #145). Test seams in `lib/` for
the clock, failure injection and fs are grey-goo-ri issue #153; until it lands, the tests that need them keep their
fixed waits and module patching, outside `test/unit/`.

## Rules for a test

1. **Tests are deterministic.** The same tree and command give the same result (decisions file, J1-J3). A failure
   that does not reproduce is a defect in the test or the environment, diagnosed and fixed at its root, never
   re-run past. A test waits on the event it asserts on (a PID file written, a lock taken, a run settled), never on
   a fixed duration; a wait may be bounded only by the case's own timeout (#143). Time-dependent logic takes the
   injected clock (`{ now, sleep }`), not the wall clock.
2. **Test behaviour through the public interface.** Call a module's exports (the namespace import of AGENTS.md
   Tests), not its private helpers or internal shapes. A refactor that keeps behaviour must not break a test.
3. **Assert state, not interactions.** Check the result (the record, the events, the worktree, the labels), not
   which calls were made in which order. Assert on a call only when the call is the behaviour, such as a GitHub
   write that must happen exactly once.
4. **One behaviour per case, named for it.** The name says what happens and what follows: `a failed save ends the
   record`, not `test saveRetry`. Several asserts are fine when they state one behaviour.
5. **Straight-line test code.** No loops, branches or computed expectations in a case; write the expected value
   out. Prefer a little duplication over a helper that hides what the case depends on (DAMP over DRY). A shared
   helper sets up or checks one conceptual thing, and a case's essential inputs stay visible in the case.
6. **Clear failures.** A failing assert says what was expected, what happened, and the inputs that matter.
7. **Tests change only when behaviour does.** A test edited by a refactor is a sign it tested implementation
   detail; fix the test's coupling, not just its expectation.
8. **Each case cleans up after itself.** It ends every run it started, removes its temp directories, and restores
   any transport it swapped (`github.setGh`), so a failed case cannot reach the next case's fakes.
9. **No duplicated coverage.** A behaviour is asserted at the lowest size that can show it. A larger test covers
   what only it can show (the wiring, the real system), not the same branch again.

## Test doubles

Prefer, in this order:

1. **The real implementation**, when it is fast, deterministic and has simple dependencies: pure modules, value
   types, in-process code.
2. **A fake**: a small working model of a collaborator, with its own state. Tests assert the state it ends in.
3. **A stub** returning fixed answers, for a single case's edge (a failure, an odd response).
4. **An interaction mock** that checks calls, only when the call is the behaviour (rule 3). No mocking framework
   and no module replacement (`jest.mock`-style): they tie tests to which file imports what.

Rules for fakes:

- **Double only interfaces gg owns.** An external system (git, `gh`, `claude`, `codex`, SQLite, the OS process
  table) is reached through one gg module, and a double replaces that module, never the external tool's command
  lines or output formats ("only mock types you own").
- **A fake is owned beside the module it replaces** and changes with it.
- **A fake passes the same contract suite as the real module**, so it cannot drift. A behaviour the fake cannot
  model faithfully is not faked; its callers' tests stay on the real module.

gg's doubles:

| Double | Replaces | Contract |
| --- | --- | --- |
| `test/support/fake-harness.mjs` | the Claude Code and Codex harnesses | `test/contract/harness/` |
| `fakeGh` (`test/support/golden.mjs`), installed with `github.setGh` | the `gh` transport | none: gh is never run in tests |
| the `runShell` in `golden.setup` (`test/support/golden.mjs`), returning red or green output | running the suite | none: `test/contract/exec/` covers the real `runShell` |
| the injected clock and `crashAt` points | time and crashes | not needed: no external system |
| fake integrity (#140) | integrity snapshots and Test Immutability | real/fake scenario table (#140) |
| fake git (#144), `test/support/fake-git.mjs` | `lib/git.mjs` | `test/contract/git/` (#144) |

#144 keeps one of the fake integrity and the real integrity over the fake git, measured, and deletes the other.

## Test sizes

A test's size is set by what it touches, not by what it is called (Google's test sizes):

| Size | May | gg examples |
| --- | --- | --- |
| **Small** (unit) | run in one process; no child processes, no real git, no sleeping or wall-clock timers; read checked-in repository files; write only in a temp directory the case creates and removes, the State Database included | Flow validation, rule tables, routing, retries, bounds, records over fakes, a Run over the fake git |
| **Medium** (contract, integration) | spawn processes and use the local disk and localhost | real git in temp repositories, `runShell` process trees, lock contention between processes |
| **Large** (end-to-end) | the whole of gg against real systems | a full `gg run` over real git and the fakes of remote services |

A small test may use the disk because gg's State Database and worktrees live there and an in-memory replacement would be
new `lib/` code for no change in what the test shows (#145, D1). What makes a test slow or flaky is a child process,
real git or a timer, and those are what small excludes.

Tests must not call the real `claude`, `codex` or `gh`, or touch GitHub (AGENTS.md Conventions), so gg has no test
that leaves the machine. Aim for most tests small; a medium test exists to show a boundary or the wiring, not logic.

## Layout and stages

| Directory | Holds | Size |
| --- | --- | --- |
| `test/unit/` | logic over fakes | small |
| `test/contract/<boundary>/` | one narrow suite per external boundary (`git`, `harness`, `sqlite`, `exec`), run against the real module and its fake, or against the real system where there is no fake | medium |
| `test/e2e/` | the full runs and the git-behaviour wiring: the golden traces, and the interpreter, Run and Reconciliation cases whose subject is real git (integrity rollback, admission's dirty, conflict and branch checks, crash and resume, the repo lock), and the `gg` CLI | medium or large |
| `test/support/`, `test/fixtures/` | helpers, fakes and data | |

A file is named `<module>.test.mjs` in the directory its size puts it in, with area files `<module>.<area>.test.mjs`
as before. A module whose cases have different sizes has a file in each directory under the same name: the small cases
of `run.branches` are in `test/unit/run.branches.test.mjs` and its real-git cases in `test/e2e/run.branches.test.mjs`.
`test/unit/layout.test.mjs` checks that no file under `test/unit/` imports `node:child_process`, `lib/exec.mjs` or
`lib/git.mjs`, asks for real git, uses a timer, or calls a support helper that spawns.

That check reads source text, so it misses a spawn it has no pattern for: a support helper imported and called bare
(`sh(...)` rather than `golden.sh(...)`), a new support helper that spawns, or a lib function reached without its fake.
A slip costs speed, not coverage: the full stage still runs the case, and the fast stage's wall time shows the
regression. A new support helper that spawns is added to the check's list in the same change.

Two stages, ordered by speed:

| Stage | Runs | When |
| --- | --- | --- |
| **Fast** | `test/unit/`, plus the contract suite of each boundary whose module, fake or cases changed: `node scripts/run-suite.mjs fast [boundary ...]` (ADR 0016) | every change: the inner loop for people and agents' fix rounds |
| **Full** | everything: `node scripts/run-suite.mjs` | before a PR is marked ready, and in CI on every PR |

The full stage always runs every contract suite, even when no boundary file changed. A contract also depends on
things outside the repository, such as the installed git, Node, Windows behaviour or the CI image, and the
end-to-end tests check the wiring between real modules, which no single contract shows. grey-goo-ri issue #136
(`database is locked` under load) was this kind of failure. When the environment changes (a new git, Node or
runner image), run the full stage.

## Considered and deferred

- **Selecting tests by the import graph** (run only the medium tests whose imports reach a changed module).
  Deferred: Google and Meta select tests because they have millions; gg has under 50 files, and after #140 and
  #144 the full stage is expected to take minutes. Revisit if the full stage stays slow after #145; CI still runs
  everything.
- **A runtime guard for `test/unit/`**: the launcher would `--import` a checked-in guard that makes every
  `node:child_process` function throw when the test file is under `test/unit/` (prototyped for PR #154). It would close
  the text check's gap above, but it adds launcher surface, an ADR 0016 amendment and a rules change for a gap that
  costs only fast-stage speed. Revisit if the fast stage slows down because a medium case got into `test/unit/`.
- **A naming rule alone** (`*.int.test.mjs` beside unit files) for an early fast stage. Folded into #145, so files
  move once into the target layout instead of being renamed and then moved.
- **An npm git library** instead of the git CLI. Rejected (#144): no speed gain, or a second implementation of git
  that behaves differently from the git agents and humans use.
- **Staged Checks for repo owners' own Procedures** (a fast Check during fix rounds, the full suite before ready).
  A Procedures decision, not part of gg's own tests.

## Sources

- Google, *Software Engineering at Google*:
  [ch. 11 Testing Overview](https://abseil.io/resources/swe-book/html/ch11.html) (test sizes, the mix of sizes), [ch. 12 Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html)
  (public APIs, state over interactions, behaviours, names, no logic, DAMP, unchanging tests),
  [ch. 13 Test Doubles](https://abseil.io/resources/swe-book/html/ch13.html) (real, then fakes, then stubs; contract
  tests for fakes), [ch. 23 Continuous Integration](https://abseil.io/resources/swe-book/html/ch23.html) (fast,
  reliable tests at presubmit, selection by dependency).
- Martin Fowler, [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) (stages
  by speed and scope, contract tests) and [IntegrationTest](https://martinfowler.com/bliki/IntegrationTest.html)
  (narrow over broad); [Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html) (state versus
  interaction verification).
- Jez Humble, [Continuous Delivery patterns](https://continuousdelivery.com/implementing/patterns/) (a commit stage of
  a few minutes, broader tests after).
- Spotify, [Testing of Microservices](https://engineering.atspotify.com/2018/01/testing-of-microservices) (the
  honeycomb: integration tests over integrated tests).
- Steve Freeman and Nat Pryce, *Growing Object-Oriented Software, Guided by Tests* ("only mock types you own").
- Meta, [Predictive test selection](https://engineering.fb.com/developer-tools/predictive-test-selection/) and the
  [ICSE 2019 paper](https://arxiv.org/abs/1810.05286) (selection at scale, as an optimisation over a full run).
