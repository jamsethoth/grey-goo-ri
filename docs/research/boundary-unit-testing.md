# Unit-testing code at process and OS boundaries

Research note, 2026-11-03, against the tree at bdfb599. Line numbers refer to that tree. Upstream sources were read
on 2026-11-03 at the branch named in each link.

Since then grey-goo-ri PR #257 converted `lib/exec.mjs` to `lib/exec.ts` and moved its POSIX listing, watcher and tree
kill into `lib/process-tree.ts`, with one shared `growTree`; `lib/git.mjs` became `lib/git.ts`. The line numbers below
are the old files'; the follow-up ticket cites the current ones.

## The question and the short answer

How do well-known projects unit-test code that spawns processes, kills process trees, runs the git CLI and parses
its output, or holds Windows job objects, without spawning real processes? And what does that mean for `lib/exec.mjs`,
`lib/git.mjs` and `lib/containment.ts`?

None of them unit-tests the spawn, the kill or the job itself. Go, Node, libuv, CPython and Rust all test those with
real processes, usually by re-running their own binary as the child. VS Code, GitHub Desktop, dugite and Git itself run
real git in temp repositories. What they test without a process is the pure logic beside the boundary: building
command lines, parsing output, and the decisions taken over a parsed result. For gg that points to one extraction.
`exec.mjs` and `containment.ts` repeat the same descendant-closure and kill decisions three times, and today those run
only in POSIX-only or Windows-only contract cases. They can become a small pure module covered by unit tests on both
platforms. `git.mjs` stays in its contract suite, and the job object's FFI calls stay in theirs.

## Techniques found

### 1. The test's own binary as the child process

**What it is.** The child is the runtime or test binary itself, started with an argument or environment variable that
selects a small helper behaviour (echo, exit 3, hang, spawn an orphan). No external tool is involved, and every
platform behaves the same.

