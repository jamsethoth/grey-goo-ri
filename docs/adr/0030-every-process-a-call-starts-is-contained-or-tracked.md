---
status: proposed
date: 2026-11-22
---

# Every process a call or a Check starts is held in gg's job, or tracked and ended

For grey-goo-ri issue #489, part of epic #506; the evidence is `docs/research/containment-escape.md`. The design
accepted a process that breaks away from gg's Windows job as a rare residual risk. The live Claude trial of 2026-11-21
showed it is routine: Claude Code runs an agent's commands in the Microsoft Store's PowerShell, a packaged (MSIX) app,
which Windows creates outside the caller's job whatever the job's limits, so every command such an agent runs, and
everything it starts, runs uncontained while the Action Event says `cleanup: { confirmed: true, containment: { kind:
"job" } }`. The research found a second route, which `BREAKAWAY_OK` does open: Git Bash starts each non-MSYS child with
breakaway. On Linux a double fork that closes its stdio gives the same false confirmation. As the open-issue
amendments of 2026-11-22 ask, this ADR also decides the Windows shell default (#420 defers to it) and #483's decision
1 (whether Codex's sandbox helper, MXC, escapes), one design for both, and makes the packaged-shell check one check
with #484's.

1. **gg's job allows no breakaway.** `createJob` (`lib/containment.ts`) sets `KILL_ON_JOB_CLOSE` alone, for a launch,
   a Check's shell runner and the suite launcher. A tool that asks to break away now fails to start its child
   (`ERROR_ACCESS_DENIED`); none probed did: npm, git, Git Bash, Windows PowerShell 5.1's `Start-Process`, `winget`,
   `wsl`, Claude Code, and Codex under MXC. Git Bash's children stay in the job.
2. **On Windows an Agent's shell is a PowerShell that is not a packaged app.** PowerShell stays the default (ADR 0025,
   G5 C); #420 adds Bash as a choice, which 1 contains. Claude Code takes the first `pwsh` on PATH, follows a Store
   alias to its packaged target, and has no setting that names its shell, so gg does not steer it: where PowerShell 7
   is installed by its MSI, Claude already takes it, and where Claude would resolve a packaged PowerShell, the shell
   check (5) fails preflight, naming the fix (install PowerShell 7 from its MSI, or put an unpackaged `pwsh.exe` first
   on PATH). The launch profile does not change.
3. **A Windows launch and a Check's shell runner watch their descendants, as on POSIX.** A polled process snapshot
   links a process to the job's members and the descendants already seen by its parent pid, when it started no
   earlier than that parent (#297's rule, which pid reuse needs: it was seen in two of the six real calls).
   That rule decides a link at first sight only: a seen process whose pid is reused between two polls would still seed
   the tree, and its replacement's children pass the rule. So the watcher opens a handle to each process it links,
   which keeps its pid from reuse while the handle is open (Raymond Chen, "When does a process ID become available for
   reuse?", The Old New Thing, 2011-01-07; the probe held 30 exited processes' handles and none of their pids was
   reused, where 7 of 30 released ones were), seeds only from processes whose handle has not signalled, and adopts or
   ends each through its handle. A process gg cannot open is a survivor.
   Each linked process outside gg's job is adopted when seen: into gg's job, else into a new kill-on-close job gg
   holds, nested in the job it is already in, else terminated. A packaged process's children escape again, so each is
   adopted in turn. At cleanup gg ends its job and every adopted job, closes its handles, and confirms each linked
   process gone; one it cannot confirm gone is a survivor, and the cleanup is not confirmed. The poll gap is the
   implementing ticket's choice: a snapshot costs about 38 ms, about 15% of one core at POSIX's 250 ms.
4. **A call's containment is recorded as `job` only while 3 holds for it.** An escapee gg could neither adopt nor
   terminate makes gg write the call's containment as `none`, so a resume rescues and holds it, never resets it in
   place (N1). `lib/rescue.ts` and `confirmedUnder` keep their rules; their premise, that a `job` call's processes all
   end with gg's handles, becomes true. A Pending cleanup hold's `closeJob` closes the adopted jobs too. No record or
   Event shape changes: `RECORD_SCHEMA_VERSION` and `EVENT_SCHEMA_VERSION` stay.
5. **One shell check serves both Harnesses** (#484's decision 1, epic #506's order). On every `gg doctor` and
   preflight (ADR 0028's cheap checks), the shell each Harness would start on win32, with an app execution alias
   followed to its target, must not lie under `\WindowsApps\`; it fails as a `harness-doctor-failed` Problem named
   `shell`. Under `gg doctor --probe`, a command run in that shell, started as gg starts a launch, must leave a child
   that is a member of gg's job: about 2 s, with no model call.
6. **Codex's sandbox helper needs nothing of its own** (#483 decision 1). #479 found every MXC process in gg's job, the
   helper and its `powershell.exe` included, with nothing left after exit or a tree kill. 1, 3 and 5 apply to Codex's
   launches as they are; #483's orphan case is a descendant in the job.
7. **On Linux, containment is a cgroup** (#128 for agent calls, #289 for `runShell`, one mechanism; the containment
   kind `cgroup` with its identity is reserved in `docs/interfaces/record.md`). A `systemd-run --user --scope` held and
   ended a double-forked, stdio-closed process in WSL. Until a cgroup is available, the process group and watcher stay.
8. **The residual risk, narrowed.** In place of "a tool that explicitly breaks away", gg accepts and names: on
   Windows, a process outside gg's job whose parent ended before a poll saw it, and a process a service, WMI or the task
   scheduler starts on a command's behalf, which no parent link ties to the command; on Linux without a cgroup, a
   process that leaves the process group and closes its stdio.

## Supersedes

These texts stay as they are until the owner decides this ADR; the decision then makes each edit below.

- Decisions L6, `docs/research/user-defined-procedures-decisions.md:920-921`: "a process that starts its own session
  or explicitly breaks away is an accepted residual risk". Edit: a new dated section of that document amends L6, N1
  and L14 by this ADR, as the 2026-11-02 section did; the old lines stay as written.
- Decision N1's research, the same document `:834-835`: "a job object with `BREAKAWAY_OK` loses only processes that
  explicitly break away (an accepted residual risk)". Amended by the same section.
- The N1 and L14 amendment, the same document `:1261-1262`: "a tool that explicitly breaks away from the job stays an
  accepted residual risk". Amended by the same section.
- ADR 0011, `docs/adr/0011-interrupted-attempts-are-rescued-and-retried.md:60`: "A tool that explicitly breaks away
  from the job is an accepted residual risk." Edit: an inline amendment naming this ADR, with 4's rule and 8's
  residual risk.
- ADR 0021, `docs/adr/0021-windows-commands-run-in-a-job-object-through-node-ffi.md:26-27`: "gg creates a job with
  kill-on-close and breakaway-OK" and "Nothing the command starts is outside the job". Edit: an inline amendment: no
  breakaway (1), and a packaged app is created outside the job, which the watcher (3) adopts or ends.
- GLOSSARY.md, Command Cleanup (`:214-215`): "a process that starts its own session or breaks away from the job
  escapes, an accepted residual risk". Edit: the watcher on Windows and 8's residual risk. Containment (`:200-203`)
  gains the adopted jobs.
- `docs/testing.md:239`: "A child that asked to break away: not seen, since it left the job." Edit: such a child fails
  to start under the suite launcher's job, and a packaged app's process is not seen.
- Not in the issue's list, found while writing: `docs/interfaces/record.md:852-856` says the job's kill-on-close "is
  what makes 'the writers are confirmed gone' true on Windows", and the comments at `lib/containment.ts:39` ("a child
  that asks is outside the job by design") and `:225` ("nothing the command starts is outside the job"). Edit:
  record.md's prose names the adopted jobs and 4's rule, with no shape change and so no version bump; the comments
  change with the code.
- Found by a census of every text that claims all of a command's processes sit in gg's job (`rg -i "break.?away|outside
  the job|outside it|nothing .* is outside|every process in it|all it starts"`):
  - ADR 0016, `docs/adr/0016-the-suite-launcher-takes-a-stage-from-a-closed-set.md:68`: "nothing a stage starts is
    outside it". Edit: an inline amendment naming this ADR: a packaged app's process is not in the stage's job, and the
    census does not see it.
  - `docs/interfaces/harness.md:163-166`, the `started` rule: "`kind` is `job` when a Windows job ends them all with
    gg". Edit: the rule names 4's; whether it bumps a version waits on the owner's decision on the frozen versions.
  - Code comments, each changed with the follow-up that changes its code: `scripts/run-suite.ts:184` ("A child that
    asks to break away still can, unseen") with follow-up 1; `lib/containment.ts:1-2` ("every process it starts,
    orphans included, held in a job object") and `:246` ("nothing the argv starts is outside the job"),
    `lib/containment-gate.ts:1-3` ("the argv and everything it starts begin inside the job"), and `lib/exec.ts:96`
    and `:269-270` ("the command and all it starts") and `:185-186` ("Nothing is left running when it resolves") with
    follow-up 2, since a packaged app's process is outside the job until the watcher adopts or ends it.
  - The contract test `test/contract/exec/exec.job.test.ts:150-180`, "a child that asks to break away from the job
    still starts", asserts the breakaway 1 removes. Follow-up 1 replaces it with "a child that asks to break away fails
    to start", over the same `test/support/child-scripts/breakaway-child.ts`.

## Considered options

- **Keep `BREAKAWAY_OK` and only track.** Rejected: every Git Bash command's children would escape and need chasing,
  where one flag keeps them in, and no tool probed needs breakaway.
- **Tracking alone, the packaged shell a doctor warning** (in place of 2's preflight failure). Not chosen: every
  command would then rely on the poll, and its gap, on the commonest path; it would keep a machine with only the
  Store's PowerShell running without a change. The owner's to weigh against 2.
- **Steer Claude to Windows PowerShell 5.1** by dropping WindowsApps from PATH and pointing `LOCALAPPDATA` at an empty
  directory (real call 2 stayed in the job). Rejected: `LOCALAPPDATA` is every tool's local data, npm's cache among
  them, and 5.1 lacks PowerShell 7's syntax an agent may use.
- **Reorder the launch PATH so an MSI PowerShell comes first.** Not needed: the MSI's entry is in the system PATH,
  which precedes the user's WindowsApps entry, and a launch profile change would bump its version (ADR 0027).
- **`SILENT_BREAKAWAY_OK`.** Rejected: everything after the first process leaves.
- **`PROC_THREAD_ATTRIBUTE_JOB_LIST`.** Rejected for this: it assigns gg's own child at creation, which the gate
  already does, and cannot reach a process the system creates outside the caller's job. ADR 0021's deferral for stdin
  stands.
- **WMI `Win32_ProcessStartTrace` or an ETW kernel-process session.** Rejected: both need an administrator, which gg
  is not. WMI's polled `__InstanceCreationEvent` needs none but has the watcher's gap and runs in another service.
- **A Linux subreaper.** Rejected for now: node does not reap the orphans it adopts, reaping them through `node:ffi`
  beside libuv was not probed, and with concurrent calls an adopted orphan names no call.
- **Retry in a fresh worktree (#69).** Orthogonal: it avoids a reset, not a writer that outlives gg.

## Consequences

- Four follow-up tickets, listed ready to file in the research note's last section, carry the failing tests: no
  breakaway; the Windows watcher with adoption, for a launch and a Check; a call's containment recorded as `none` when
  an escapee could not be ended; the shared shell check with its `--probe` half.
- A machine whose only PowerShell 7 is the Store's, the owner's among them, fails preflight until an unpackaged one
  is installed or put first on PATH.
- A Windows launch or Check pays for a process snapshot each poll, and a job per packaged process it adopts.
- #289's and #128's cgroup work gains the stdio-closed double fork as a case; Linux keeps its residual risk until then.
- #420 keeps PowerShell as the default and adds Bash under 1's containment; #484 builds 5's check once, for both
  Harnesses; #483 tests its orphan case in the job.
- The real portable PowerShell 7 was not run in a job (the probing session's permission classifier refused it): that
  it stays in is expected, not verified. Ticket 4's `--probe` half checks it on a machine that has one.
