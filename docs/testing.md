# Testing

How gg's tests are designed: the rules a test follows, which test doubles it may use, what size it is, and where
it lives and runs. AGENTS.md's Tests section holds the file conventions; this document holds the design. A ticket
that adds or changes tests follows both.

Owner decisions of 2026-10-24 and 2026-10-25, from the suite-speed work behind grey-goo-ri PR #141 and the research
under [Sources](#sources), and the owner's decisions D1-D5 on the #145 audit
([grey-goo-ri issue #145, comment of 2026-10-25](https://github.com/jamsethoth/grey-goo-ri/issues/145#issuecomment-6406602493)).
The test seams in `lib/` for the clock, failure injection and fs are grey-goo-ri issue #153, passed down from the
entry point since #199 (ADR 0019).

## Rules for a test

1. **Tests are deterministic.** The same tree and command give the same result
   (`docs/research/user-defined-procedures-decisions.md`, J1-J3). A failure that does not reproduce is a defect in
   the test or the environment, diagnosed and fixed at its root, never re-run past. A failing run, local or in CI, is
   classified before anything else: caused by the change and fixed, a defect elsewhere and ticketed with its log, or the
   environment, with the evidence. A re-run gathers evidence, and its pass does not clear the failure (#285). A test
   waits on the event it
   asserts on (a PID file written, a lock taken, a run settled), never on a fixed duration; a wait may be bounded
   only by the case's own timeout (#143). Time-dependent logic takes the injected clock (`{ now, sleep }`), not the
   wall clock. Four cases measure real time, recorded as exceptions because their subject is real time across
   processes, which no injected clock reaches. None compares one process's clock with another's: two processes'
   `Date.now()` can disagree by a millisecond on Windows, so an order between processes is shown causally, by what one
   saw of the other's writes (#260):
   - `test/contract/sqlite/record.test.ts`, `a save waits out another process that holds the write lock for longer
     than 5 s`: a save waiting past the 5 s busy timeout ADR 0015 replaced is the behaviour.
   - `test/contract/exec/exec.job.test.ts`, `runShell: when the job cannot be set up, a slow taskkill still takes down
     the process tree`: its taskkill takes 31 s, longer than the 30 s ceiling `runShell` once had, to show no ceiling
     is left.
   - `test/contract/exec/exec.timeout.test.ts`, `runShell timeout kills an orphan its watcher listed, however slowly ps
     answers`: its `ps` answers after 2 s and then 5 s, past the 1.5 s listing budget and the 2 s start-time
     tolerance `runShell` once had (POSIX only).
   - `test/contract/sqlite/record.test.ts`, `openers of a new database queue while the open lock is held and all
     succeed once it is released`: it holds the lock a second longer so an opener that got past it shows itself (#188);
     each opener then reports whether the marker the parent writes just before the release was there when it switched.
2. **Test behaviour through the public interface.** Call a module's exports (the namespace import of AGENTS.md
   Tests), not its private helpers or internal shapes. A refactor that keeps behaviour must not break a test.
3. **Assert state, not interactions.** Check the result (the record, the events, the worktree, the labels), not
   which calls were made in which order. Assert on a call only when the call is the behaviour, such as a GitHub
   write that must happen exactly once.
4. **One behaviour per case, named for it.** The name says what happens and what follows: `a failed save ends the
   record`, not `test saveRetry`. Several asserts are fine when they state one behaviour.
5. **Straight-line test code.** No loops, branches or computed expectations in a case; write the expected value
   out. DAMP over DRY, with the line drawn here: the inputs and expected values that make a case different stay in
   the case; setup unrelated to the case's subject (fixtures, record seeding, transport wrappers) lives in
   `test/support/`, and a setup block that appears in three or more cases moves there. A shared helper sets up or
   checks one conceptual thing.
6. **Clear failures.** A failing assert says what was expected, what happened, and the inputs that matter.
7. **Tests change only when behaviour does.** A test edited by a refactor is a sign it tested implementation
   detail; fix the test's coupling, not just its expectation.
8. **Each case cleans up after itself.** It ends every run it started and removes its temp directories. A fake reaches
   a run only through the options the case passes (the seams below), so no fake outlives its case.
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
| `test/support/fake-harness.ts` | the Claude Code and Codex harnesses | `test/contract/harness/` |
| `fakeGh` (`test/support/fake-gh.ts`), passed as `github.createGh(fake.gh)` | the `gh` transport | none: gh is never run in tests |
| `addSuite` (`test/support/add-suite.ts`), the `runShell` the fixtures pass, returning red or green output | running the suite | none: `test/contract/exec/` covers the real `runShell` |
| the injected clock and `crashAt` points | time and crashes | not needed: no external system |
| fake integrity (#140), `test/support/fake-integrity.ts` | integrity snapshots; its untracked files and Test Immutability are lib's own over the fake git | `test/contract/integrity/` (#218) |
| fake git (#144), `test/support/fake-git.ts` | `lib/git.ts` | `test/contract/git/` (#144) |

#144 kept both integrities: the fake one for tests whose subject is not git behaviour, because it is faster, and
the real one over real git for tests whose subject is git behaviour, because it is what they check. The third option,
the real integrity over the fake git, was measured slower (221 s against 181 s) and failed three cases on ignored
Protected Files, which the fake git's ignore model does not cover (grey-goo-ri PR #152). It still serves a case that
needs the real integrity (its busy flags, generations, repo lock waits or Test Immutability) but not git, with no
ignored Protected File: the concurrent Runs of `test/e2e/run.concurrency.test.ts`, the queued writes of
`test/e2e/interpreter.retry.test.ts` and the moved immutability baselines of `test/e2e/interpreter.fix.test.ts` use
it, since over real git their snapshots' git processes took them up to 444 s under a full suite run (#187).

The seams `lib/` offers a test (#153), in place of fixed waits, patched built-in modules and SQL triggers. Each is a
dependency `bin/gg.ts` builds once and passes down in one `deps` key, which `run.runTarget` takes and passes on to
`interpreter.runExecution` (ADR 0019), or a factory option of the module that owns it; a test passes its own in the
options it builds, so none outlives the case:

| Seam | What a test does with it |
| --- | --- |
| the `clock` option (`{ now, sleep, every }`; `golden.fixture`'s `clock.beat()`) | moves time, records backoffs, fires a heartbeat |
| the `gh` option, `github.createGh(transport)` | answers and records every gh call (`fakeGh`), or fails a chosen one (`ghThrough`) |
| the `git` option; `git.createGit({ sleep })` | runs over the fake git; records runGit's index.lock waits |
| the `locks` option, `locks.createLocks({ clock, wrapAttempt })` | times every lock wait, the 60 s default and the 600 s repo-lock waits included; sees a lock attempt, or contends it (`contendRepoLock`) |
| the `database` option, `record.createStateDatabase({ beforeSave, beforeAppend })` (`caseDatabase(t)`, with `onSave`, `failSaves` and `failAppends`, in `test/support/case-database.ts`) | sees or fails a chosen save or Event insert |
| the `integrity` option; `integrity.createIntegrity(git, fs, locks)` (`crashFs`, `test/support/crash-fs.ts`) | runs the fake integrity; crashes a restore's write |
| the `exec` option | answers the suite's command with red or green output |
| `exec.runShell`'s `testHooks` option: `timers`, `onWatch`, `signal` and the rest | moves the timeout clock; sees which descendants the POSIX watcher has listed |
| `exec.createExec({ kernel32 })` | runs Windows commands with no `node:ffi` (`null`) or with kernel32 calls that fail |

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
| `test/contract/<boundary>/` | one narrow suite per external boundary (`git`, `harness`, `integrity`, `sqlite`, `exec`), run against the real module and its fake, or against the real system where there is no fake | medium |
| `test/e2e/` | the full runs and the git-behaviour wiring: the golden traces that run on real git (those over the fakes are in `test/unit/`), and the interpreter, Run and Reconciliation cases whose subject is real git (integrity rollback, admission's dirty, conflict and branch checks, crash and resume, the repo lock), the Runs over the fake git that the real integrity or a lock-holding process makes medium (`run.concurrency`'s attribution and repo-lock Runs, `interpreter.retry`'s queued writes, `interpreter.fix`'s moved baselines), and the `gg` CLI | medium or large |
| `test/support/`, `test/fixtures/` | helpers, fakes and data | |

`test/contract/harness/` spawns nothing, so by what it touches it is small, yet it stays a contract suite (#212). It is
the fake harness's contract (see Test doubles): the cases every Harness must pass, which the fake runs today and the
Claude Code and Codex Harnesses run once they are built. Kept with the other boundaries, the fake and the modules it
stands in for are checked in one place, and `fast harness` selects it after a change to either.

A file is named `<module>.test.ts` in the directory its size puts it in, with area files `<module>.<area>.test.ts`
as before. A module whose cases have different sizes has a file in each directory under the same name: the small cases
of `run.branches` are in `test/unit/run.branches.test.ts` and its real-git cases in `test/e2e/run.branches.test.ts`.
`test/unit/layout.test.ts` checks that no file under `test/unit/` imports `node:child_process`, `lib/exec.ts` or
`lib/git.ts`, asks for real git, uses a timer, or calls a support helper that spawns.

That check reads source text, so it misses a spawn it has no pattern for: a support helper imported and called bare
(`sh(...)` rather than `gitShell.sh(...)`), a new support helper that spawns, or a lib function reached without its fake.
A slip costs speed, not coverage: the full stage still runs the case, and the fast stage's wall time shows the
regression. A new support helper that spawns is added to the check's list in the same change.

Four stages, ordered by speed:

| Stage | Runs | When |
| --- | --- | --- |
| **Check** | `prettier --check`, ESLint and `tsc` (ADR 0018), and no tests: `node scripts/run-suite.ts check` (ADR 0016) | in CI as its own `check` job beside the suite jobs, so a format, lint or type error shows on its own |
| **Fast** | `prettier --check`, ESLint and `tsc` (ADR 0018), then `test/unit/`, plus the contract suite of each boundary whose module, fake or cases changed: `node scripts/run-suite.ts fast [boundary ...]` (ADR 0016) | every change: the inner loop for people and agents' fix rounds |
| **Full** | `prettier --check`, ESLint and `tsc`, then every test: `node scripts/run-suite.ts` | before a PR is marked ready, and in CI on every PR |
| **Coverage** | `test/unit/` with coverage of the unit-testable `lib/`, held to `coverage-baseline.json`: `node scripts/run-suite.ts coverage` (ADR 0016, amended) | in CI as its own `coverage (<os>)` job on each platform, beside the suite jobs; locally with `coverage update` when a change raises coverage |

The coverage stage runs in one process (`--test-isolation=none`), so its figures do not depend on the order node reads
coverage files in; the other stages keep a process per file (ADR 0016, amended). Coverage only climbs. The
coverage stage fails when the line or function coverage of `lib/` under `test/unit/` falls
below the figures `coverage-baseline.json` records for the platform, and when it rises above them without being
recorded, so the next change cannot spend the gain. `node scripts/run-suite.ts coverage update` records a rise; CI's
failure message prints the other platform's figures to paste. The measured set is what a small test can reach: `lib/`
without `lib/exec.ts`, `lib/git.ts`, `lib/process-tree.ts` and `lib/containment.ts`, whose contract suites cover
them, and without the `bin/gg.ts` entry point that wires them. Command Cleanup's decisions, which processes a command
left and what is done with each, are measured: they live in `lib/command-cleanup.ts`, not in `lib/process-tree.ts` or
`lib/containment.ts`. A module no unit test loads still counts, at zero. The spec reporter prints each file's lines,
branches and functions, so the uncovered line numbers are in the stage's output.

The full stage always runs every contract suite, even when no boundary file changed. A contract also depends on
things outside the repository, such as the installed git, Node, Windows behaviour or the CI image, and the
end-to-end tests check the wiring between real modules, which no single contract shows. grey-goo-ri issue #136
(`database is locked` under load) was this kind of failure. When the environment changes (a new git, Node or
runner image), run the full stage.

## Considered and deferred

- **Selecting tests by the import graph** (run only the medium tests whose imports reach a changed module).
  Deferred: Google and Meta select tests because they have millions; gg has under 100 test files, and after #140 and
  #144 the full stage is expected to take minutes. Revisit if the full stage stays slow after #145; CI still runs
  everything.
- **A runtime guard for `test/unit/`**: the launcher would `--import` a checked-in guard that makes every
  `node:child_process` function throw when the test file is under `test/unit/` (prototyped for PR #154). It would close
  the text check's gap above, but it adds launcher surface, an ADR 0016 amendment and a rules change for a gap that
  costs only fast-stage speed. Revisit if the fast stage slows down because a medium case got into `test/unit/`.
- **A naming rule alone** (`*.int.test.ts` beside unit files) for an early fast stage. Folded into #145, so files
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