**Who uses it.**
- Go's `os/exec`. Before Go 1.18 it was `TestHelperProcess`, which returned unless `GO_WANT_HELPER_PROCESS=1`
  ([go1.17 `src/os/exec/exec_test.go`](https://github.com/golang/go/blob/go1.17/src/os/exec/exec_test.go)). Today
  `TestMain` sets `GO_EXEC_TEST_PID`, and a re-executed binary runs the helper its first argument names from a
  `helperCommands` map (`echo`, `cat`, `hang` and so on). `helperCommandContext` builds
  `exec.Command(testenv.Executable(t), name, args...)`
  ([master `src/os/exec/exec_test.go`](https://github.com/golang/go/blob/master/src/os/exec/exec_test.go)).
- Node core. A test runs `process.execPath` on its own file with `child`, and the file branches on
  `process.argv[2] === 'child'`
  ([`test/parallel/test-child-process-exec-timeout-expire.js`](https://github.com/nodejs/node/blob/main/test/parallel/test-child-process-exec-timeout-expire.js)).
  That test still allows platform variation in the signal it asserts (OpenBSD, macOS).
- libuv. `init_process_options` sets `args[0]` to `uv_exepath()` and `args[1]` to a helper name such as
  `spawn_helper1`, which `test/run-tests.c` defines
  ([`test/test-spawn.c`](https://github.com/libuv/libuv/blob/v1.x/test/test-spawn.c)).
- CPython. The children are `[sys.executable, "-c", ...]`
  ([`Lib/test/test_subprocess.py`](https://github.com/python/cpython/blob/main/Lib/test/test_subprocess.py)).
- Rust std. Rust uses a real `/bin/sh` or `cmd /C` through `shell_cmd()`, and `known_command()` when a test only
  needs some process to exist
  ([`library/std/src/process/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/process/tests.rs)).
- tree-kill, cross-spawn and execa. tree-kill `fork`s `test/spin.js`
  ([`test/test.js`](https://github.com/pkrumins/node-tree-kill/blob/master/test/test.js)). cross-spawn runs fixtures
  such as `say-foo` and `echo`
  ([`test/index.test.js`](https://github.com/moxystudio/node-cross-spawn/blob/master/test/index.test.js)). execa's
  force-kill tests run fixtures such as `no-killable.js` and check liveness with real timers
  ([`test/terminate/kill-force.js`](https://github.com/sindresorhus/execa/blob/main/test/terminate/kill-force.js)).

**Shows:** the real OS behaviour: pipes, exit codes, signals, timeouts and orphans. **Cannot show:** anything without
a process, so it is medium by docs/testing.md's sizes.

**Fit.** This is already gg's practice, as matching prior art. `test/contract/exec/exec.test.mjs` writes node scripts
with `script()` and runs them with `process.execPath`. The `test/support/*` helper processes (`lock-contender.mjs` and
others) are the same pattern. The `snapshotCommand` and `taskkillCommand` test hooks swap the external tool for such a
helper, as Go swaps `echo` for its own helper.

### 2. Pure functions beside the boundary, tested on literal inputs

**What it is.** The code that turns values into a command line, or a tool's output into values, is a separate
function, and unit tests call it on literal inputs. The spawn that uses it is still tested by spawning.

**Who uses it.**
- libuv. On Windows only, `argument_escaping` calls `quote_cmd_arg` and `make_program_args`, and
  `environment_creation` calls `make_program_env`. All three are declared `extern` in the test and are non-static in
  [`src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c), so a test can reach them
  ([`test/test-spawn.c`](https://github.com/libuv/libuv/blob/v1.x/test/test-spawn.c)).
- Rust std. `test_make_command_line` asserts the Windows command line `make_command_line` builds, without spawning
  ([`library/std/src/sys/process/windows/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/sys/process/windows/tests.rs)).
  `chk` asserts how `parse_lp_cmd_line` splits a command line
  ([`library/std/src/sys/args/windows/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/sys/args/windows/tests.rs)).
  Only `test_thread_handle` in the first file spawns, running `whoami`.
- CPython. `test_list2cmdline` calls `subprocess.list2cmdline` directly (`test_subprocess.py`, above).
- VS Code's git extension. Every suite in
  [`extensions/git/src/test/git.test.ts`](https://github.com/microsoft/vscode/blob/main/extensions/git/src/test/git.test.ts)
  calls a parser on a string: `GitStatusParser`, `parseGitmodules`, `parseGitRemotes`, `parseGitCommits`,
  `parseGitFileLog`, `parseLsTree`, `parseLsFiles` and `parseCoAuthors`. The one exception, `Git process input`, runs
  real git to check that an early exit raises no EPIPE.
- GitHub Desktop. `parsePorcelainStatus` is tested on literal NUL-separated strings
  ([`app/test/unit/status-parser-test.ts`](https://github.com/desktop/desktop/blob/development/app/test/unit/status-parser-test.ts)).
  `getStatus` itself is tested over real git: `app/test/unit/git/status-test.ts` builds repositories with dugite's
  `exec` ([link](https://github.com/desktop/desktop/blob/development/app/test/unit/git/status-test.ts)).
- simple-git. It calls `parseStatusSummary('## master...origin/master [ahead 3]')` directly
  ([`test/unit/status.spec.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/status.spec.ts)).
- Git. Its end-to-end suite runs real git in a fresh trash directory for each script
  ([`t/README`](https://github.com/git/git/blob/master/t/README)). It reaches internals through `t/helper/test-tool`
  subcommands such as `run-command`, `parse-options` and `date`
  ([`t/helper/test-tool.c`](https://github.com/git/git/blob/master/t/helper/test-tool.c)). It then added C unit tests
  because "we spend a significant amount of effort crafting end-to-end tests for error conditions", some rare error
  conditions went untested, and each test-tool call is a separate process
  ([`Documentation/technical/unit-tests.adoc`](https://github.com/git/git/blob/master/Documentation/technical/unit-tests.adoc)).
  That document recommended a custom TAP framework. The current `t/unit-tests/unit-test.c` runs `clar_test`
  ([link](https://github.com/git/git/blob/master/t/unit-tests/unit-test.c)).

**Shows:** every input the logic handles, including inputs a real process produces only by race or never on this
platform. It shows them in a small test, on every OS. **Cannot show:** that the real tool emits that output or accepts
that command line. A contract case still has to run the real tool through the same function.

**Fit.** Rule 9 ("asserted at the lowest size that can show it") favours this technique. It is in tension with "never
the external tool's command lines or output formats" when the literal input is a hand-written sample of git's or
`ps`'s text, since that sample is a stub of the tool's output format. The tension goes away when the extracted function
takes gg's own values, such as a process table of `[pid, parentPid, startTime]` rows or a job's member list, rather
than raw tool text. The parse of the raw text then stays in the boundary module, where the contract suite feeds it the
real tool's output. Git's own reasoning matches gg's gap: the cases that are expensive end-to-end are the error and
race conditions.

### 3. Validation that fails before any process exists

**What it is.** Invalid options throw synchronously, so a test needs no child process.

**Who uses it.** Node's spawnSync validation test passes a nonexistent command, `not_a_real_command`, and expects
`ERR_INVALID_ARG_TYPE` and similar errors
([`test-child-process-spawnsync-validation-errors.js`](https://github.com/nodejs/node/blob/main/test/parallel/test-child-process-spawnsync-validation-errors.js)).
execa's `forceKillAfterDelay` tests assert a `TypeError` thrown before spawn (`kill-force.js`, above).

**Shows:** argument checking. **Cannot show:** anything about running. **Fit.** It does not apply to gg: `run` and
`runShell` do almost no validation of their own.

### 4. A scripted fake of the exec layer, or a replaced `child_process`

**What it is.** The test supplies the output each command line returns, or swaps the process module for a mock and
asserts which commands ran.

**Who uses it.**
- Kubernetes `k8s.io/utils/exec/testing`. `FakeExec` is "a simple scripted Interface type" with a `CommandScript`,
  an optional `ExactOrder`, and `FakeCmd`s carrying `Argv` and `CombinedOutputScript`
  ([`exec/testing/fake_exec.go`](https://github.com/kubernetes/utils/blob/master/exec/testing/fake_exec.go)).
- simple-git. `vi.doMock('child_process', () => mockChildProcessModule)`
  ([`test/unit/__mocks__/mock-child-process.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/__mocks__/mock-child-process.ts)).
  `closeWithSuccess` makes the mock process emit stdout, `exit` and `close`
  ([`test/unit/__fixtures__/child-processes.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/__fixtures__/child-processes.ts)).
  Tests then call `assertExecutedCommands(...)` (`status.spec.ts`, above).
- cross-spawn only `jest.spyOn`s `spawn` to force `env`, as a Jest workaround. Its behaviour is tested by real spawns
  (`index.test.js`, above).

**Shows:** the calling code's handling of whatever output the script gives. **Cannot show:** that the real tool gives
that output, and nothing keeps the script in step with the real tool.

**Fit.** It conflicts with three rules in docs/testing.md. It replaces a module (`jest.mock`-style). It doubles the
external tool's command lines and output. Its asserts are interaction asserts on argv. gg's fake git, which works at
the verb level and passes the same contract suite as `lib/git.mjs`, is the stricter form of this idea and is matching
prior art. Nothing further is recommended here.

### 5. Inspecting a command without running it

**What it is.** The command object exposes what it would run, and a test asserts on that.

**Who uses it.** Go's `Cmd.String` (go1.13) and `Cmd.Environ` (go1.19) ([pkg.go.dev](https://pkg.go.dev/os/exec#Cmd)).
Rust's `debug_print` test asserts a `Command`'s `{:?}` output without spawning (`process/tests.rs`, above), and
`windows_env_unicode_case` reads `get_envs` (`sys/process/windows/tests.rs`, above).

**Fit.** It does not fit gg. Asserting git's argv is an interaction assert on the tool's command line, which rule 3
and the doubles rule both exclude. `layout.test.mjs` keeps git syntax inside `lib/git.mjs` (grey-goo-ri issue #144).

### 6. Real OS objects in process, with no child

**What it is.** The kernel object is created and queried inside the test process.

**Who uses it.** Chromium's [`sandbox/win/src/job_unittest.cc`](https://chromium.googlesource.com/chromium/src/+/main/sandbox/win/src/job_unittest.cc)
calls `Job::Init` and `QueryInformationJobObject` on real job objects. None of its four tests creates or assigns a
process. win32job-rs's only test, `it_works`, creates a job and sets and clears limits, with no process
([`src/job.rs`](https://github.com/ohadravid/win32job-rs/blob/master/src/job.rs)). libuv puts every non-detached child
in a global kill-on-close job (`uv__init_global_job_handle`, `src/win/process.c`), but `test-spawn.c` has no test that
names the job.

**Shows:** that the Win32 calls and struct layouts work, without a child process. **Cannot show:** membership,
termination or orphans, which need processes.

**Fit.** `containment.createJob` needs a pid to assign, and the only pid at hand in a unit test is the test runner's
own, which a kill-on-close job would take down. A process-free job test would cover only `setLimits` and an empty
`members()`, and it would be a Windows-only unit test. That is not worth a restructure. Firefox's sandbox tests were
not examined.

### 7. Seams on the boundary object

**What it is.** The policies that make process code hard to test, such as how to kill, when to stop waiting and which
clock to use, are fields or options that a test sets.

**Who uses it.** Go 1.20 added `Cmd.Cancel` and `Cmd.WaitDelay`, which "specify the behavior of the Cmd when its
associated Context is canceled or its process exits with I/O pipes still held open by a child process"
([Go 1.20 release notes](https://go.dev/doc/go1.20#os/exec)). In Feathers' terms these are object seams: "a place
where you can alter behavior in your program without editing in that place", each with "an enabling point, a place
where you can make the decision to use one behavior or another"
([*Working Effectively with Legacy Code*, The Seam Model](https://www.informit.com/articles/article.aspx?p=359417&seqNum=2),
[Seam Types](https://www.informit.com/articles/article.aspx?p=359417&seqNum=3)).

**Fit.** This is matching prior art in gg. `runShell`'s `testHooks` provide `killPid`, `timers`, `signal`, `onWatch`,
`snapshotCommand` and `taskkillCommand`. `createExec({ kernel32 })` and `createGit({ sleep })` are factory options,
and `bin/gg.mjs` is the enabling point (ADR 0019).

### 8. Nullables, embedded stubs and narrow integration tests (James Shore)

**What it is.** Shore's [Testing Without Mocks](https://www.jamesshore.com/v2/projects/nullables/testing-without-mocks)
puts each external system behind an Infrastructure Wrapper: "one wrapper class that's solely responsible for
interfacing with that system". The wrapper is tested by Narrow Integration Tests: "Test your external communication
for real." Callers' tests run the wrapper's `createNull()` form. That form uses an Embedded Stub: "stub out the
third-party code that accesses external systems", "a stub of the third-party code, not your code". Configurable
Responses and Output Tracking make it observable. The article's command-line example wraps `process.argv` and stdout.
It does not cover child processes.

**Fit.** gg already has the structure. `lib/git.mjs` and `lib/exec.mjs` are the wrappers, `test/contract/` holds the
narrow integration tests, and the fake git and `golden.setup`'s red/green `runShell` give configurable responses. Two
differences remain, and both are deliberate in gg. gg's fakes live in `test/support/` beside their contract suite, not
in production code. An embedded stub of `child_process` would hand-write the external tool's output, which the doubles
rule excludes. Nullables would not reach the code in question either: they make *callers* of the wrapper testable,
not the wrapper's own process logic.

### 9. Functional core, imperative shell (Gary Bernhardt)

**What it is.** The decisions live in a functional core that takes and returns values. A thin imperative shell "manipulates stdin,
stdout, the database, and the network, all based on values produced by the functional core", so "testing the
functional pieces is very easy, and it often naturally allows isolated testing with no test doubles"
([screencast](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)). The
[Boundaries talk](https://www.destroyallsoftware.com/talks/boundaries) (SCNA 2012) argues for simple values "as the
boundaries between components and subsystems".

**Fit.** This is the design rule behind technique 2 as applied below. The core takes a process table and returns pids
to kill and pids to report. It needs no double at all, so it falls under docs/testing.md's first preference, the real
implementation.

### 10. Git tools test against real git

dugite, GitHub Desktop's git layer and Git itself all run real git in temp repositories. dugite's `test/` has `fast`,
`slow` and `external` directories ([tree](https://github.com/desktop/dugite/tree/main/test)), and even
`test/fast/status-test.ts` runs `exec(['init'], testRepoPath)` and then `status --porcelain -z`
([link](https://github.com/desktop/dugite/blob/main/test/fast/status-test.ts)). isomorphic-git avoids the CLI by
reimplementing git in JavaScript ([repo](https://github.com/isomorphic-git/isomorphic-git)), which docs/testing.md
rejected for gg as "a second implementation of git". gg's `test/contract/git/` is matching prior art.

## Applied to grey-goo-ri

Background that shapes the answer:

- Coverage. The coverage stage measures `lib/` *without* the three modules (docs/testing.md, Test sizes and stages).
  Their unit figures of 19%, 52% and 39% come only from module load: `github.mjs` imports `exec.mjs`, which imports
  `containment.ts`, and `fake-git.mjs` and `golden.mjs` import `git.mjs` for `slugify` and `worktreePath`. Nothing
  ratchets those numbers. Code moved out into a new pure module *joins* the measured set and must arrive fully covered.
- `test/unit/layout.test.mjs` bans unit files from importing `lib/exec.mjs` or `lib/git.mjs`. It also bans git
  syntax (`refs/heads/`, `'HEAD'`, `^{`, `:(...)` pathspecs, `runGit`) in every module but `lib/git.mjs`. So git
  argument building cannot move out, and any new module must be `.ts` (ADR 0018) with an AGENTS.md layout row.
- `test/contract/exec/exec.test.mjs` is rewritten by grey-goo-ri issue #212 (AGENTS.md, Do not copy), which is the
  natural place to move cases down.

### lib/exec.mjs: extract the process-tree decisions (recommended)

The pure logic, today reachable only through real processes:

- **Descendant closure, written three times.** The `watch` loop body (`exec.mjs` 106-117) prunes `seen` of pids no
  longer listed and grows the set linked to `rootPid`. `killTree` (165-174) grows the alive set from `seen` entries
  whose start time still matches. `containment.linkedTo` (`containment.ts` 77-88) runs the same fixpoint over parent
  pids. One function, such as `descendants(rows, roots, excludePid)`, replaces all three.
- **The kill plan** (`killTree` 157-180), as a function of `rootPid`, `seen`, the listing and its error. It returns
  which pids to kill and which to report. The failed-listing case reports every seen pid as "not verified gone". A
  reused pid, listed with another start time, is left alone and reported. A pid the watcher saw exit is not
  reported. Today each of these is a POSIX-only contract case that rewrites real `ps` output through an awk script,
  so it never runs on the owner's Windows machine.
- **The listing's row filter and error decision** (`snapshot` 81-89): lines to `[pid, ppid, started]` and "unusable
  when the exit code is nonzero or there are no rows". The text split stays beside the `ps` call. If it moves, its
  unit cases should use a sample captured from real `ps` in the contract suite, not hand-written text.
- **Result texts.** `timeoutNote` (194-197), `run`'s failure message with its argument summary (26-28), and the
  leftovers note (357-359). These are small. Unit-test them only if they come out of the move for free.

What must stay in the contract suite: spawning and pipes, including multi-byte reads, stdin EPIPE and stdin EOF. Also
the real `ps` format and `lstart` under `TZ=UTC LC_ALL=C`, `SIGSTOP` and `SIGKILL` on the process group, the watcher
racing real reparenting, the slow-`ps` and slow-`taskkill` real-time cases, timer and `exit`/`close` ordering, and one
wiring case per path (POSIX kill, job, taskkill fallback), which shows that the extracted decisions are actually used.

**Recommendation.** Add a `lib/process-tree.ts` of about 60-80 lines holding the closure, the kill plan and the
row filter, with a `test/unit/process-tree.test.ts` of 10-15 cases. `exec.mjs` and `containment.ts` shrink by about 30
lines between them. Under rule 9, two or three POSIX contract cases that only vary the listing move down to unit: the
reused pid, the pid the watcher saw exit, and the failed snapshot. One stays as wiring. This is a small to medium ticket,
best folded into #212. The gain is the decision logic running in the fast stage on both platforms, not a change in the
exec contract figure.

### lib/containment.ts: extract the leftovers filter, keep the FFI in contract

The pure logic:

- `leftovers` (`containment.ts` 145-154). Members less the pids not in the snapshot (still exiting) and less the
  `conhost.exe` whose parent is the command. As `leftoverPids(members, entries, commandPid)` it shows the "member
  still exiting" race, which a real job produces only by chance, and the conhost rule, on any OS.
- `linkedTo`'s closure, which is the shared `descendants` above.

What stays in contract: `createJob`'s calls, their order and its handle unwinding (110-129). The struct offsets of
`setLimits`, `members()` and `processes()`, including the `ERROR_MORE_DATA` regrowth, which is covered by the existing
small-buffer case through `withKernel32`. Also `openKernel32`'s warning suppression, the `cmd.exe` gate line, and
`terminate`, `emptied` and `release`. Unit-testing these would need a fake kernel32, a hand-written model of Win32 struct
layouts and error codes. That doubles an interface gg does not own, and a fake can model it no more faithfully than the
code under test already does. The gate line's string is a fixed template, so a unit assert on it would repeat the
literal. Only `cmd.exe` shows it works, which the contract case "the command starts as in a fresh shell" already does.
The process-free job test of technique 6 is not worth it (see there). `terminateJob` and `takeDownTree` in `exec.mjs`
are short outcome mappings already reached on Windows through `withKernel32` and `taskkillCommand`. Leave them.

**Recommendation.** Put `leftoverPids` and the shared closure in the same `lib/process-tree.ts`, with 3-4 unit cases.
That is about 15 lines out of `containment.ts`, done in the same ticket as exec. Everything else stays in
`test/contract/exec/`, which already covers the module at 98% on Windows.

### lib/git.mjs: keep it in contract tests

The pure logic is small, and git's delimiters were chosen to keep it trivial. That logic is `pathspecs` (24-38), the
`listWorktrees` block parse (125-131), the `commitLog` split on `%x1e`/`%x1f` (201-210), `treeDiff`'s pairs (219-221),
`conflictedPaths` (240), `diffStats`' numstat match (253-256) and the `ls-files -v` tag filter in `fingerprint`
(273-280). Each verb already runs against real git *and* the fake git in `test/contract/git/`, at 99% on Windows,
including the `index.lock` retry with a real lock file and the recorded `sleep`. `pathspecs` cannot leave `git.mjs`
(the layout test bans `:(...)` elsewhere), and unit files cannot import `git.mjs`. Splitting out the parsers would mean
hand-writing git output in unit cases, which stubs git's output format and so breaks the doubles rule. It would also
duplicate what the contract already shows at the size that can show it: that real git produces that format.

**Recommendation.** No change. Revisit only if a parser grows to the size where VS Code and GitHub Desktop split
theirs, such as porcelain v2 status or a diff-hunk parser. Then make it a pure function inside `git.mjs`'s family,
whose unit cases use samples the contract suite captures from real git. That would need a layout-rule change to let a
unit test reach it.

## Sources

- Go: [`src/os/exec/exec_test.go` at go1.17](https://github.com/golang/go/blob/go1.17/src/os/exec/exec_test.go)
  (`TestHelperProcess`, `GO_WANT_HELPER_PROCESS`);
  [`src/os/exec/exec_test.go` at master](https://github.com/golang/go/blob/master/src/os/exec/exec_test.go)
  (`TestMain`, `GO_EXEC_TEST_PID`, `helperCommands`); [`os/exec.Cmd`](https://pkg.go.dev/os/exec#Cmd);
  [Go 1.20 release notes, os/exec](https://go.dev/doc/go1.20#os/exec).
- Node.js: [`test/parallel/test-child-process-exec-timeout-expire.js`](https://github.com/nodejs/node/blob/main/test/parallel/test-child-process-exec-timeout-expire.js),
  [`test/parallel/test-child-process-spawnsync-validation-errors.js`](https://github.com/nodejs/node/blob/main/test/parallel/test-child-process-spawnsync-validation-errors.js).
- libuv: [`test/test-spawn.c`](https://github.com/libuv/libuv/blob/v1.x/test/test-spawn.c),
  [`src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c).
- execa: [`test/terminate/kill-force.js`](https://github.com/sindresorhus/execa/blob/main/test/terminate/kill-force.js),
  [`test/arguments/escape.js`](https://github.com/sindresorhus/execa/blob/main/test/arguments/escape.js) (escaping
  checked through real spawns).
- tree-kill: [`index.js`](https://github.com/pkrumins/node-tree-kill/blob/master/index.js) (`ps --ppid` / `pgrep -P`
  / `taskkill /T /F`, spawner hard-coded), [`test/test.js`](https://github.com/pkrumins/node-tree-kill/blob/master/test/test.js).
- cross-spawn: [`test/index.test.js`](https://github.com/moxystudio/node-cross-spawn/blob/master/test/index.test.js).
- VS Code: [`extensions/git/src/test/git.test.ts`](https://github.com/microsoft/vscode/blob/main/extensions/git/src/test/git.test.ts).
- GitHub Desktop: [`app/test/unit/status-parser-test.ts`](https://github.com/desktop/desktop/blob/development/app/test/unit/status-parser-test.ts),
  [`app/test/unit/git/status-test.ts`](https://github.com/desktop/desktop/blob/development/app/test/unit/git/status-test.ts).
- dugite: [`test/`](https://github.com/desktop/dugite/tree/main/test),
  [`test/fast/status-test.ts`](https://github.com/desktop/dugite/blob/main/test/fast/status-test.ts).
- simple-git: [`test/unit/status.spec.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/status.spec.ts),
  [`test/unit/__mocks__/mock-child-process.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/__mocks__/mock-child-process.ts),
  [`test/unit/__fixtures__/child-processes.ts`](https://github.com/steveukx/git-js/blob/main/simple-git/test/unit/__fixtures__/child-processes.ts).
- isomorphic-git: [repository](https://github.com/isomorphic-git/isomorphic-git).
- Git: [`t/README`](https://github.com/git/git/blob/master/t/README),
  [`t/helper/test-tool.c`](https://github.com/git/git/blob/master/t/helper/test-tool.c),
  [`Documentation/technical/unit-tests.adoc`](https://github.com/git/git/blob/master/Documentation/technical/unit-tests.adoc),
  [`t/unit-tests/unit-test.c`](https://github.com/git/git/blob/master/t/unit-tests/unit-test.c).
- Rust: [`library/std/src/process/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/process/tests.rs),
  [`library/std/src/sys/process/windows/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/sys/process/windows/tests.rs),
  [`library/std/src/sys/args/windows/tests.rs`](https://github.com/rust-lang/rust/blob/main/library/std/src/sys/args/windows/tests.rs);
  win32job-rs [`src/job.rs`](https://github.com/ohadravid/win32job-rs/blob/master/src/job.rs).
- Chromium: [`sandbox/win/src/job_unittest.cc`](https://chromium.googlesource.com/chromium/src/+/main/sandbox/win/src/job_unittest.cc).
- CPython: [`Lib/test/test_subprocess.py`](https://github.com/python/cpython/blob/main/Lib/test/test_subprocess.py).
- Kubernetes: [`k8s.io/utils` `exec/testing/fake_exec.go`](https://github.com/kubernetes/utils/blob/master/exec/testing/fake_exec.go).
- James Shore, [Testing Without Mocks: A Pattern Language](https://www.jamesshore.com/v2/projects/nullables/testing-without-mocks).
- Michael Feathers, *Working Effectively with Legacy Code*, The Seam Model:
  [Seams](https://www.informit.com/articles/article.aspx?p=359417&seqNum=2),
  [Seam Types](https://www.informit.com/articles/article.aspx?p=359417&seqNum=3).
- Gary Bernhardt, [Functional Core, Imperative Shell](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)
  and [Boundaries](https://www.destroyallsoftware.com/talks/boundaries) (SCNA 2012).
