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
- The deps are named options, not one `deps` key: `gh`, `git`, `exec`, `integrity` and `clock` already were, and every
  test that builds or changes a Run's options names them so. A `deps` key would rename about 250 test lines and change
  nothing a reader sees; the TypeScript conversions of #204 and #207 can give the fields one named type.
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
- **A `deps` key** wrapping the named options: see above.
