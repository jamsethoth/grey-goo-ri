---
status: accepted
date: 2026-11-01
---

# Dependencies are passed down from the entry point, not swapped in module state

grey-goo-ri issue #153 gave tests seams in `lib/` as module-level setters: `github.setGh`, `git.setSleep`,
`locks.setClock`, `locks.setAttemptWrapper`, `record.setSaveHook` and `events.setAppendHook`. Each swapped a module-level
`let` for every caller in the process and returned the previous value for the test to put back. A case that failed
before its restore, or restored in the wrong order, left its fake installed for the next case: grey-goo-ri issue #217
found two such leaks, one of them in `test/unit/run.test.mjs`, and fixed them by care in each case, which the next
case could forget. A reader also could not see at a call site which git, gh or clock it reached. The other style,
already used for `runTarget`'s `git`, `gh` and `exec` and for `integrity.withGit`, passed the dependency in. Epic #193
chose that style for all of them.

Every external dependency of a Run is built once at the entry point and passed down:

- A module with a dependency exports a factory over it: `github.createGh(transport)`, `git.createGit({ sleep })`,
  `locks.createLocks({ clock, wrapAttempt })` and `record.stateDatabase({ beforeSave, beforeAppend })`, whose
  `beforeAppend` `events.eventLog(commonDir, base, database)` calls before each Event insert. Given nothing, each builds
  the real one.
- `bin/gg.mjs` builds the deps (`gh`, `git`, `exec`, `locks`, `database` and `clock`) and passes them as named options
  of `run.runTarget`, which passes them to `interpreter.runExecution`. The interpreter keeps them in the context it hands
  the write-ahead effects, the Terminals, Reconciliation and the Integrity Assertions; the integrity is built from the
  `git` and `locks` unless the caller passes one.
- The deps become one `deps` key with a `Deps` type, in two steps. Until then they are named options, as `gh`, `git`,
  `exec`, `integrity` and `clock` already were, so this change renames none of the about 250 test lines that build or
  change a Run's options. #204, which declares the interpreter's Run context as one type, makes `runExecution` take
  `deps: Deps` and exports `Deps` from the interpreter; #207 makes `runTarget` take the same `deps` and `bin/gg.ts`
  build it. Each moves its function's test call sites from `options.git` to `options.deps.git`. With one key, a layer that only
  passes the deps along does not name each one, so a new dependency touches only where it is built and where it is
  used, and `tsc` reports a missing one: adding `locks` and `database` here meant naming them in four places in
  `run.mjs` (`runRepo`'s parameters and Run context, `admit`'s parameters and the `runExecution` call), two of which
  only pass them on.
- A dep is something outside the process that a test replaces with a fake or a stub: GitHub, git, the shell, the State
  Database, the locks and time, and the integrity built from git and the locks. Configuration, the Harnesses, the log
  and the Ticket are not deps, so `deps` does not become a second options bag.
- `git`, `locks` and `record` also export the functions of their real instance, for callers that take no seam: `gg
  doctor`, the contract suites and the helper processes tests spawn. `github` does not, so nothing reaches the real `gh`
  without asking for it.
- `exec.runShell`'s test-only options sit behind one `testHooks` option, so its signature shows only its real inputs,
  `cwd` and `timeoutMs`.

ESLint bans a module-level `let` and an exported `set*` function in every file, `.mjs` included. Two module-level
values stay, each with a disable comment that gives its reason: `git.mjs`'s queue of `git worktree add` calls, which
belongs to the process because the `.git/config` lock it orders belongs to the repository, and
`test/support/template-repos.mjs`'s template repository, built once per test process. `record.mjs`'s connection cache,
one connection per State Database, is a `const` map and so is not flagged.

Tests build the deps with fakes in `test/support/`: a fixture's options carry its fake gh, git, clock and State
Database, and a case swaps one by replacing the field. The State Database's hooks belong to the case: `golden.onSave`,
`golden.failSaves` and `golden.failAppends` add a hook to the set the case's fixtures write through, kept per test
context, so a hook ends with its case whether it passes or fails.

## Consequences

- No test can leave a fake installed for the next case. The case that checked that a run fixture puts gh back
  (`a case with several run fixtures leaves gh as it found it`, #217) is gone with the module-level transport it
  checked.
- A function that saves a record or takes a lock takes the State Database or the locks from its caller's context; one
  that does not is visible at its call site.
- A new seam is a parameter or a factory option, never a setter: the lint rule fails the setter.

## Considered and rejected

- **Keeping the setters with automatic restore** (a `t.after` registered by each setter). It fixes the leak but keeps
  state shared by every caller, which `node:test`'s first-in, first-out hook order already made fragile (#217).
- **Async context** (`AsyncLocalStorage`) to carry the deps without parameters. It hides which dependency a call reaches,
  the problem this ADR removes.
- **A `deps` key in this change.** It would rename about 250 test lines now and again when #204 declares the Run
  context's type; it lands with the types instead, as above.
