# How gg can contain, or at least track, every process a call starts (#489)

Research record for grey-goo-ri issue #489 (epic #506), probed on 2026-11-22 on native Windows 11 Pro 10.0.26300 (Node
26.13.0, Claude Code 2.1.330, the Microsoft Store's PowerShell 7.7.0.0,
`Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe`, Git for Windows 2.45.1), as a user who is not an administrator, and
in WSL (Ubuntu 26.04, kernel 6.6.114.1-microsoft-standard-WSL2, systemd 259, cgroup v2), with gg at 2934c62. It answers
the issue's five questions and recommends the design ADR 0030 decides (accepted 2026-11-22). The probe scripts and their full output were
kept outside the repository; this note copies the decisive commands and lines, with paths shortened.

**How the Windows probes ran.** A probe started a command as `lib/containment.ts` does, through `cmd.exe` behind the
stdin gate (`start`) or as an argv behind `lib/containment-gate.ts` (`startArgv`), in a job with one of three limit
sets: gg's own (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK`, 0x2800, as `lib/containment.ts:39-40,160` sets them), `nobreakaway`
(`KILL_ON_JOB_CLOSE` alone, 0x2000) or `silent` (`KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`). Every 300 ms it listed the
processes it had started (descendants of its root, or a unique marker in the command line) and printed for each
`thisJob` (`IsProcessInJob(process, job)`) and `anyJob` (`IsProcessInJob(process, NULL)`), at first sight and at the
end (`first->last`). Then it closed the job, which kill-on-close ends, named what survived, and killed that by pid. The
held process is `node -e "setTimeout(() => {}, …)" <marker>`, started by the shell under test. Each row reads
`pid <- parent pid`.

**Real Claude calls.** 8 of the 10 the owner allowed (Q1 A), on haiku at effort low, each run by hand behind gg's gate
in a probe job (`node job-probe.ts <job flags> 75 <marker> --argv claude.exe …`, from `claude-call.sh <n> <job flags>
<tool> <environment>`) and asked to run one command that leaves a marked node running:

```
claude.exe -p "Use the PowerShell tool to run exactly this command once: & .\hold.ps1 -Marker GG489C1 -Seconds 90
  -Detach  Then reply with the command's output and nothing else." --model haiku --effort low --setting-sources ''
  --strict-mcp-config --settings <settings.json> --permission-mode acceptEdits --permission-prompts none
  --tools PowerShell --output-format stream-json --verbose
```

No test called `claude`. After the probes no process of theirs was running, on Windows or in WSL.

## Summary

1. **Why.** A packaged (MSIX) executable, such as the Store's `pwsh.exe`, is created outside the caller's job whatever
   the job's breakaway limits, and starts normally. `BREAKAWAY_OK` is not its cause. Each process a packaged shell
   starts is outside every job too. A second route, which `BREAKAWAY_OK` does open: Git Bash (MSYS2) starts each
   non-MSYS child with breakaway, so under gg's limits that child leaves the job.
2. **Containing.** Dropping `BREAKAWAY_OK` keeps Git Bash's children in and broke nothing probed. Nothing gg sets on
   its job keeps a packaged app in. Pointing Claude Code at a PowerShell that is not packaged keeps the whole shell
   tree in the job (two real calls). Adopting each escapee into a job gg holds works, but must chase every child.
3. **Tracking.** A Toolhelp snapshot polled and joined by parent pid and creation time sees every escapee probed, with
   no privilege, at 38 ms a snapshot. Its one gap is a process whose parent ends between two polls. Kernel
   notifications (WMI's trace class, ETW) need an administrator.
4. **Linux.** A double fork that closes its stdio leaves gg's process group and watcher, and gg's cleanup says
   `confirmed: true` while it runs on: the same false confirmation. A `systemd-run --user --scope` cgroup holds and
   kills it.
5. **Detection.** A static check (the shell resolves under `\WindowsApps\`) is cheap; a live check (a command's child
   is a member of gg's job) takes about 2 s with no model call.

Recommended: no breakaway; on Windows an Agent's shell is a PowerShell that is not packaged, checked by one shell check
both Harnesses share; a Windows descendant watcher for a launch and a Check that adopts or ends each process outside
gg's job, and saves the call's containment as `none` when it first sees one; cgroups on Linux through #128 and #289. Codex's sandbox helper
needs nothing of its own.

## 1. Why the escape happens

**A packaged executable is created outside the caller's job, whatever the job's limits; it does not fail to start.**

| what starts the Store `pwsh.exe` | job limits | pwsh in gg's job | pwsh in any job | its `node` child | after the job closed |
| --- | --- | --- | --- | --- | --- |
| `cmd.exe` in the job, by the PATH alias (2 runs) | gg | false | false -> true | in no job | pwsh and node survive |
| same | nobreakaway | false | true | in no job | pwsh and node survive |
| same | silent | false | true | in no job | pwsh and node survive (and cmd's conhost) |
| `cmd.exe`, the direct `C:\Program Files\WindowsApps\…\pwsh.exe` path, as Claude runs it | nobreakaway | false | false -> true | in no job | pwsh and node survive |
| gg's gate, no shell (`startArgv`), the direct path | nobreakaway | false | false -> true | in no job | pwsh and node survive |
| real Claude, PowerShell tool, default PATH (call 1) | gg | false | true | in no job | node survives |

gg's own limits, the PATH alias (the watch time, `<seconds>`, was not kept):

```
node job-probe.ts gg <seconds> GG489P1A pwsh.exe -NoProfile -File hold.ps1 GG489P1A 10
job flags gg 0x2800
  33272 <- 87648 thisJob=true anyJob=true C:\Windows\System32\cmd.exe
      cmd.exe /d /s /c "set /p GG_GATE= & set "GG_GATE=" & pwsh.exe -NoProfile -File hold.ps1 GG489P1A 10"
  88604 <- 33272 thisJob=false anyJob=true C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe
  76844 <- 88604 thisJob=false anyJob=false C:\Program Files\nodejs\node.exe
after the job closed, survivors: 88604 pwsh.exe, 76844 node.exe
```

Without `BREAKAWAY_OK`, the direct path:

```
node job-probe.ts nobreakaway <seconds> GG489P1E "C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe" -NoProfile -File hold.ps1 GG489P1E 10
job flags nobreakaway 0x2000
  15608 <- 100904 thisJob=true->true anyJob=true->true C:\Windows\System32\cmd.exe
  98288 <- 15608 thisJob=false->false anyJob=false->true C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe
  98592 <- 98288 thisJob=false->false anyJob=false->false C:\Program Files\nodejs\node.exe
after the job closed, survivors: 98288 pwsh.exe, 98592 node.exe
```

- The packaged process is first seen in no job, then in a job that is not gg's: Windows creates it outside the caller's
  job and places it in a job of its own afterwards. Its parent pid is still the `cmd.exe` or `claude.exe` that asked,
  so the parent link survives in every row.
- Inferred, not observed: the system's packaged-app activation creates the process, so no limit of the caller's job
  applies to it. Claude Code's own binary says as much: "The target executable '…' appears to be a packaged (MSIX)
  app. Packaged apps cannot be launched inside a sandboxed container."
- What a packaged pwsh starts is outside every job, even after pwsh itself is assigned to gg's job: with pwsh adopted
  under `nobreakaway`, its node child was first seen `thisJob=false anyJob=false`. Each process a packaged shell
  starts escapes on its own, so containing pwsh is not enough.
- So the issue's inference, that a packaged app's process gets a job of its own "which gg's `BREAKAWAY_OK` lets it
  leave for", does not hold: the escape happens with `BREAKAWAY_OK` off too.
- ADR 0021's "a tool that asks to break away fails to start its child" holds for an ordinary process. For Claude Code's
  PowerShell tool it does not arise: its packaged shell starts, outside the job, with or without `BREAKAWAY_OK`. Every
  command such an agent runs, and everything those commands start, is outside gg's containment.
- **Git Bash breaks away under gg's current limits.** MSYS2 starts a non-MSYS child with breakaway when the job allows
  it. Under gg's limits Git Bash's `node` is in no job and survives the job's close; real Claude's Bash tool (call 4)
  left `nohup.exe` and `node.exe` running. Under `nobreakaway` the whole tree stays in gg's job and ends with it, and
  nothing fails (call 5). Under `silent` everything after `cmd.exe` leaves.

  ```
  job flags gg 0x2800
    101596 <- 98236 thisJob=true->true anyJob=true->true C:\Program Files\Git\bin\bash.exe
    62404 <- 78208 thisJob=true->true anyJob=true->true C:\Program Files\Git\usr\bin\bash.exe
    92928 <- 62404 thisJob=false->false anyJob=false->false C:\Program Files\nodejs\node.exe
  after the job closed, survivors: 92928 node.exe

  job flags nobreakaway 0x2000
    65176 <- 94464 thisJob=true->true anyJob=true->true C:\Program Files\Git\usr\bin\bash.exe
    77228 <- 65176 thisJob=true->true anyJob=true->true C:\Program Files\nodejs\node.exe
  after the job closed, survivors: none
  ```

- **Other packaged tools.** `fsutil reparsepoint query` gives `Reparse Tag Value : 0x8000001b`
  (`IO_REPARSE_TAG_APPEXECLINK`, an app execution alias) for `pwsh.exe`, `python.exe`, `python3.exe`, `winget.exe`,
  `wt.exe` and `bash.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps`. Each starts a packaged app and should escape the
  same way; only pwsh was run (see Not probed). `wsl.exe` on PATH is System32's, which is not an alias; WSL also
  installs one in `%LOCALAPPDATA%\Microsoft\WindowsApps` (tag 0x8000001b, its target under `\WindowsApps\`), which a
  shell check's PATH walk that met it first would treat as packaged.

## 2. Containing

| option | contains | misses or breaks | cost to build and run | how a test proves it |
| --- | --- | --- | --- | --- |
| Drop `BREAKAWAY_OK` (one `createJob`, so a launch, a Check's shell runner and the suite launcher alike) | Git Bash's children, and any tool that asks to break away | packaged apps (question 1). A tool that insists on breakaway gets `ERROR_ACCESS_DENIED` from `CreateProcess`; none was found: npm, git, a Git Bash pipe, Windows PowerShell 5.1's `Start-Process`, `winget`, `wsl` and Claude Code all ran | one flag; nothing at run time | on a Windows runner, `bash.exe -c 'node -e "setTimeout(…)" &'` through `launch` and `runShell` leaves nothing, where today the node survives |
| `SILENT_BREAKAWAY_OK` | nothing | everything after the first process | - | - |
| Nested jobs (adoption): each escapee, once seen, assigned to gg's job, or to a new empty kill-on-close job gg holds, nested in the job it is already in | a packaged pwsh and each process it starts, once seen | a process that starts and loses its parent between two polls; each child of a packaged process escapes again and must be chased; a process gg cannot open | a poll loop (question 3) and one job per packaged escapee | the watcher's test, with a stand-in escapee |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST` | gg's own child, assigned at its creation (in place of the gate) | what the gate already covers, no more: the system creates a packaged process elsewhere, so that escape is unchanged | `CreateProcessW` with `STARTUPINFOEX` through `node:ffi`, with stdio of its own (ADR 0021) | - |
| Point Claude Code at a PowerShell that is not packaged | the whole shell tree, once `BREAKAWAY_OK` is dropped too for Git Bash | a packaged app an agent's command starts itself (`winget`, the `python` alias, a `pwsh` it types) | a shell check; no launch change where an unpackaged PowerShell 7 is first on PATH | the shell check (question 5); a recorded call |

The nested-job row, from the probe: a packaged pwsh already in its package job is refused by gg's job (error 5) and
taken by a new empty one, nested in its package job; real Claude (call 6) left nothing running:

```
ADOPT=1 sh claude-call.sh 6 nobreakaway PowerShell '{"CLAUDE_CODE_USE_POWERSHELL_TOOL":"1",…}'
job flags nobreakaway 0x2000
adopt 92412 into this job failed (5); into a new empty job: ok
adopted 55904 into this job
adopt 66108 into this job failed (5); into a new empty job: ok
adopted 35656 into this job
after the job closed, survivors: 41772 cmd.exe   (a reused pid: its command line no longer matched)
```

**How Claude Code 2.1.330 picks its PowerShell** (read from its binary, `shell_powershell_detect`): `pwsh` on PATH; if
that sits in `…\Microsoft\WindowsApps\`, the alias's target, which it runs directly (`store_alias_on_path`). With no
`pwsh` on PATH: `%ProgramFiles%\PowerShell\7\pwsh.exe`, then the target of the
`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` alias, then `%USERPROFILE%\.dotnet\tools\pwsh.exe`, then System32's
Windows PowerShell 5.1, then `powershell` on PATH. No setting or variable names the path; the only
`CLAUDE_CODE_POWERSHELL*` variable is `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY`. So an unpackaged PowerShell 7
is used whenever PATH reaches its directory before WindowsApps: the 7.7 ZIP build unpacked to
`%ProgramFiles%\PowerShell\7` with that folder on PATH ahead of WindowsApps, or the 7.6 LTS MSI (`winget install --id
Microsoft.PowerShell --source winget --installer-type wix`). 7.7 has no MSI, and winget installs the packaged MSIX by
default from 7.6 (Microsoft's "Install PowerShell on Windows" page). The MSI adds its directory to the system PATH,
which Windows puts ahead of the user's entries, where WindowsApps sits by default; no MSI is installed here, so that
order is documented behaviour, not probed. Call 8 ran the 7.7.0 ZIP build first on PATH. On a machine with only the
Store's, gg cannot steer Claude off it short of changing `LOCALAPPDATA`, which every tool reads.

Under real Claude, with gg's limits unless named:

| call | setup | Claude's shell, by its own report | its command's node | after the job closed |
| --- | --- | --- | --- | --- |
| 1 | default | Store pwsh, `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0…\pwsh.exe` | outside every job | node survives (the trial, reproduced) |
| 2 | WindowsApps dropped from PATH, `LOCALAPPDATA` an empty directory | `System32\WindowsPowerShell\v1.0\powershell.exe` (5.1) | in gg's job | nothing survives |
| 3 | a `pwsh.exe` that is not packaged first on PATH (a copy of System32's `powershell.exe`, as a stand-in) | that `pwsh.exe` | in gg's job | nothing survives |
| 4 | Bash tool (Git Bash) | `C:\Program Files\Git\usr\bin\sh.exe` | outside every job (MSYS breakaway) | `nohup` and node survive |
| 5 | Bash tool, `nobreakaway` | Git Bash | in gg's job | nothing of the call survives |
| 6 | Store pwsh, `nobreakaway`, adoption on | Store pwsh | adopted into a job gg holds, when seen | nothing of the call survives |
| 7 | the PowerShell 7.7.0 ZIP build first on PATH, `nobreakaway`; the unpacked copy had lost `pwsh.dll` | none: the shell exited 154 at once | - | nothing survives; not a containment result |
| 8 | the same, a fresh unpack (Authenticode valid, Microsoft) | `…\gg489-pwsh-portable\pwsh77\pwsh.exe` | in gg's job | nothing survives |

Call 8, the unpackaged PowerShell 7 that decision 2's fix names:

```
PREPEND='…\gg489-pwsh-portable\pwsh77' sh claude-call.sh 8 nobreakaway PowerShell '{"CLAUDE_CODE_USE_POWERSHELL_TOOL":"1",…}'
grep -E "thisJob|survivors" claude-call-8.txt
  66896 <- 29480 thisJob=true anyJob=true …\gg489-pwsh-portable\pwsh77\pwsh.exe
  32716 <- 29480 thisJob=true anyJob=true C:\Windows\System32\cmd.exe
  44332 <- 32716 thisJob=true anyJob=true …\gg489-pwsh-portable\pwsh77\pwsh.exe
  95372 <- 44332 thisJob=true->true anyJob=true->true C:\Program Files\nodejs\node.exe
after the job closed, survivors: none
```

Claude starts its shell through `cmd.exe /d /s /c ""…\chcp.com" 65001 >nul & "<pwsh>" …"` for each command, and also
runs `pwsh -NoProfile -NonInteractive -NoLogo -EncodedCommand …` directly from `claude.exe`; calls 1 and 6 show a
second packaged pwsh whose parent is `claude.exe`.

## 3. Tracking what escapes

| option | sees | privileges | cost | reliability |
| --- | --- | --- | --- | --- |
| Descendant watcher: a Toolhelp snapshot, polled, joined by parent pid where the child started no earlier than its parent (`linkedDescendants`, `lib/containment.ts:89`, over `commandCleanup.linkedPids`; today only on the uncontained path) | every escapee probed: the packaged pwsh's parent is the job's `cmd.exe` or `claude.exe`, each of its children's is pwsh | none | 38 ms a snapshot of 497 processes on a 20-thread machine, 67 ms with every process's creation time and command line; polling took about 11% of one core at POSIX's 250 ms poll gap (`lib/process-tree.ts:11`) and 4% at 1 s, measured with `process.cpuUsage` over 40 and 10 polls of 458 processes | misses a process started and orphaned between two polls, as the POSIX watcher does; the creation-time rule rejects a reused pid only at first sight, so a held handle per seen process keeps its pid from reuse (below) |
| Watcher with adoption (question 2) | as the watcher; adds kill-on-close for what it adopted, so gg's death ends it | none | a job per packaged escapee | the same gap; one seen but neither adopted nor ended is a survivor |
| WMI `Win32_ProcessStartTrace` | every process start, from the kernel | administrator: refused with "Access to a CIM resource was not available to the client." | - | - |
| WMI `__InstanceCreationEvent WITHIN 1` on `Win32_Process` | a start, with pid, parent pid and creation date | none (it saw the marked node) | WMI polls the whole process table at the `WITHIN` interval in its own service | the same gap as the watcher, run by `WmiPrvSE` |
| ETW `Microsoft-Windows-Kernel-Process`, a real-time session | every start, no gap | administrator or Performance Log Users: `logman` gave "Access is denied." | - | - |

```
node q3-snapshot-cost.ts
processes on the machine: 497
snapshot (CreateToolhelp32Snapshot, pid/parent/exe): 38.08 ms each over 50
snapshot + describe every process (creation time, command line): 66.90 ms each over 5

node snapshot-cpu.ts   (the CPU share: process.cpuUsage over the polls' wall time)
processes on the machine: 458
snapshot: 28.57 ms each over 50
poll every 250 ms, 40 polls: cpu 11.2% of one core
poll every 1000 ms, 10 polls: cpu 3.7% of one core
```

GLOSSARY.md's warning that "a Windows parent pid cannot prove a process its child" (`:210`) held in practice: within
one call a dead parent's pid was reused by an unrelated `node.exe` (call 5) and `cmd.exe` (call 6). The creation-time
rule #297 put in `linkedPids` (a child joins only if it started no earlier than the parent it names) rejects such a
pid as a parent, since the reused process started after the child.

That rule decides a link at first sight only. A watcher that keeps a seen process as a seed after its parent exits,
as gg's POSIX `observe` does (`lib/command-cleanup.ts:182-193`) and the job probe did, links whatever later holds the
seed's pid: if the seed exits and an unrelated process takes its pid between two polls, the replacement's children
start after it, pass the rule, and are linked. A copy of `lib/command-cleanup.ts` at 2c01d56 fed two listings (poll 1:
root 100 starts 200; poll 2: 200 is gone, an unrelated process holds pid 200 and starts 300):

```
node reuse-probe.ts
after poll 2, seen: [ 200, 300 ] row 300: [300,200,"2026-11-22 10:00:21",999,"UNRELATED child",21]
linkedPids seeded at the reused pid 200: [ 300 ]
leftover plan kills: {"kill":[300],...}
```

Windows keeps a process's pid from reuse while any handle to it is open (Raymond Chen, "When does a process ID become
available for reuse?", The Old New Thing, 2011-01-07). A probe kept the handles of 30 exited processes, released 30
others, then started 600 short processes of its own:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File pin-probe.ps1
pinned (handle kept, exited): 30; their pids reused by the 600: 0
control (handle released, exited): 30; their pids reused by the 600: 7
distinct pids among the 600: 570
```

So the watcher holds a handle to each process it links (the creation-time rule still decides the link at first
sight), seeds only from processes whose handle has not signalled, and adopts or ends each through its handle, so
nothing acts on a stale pid; a process gg cannot open is a survivor. Comparing a retained pid's creation time each poll
is the fallback for such a process, not the rule: alone it races, since the pid can be reused between the check and
`AssignProcessToJobObject`. On Linux a pidfd is the same idea (`pidfd_open`, question 4).

## 4. Linux parity

In WSL, a Node 26.13.0 tarball ran gg's own `exec.runShell` and `exec.launch` (process group and the `ps` watcher):

| command | gg's cleanup | after gg answered |
| --- | --- | --- |
| `sh -c 'sleep 20; true' <marker> &` | `confirmed: true` | nothing left |
| `setsid sh -c … & sleep 1` (its own session, its parent alive) | `confirmed: true`: the watcher saw it and killed it | nothing left |
| `setsid -f sh -c …` (a double fork that exits at once, stdio inherited) | `confirmed: false`, "its output pipes stayed open … held by a process gg cannot find" | it runs on, outside gg |
| `setsid -f sh -c … </dev/null >/dev/null 2>&1` (a double fork, stdio closed) | **`confirmed: true`**, for `runShell` and `launch` alike | **it runs on**: the same false confirmation as Windows |

```
own session by double fork, its stdio closed via launch: setsid -f sh -c 'sleep 20; true' GG489LDmws6twos </dev/null >/dev/null 2>&1
  gg's cleanup: {"confirmed":true,"survivors":0,"reason":null,"containment":{"kind":"group","pgid":639}}
  still running with the marker (pid ppid pgid sid args):
        642     624     642     642 sh -c sleep 20; true GG489LDmws6twos
```

| option | contains or tracks | misses | cost | how a test proves it |
| --- | --- | --- | --- | --- |
| Process group and watcher (today) | the group, and what the watcher saw | a double fork that closes its stdio | none new | the stdio-closed double fork above, through `runShell` and `launch` |
| Subreaper (`PR_SET_CHILD_SUBREAPER` through `node:ffi` `prctl`, which returned 0) | finds an orphan, reparented to gg's node (ppid 550, 645), as "a child of gg that gg did not start" | which call it came from, when calls run concurrently; gg did not see it (`confirmed: true` with the subreaper set too) | gg must reap what it adopts: node does not, and a killed orphan stayed a zombie, which turned a same-group case to `confirmed: false` ("process group … still has members after SIGKILL", inferred cause). Reaping by `waitpid` through `node:ffi` beside libuv's own is a risk not probed | - |
| cgroup, `systemd-run --user --scope` | everything: a process cannot leave a cgroup by `setsid` or a double fork | a machine without a systemd user manager or delegation | a `systemd-run` per call (cost not measured); the shared mechanism #128 and #289 describe | the stdio-closed double fork is in the scope's `cgroup.procs`, and stopping the scope ends it |
| pidfd (`pidfd_open`, `pidfd_send_signal`) | pid reuse, for a process gg already knows | finds nothing new | a syscall through `node:ffi`; node has no pidfd API | - |

```
sh q4-cgroup.sh   (in WSL: systemd-run --user --scope --quiet --unit "gg489-$run" sh -c "setsid -f sh -c 'sleep 30; true' $marker </dev/null >/dev/null 2>&1", then reads the scope's cgroup.procs and stops it)
its cgroup: /user.slice/user-1000.slice/user@1000.service/app.slice/gg489-1795373172.scope
processes in it (cgroup.procs):
  675 sh -c sleep 30; true GG489CG1795373172
  676 sleep 30
the marked process:     675     665     675     675 sh -c sleep 30; true GG489CG1795373172
after stopping the scope, still running with the marker: none
--- unprivileged cgroup without systemd: may this user create a child of its own cgroup?
mkdir: Permission denied
--- pidfd
pidfd_open and pidfd_send_signal: killed 695 exit -9
```

## 5. Detection

A probe used gg's own `startArgv` (the gate, gg's limits), with no model call and no administrator, to start each shell
on `node -e "console.log(process.pid); setTimeout(() => {}, 1500)"` and ask whether that pid is a member of gg's job:

```
node q5-doctor-check.ts
pwsh on PATH (the Store alias): spawn ok; its command's node pid 101456 in gg's job: false (2018 ms)
Windows PowerShell 5.1: spawn ok; its command's node pid 88720 in gg's job: true (2110 ms)
Git Bash: spawn ok; its command's node pid 50688 in gg's job: false (2360 ms)
first pwsh on PATH: C:\Users\James\AppData\Local\Microsoft\WindowsApps\pwsh.exe; alias target:
  C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe; packaged: true
```

So two checks are possible:

| check | what it finds | cost | how a test proves it |
| --- | --- | --- | --- |
| Static: the shell the Harness would start, with an app execution alias followed (`fs.readlinkSync` reads its target), lies under `\WindowsApps\` | a packaged shell | a PATH walk and a `readlink`; cheap enough for every `gg doctor` and preflight (ADR 0028) | a PATH whose first `pwsh.exe` is an alias to a target under `\WindowsApps\` fails the check; `claude-doctor.ts`'s `shellCheck` passes it today ("PowerShell is on PATH") |
| Live: a command run under that shell, started as gg starts a launch, leaves a child that is a member of gg's job | any escape, packaged or breakaway; it also fails Git Bash while `BREAKAWAY_OK` stays, and passes it once dropped | about 2 s, no model call; under `gg doctor --probe` | a shell whose command's child is not in gg's job fails the probe |

The issue asks for one packaged-shell check for both Harnesses (epic #506's order, and #484's amended decision 1), so
both rows are written once and each Harness's `doctor` names the shell it would start.

## Codex's sandbox helper (MXC): #483 decision 1

#479's recording (draft PR #505, `docs/research/codex-cli.md`, "Job containment (F7)") ran Codex 0.171.0 under MXC
inside a job started as gg starts a launch, with gg's current limits, on this machine, whose first `pwsh` on PATH is the
Store's: while a command ran, the job held the MXC helper (`codex.exe --__codex-windows-mxc`), System32's
`powershell.exe`, the command's `node`, `codex-code-mode-host.exe` and a `node` MCP host; every process naming the
marker was in the job, and nothing was left after exit or after a tree kill. So MXC does not escape gg's job, and since
none of its processes left a job that allowed breakaway, none asks for it: dropping `BREAKAWAY_OK` changes nothing for
it (inferred, not re-probed). Codex's shell is still covered by the shared shell check, and its launches by the same
watcher, since `exec.launch` is shared. No MXC-specific containment is needed.

## Recommended design

ADR 0030 decides it (accepted 2026-11-22); this is its outline.

1. **gg's job allows no breakaway.** `createJob` sets `KILL_ON_JOB_CLOSE` alone, for a launch, a Check's shell runner
   and the suite launcher. Git Bash's children stay in; no tool probed failed.
2. **On Windows an Agent's shell is a PowerShell that is not packaged.** PowerShell stays the default (ADR 0025, G5 C;
   #420 adds Bash as a choice). Where an unpackaged PowerShell 7 is first on PATH, Claude already takes it (call 8).
   Where Claude would resolve a packaged one, preflight fails, naming the fix, since gg cannot steer Claude off it: an
   unpackaged PowerShell 7, the 7.7 ZIP build unpacked to `%ProgramFiles%\PowerShell\7` with that folder on PATH ahead
   of WindowsApps, or the 7.6 LTS MSI (`winget install --id Microsoft.PowerShell --source winget --installer-type
   wix`).
3. **A Windows launch and a Check's shell runner watch their descendants, as POSIX's do,** linked by parent pid and
   creation time to the job's members and the descendants already seen, each held by an open handle so its pid cannot
   be reused while gg seeds from it (question 3). A linked process outside gg's job is adopted when seen, through its
   handle: into gg's job, else into a new kill-on-close job gg holds, else terminated. At cleanup gg ends its job and
   each adopted job, closes its handles, and confirms each linked process gone; one it cannot, or cannot open, is a
   survivor, with `confirmed: false`.
4. **A call's recorded containment stays `job` only while nothing it started has left gg's job.** The first linked
   process the watcher sees outside gg's job makes gg save the call's containment as `none` before it adopts or ends
   that process, and it stays `none`. Once that save commits, a crash leaves a call a resume rescues and holds rather
   than reset in place; a crash before it commits leaves the call `job` with the escapee neither adopted nor ended, the
   residual risk below. A failed save (fatal) makes gg end the escapee, then stop; one it cannot end is that residual
   risk too. The rules of record.md and harness.md this changes raise `RECORD_SCHEMA_VERSION` (3 to 4) and `FAKE_HARNESS_VERSION` (5 to 6), with no rule for a `job` saved before the bump, since gg has none in use.
5. **One shell check for both Harnesses:** the static check on every `gg doctor` and preflight, the live one under
   `gg doctor --probe`.
6. **Linux** takes cgroups through #128 and #289, one mechanism; until then the stdio-closed double fork is the named
   residual risk there.

What stays unseen, the residual risk this replaces the breakaway text with: on Windows, a process outside gg's job that
no poll saw before its parent ended or gg died, or one a poll saw whose call's `none` save had not committed when gg
died, or that gg failed to end after the save failed (its call stays `job`), and a process a service, WMI or the task scheduler starts on a
command's behalf, which no parent link ties to the command (`docs/testing.md:240` names the second already); on Linux without a cgroup, a
process that leaves the group and closes its stdio.

## What a confirmed cleanup means for #68 and #69

**Today.** A launch's or a Check's cleanup is decided from gg's job alone: `cleanupReport` (`lib/command-cleanup.ts:70`)
confirms when the containment is not `none` and the job's leftovers are empty, and on win32 no watcher runs
(`lib/exec.ts:193` for `launch`, `:363` for `runShell`). An escapee is neither a job member nor holding a pipe gg reads
(Claude's shell children hold Claude's pipes, which Claude closes), so the Action Event says
`cleanup: { confirmed: true, survivors: [], containment: { kind: "job" } }`, as the trial found. Linux gives the
same for a stdio-closed double fork.

- **#68's in-place reset.** `lib/rescue.ts:216` resets an Interrupted Attempt in place when its call payload's
  containment is `job` ("Only a job's kill-on-close proves the call's processes gone"), and `confirmedUnder`
  (`lib/command-cleanup.ts:80`) returns true for `job` without looking, which a Pending cleanup hold's resume (L14)
  takes as proof too. With an escapee that premise is false: gg dies, its job closes, the escapee runs on, and the
  resumed Run resets the worktree while the escapee may still write, which N1 and L6 forbid (`lib/rescue.ts:144`: "a
  surviving writer could write after the ref's verification"). On a machine whose Claude Code shell is the Store's
  PowerShell this holds for every agent call that left a command running.
- **#69's trigger** ("a tool that broke away from the job object") is not rare: every Claude PowerShell command on a
  machine with the Store's pwsh, and every non-MSYS child of Git Bash under gg's current limits.

**Under the recommended design.** `job` means again what N1 needs: no process the call started ever left gg's job, so
kill-on-close on a handle only gg holds ends them all at gg's death. A call whose watcher saw an escapee saves `none`
before gg adopts or ends it, write-ahead (ADR 0005), and keeps it, which `lib/rescue.ts:216` already rescues and holds.
gg adopts or ends the escapee only once that save commits, so a crash while it does cannot leave a `job` over it;
until `savedContainment`'s save returns (`lib/agent-call.ts:137-142`) the payload says `job`, and a crash then leaves
`job` over an escapee gg never adopted. A failed save (fatal: `lib/effect-errors.ts:19`) makes gg end the escapee,
then stop, so the saved `job` again describes what runs, unless gg cannot end it. Neither `lib/rescue.ts` nor
`confirmedUnder` changes; their premise becomes true but for the residual gap above. A Pending cleanup hold's `closeJob` must close the adopted jobs too. The rule a saved `job` follows changes in record.md (:846-856) and harness.md (:163-166), with no shape change, so
the implementing ticket raises `RECORD_SCHEMA_VERSION` and `FAKE_HARNESS_VERSION` (owner, 2026-11-22); no record of
the previous version is in use, so none gets a rule of its own. The residual gap above stays: an escapee unseen at
gg's death, seen before its call's `none` save committed, or that gg failed to end after the save failed, is not ended, its call stays `job`, and a reset can run
under it. #69 stays an alternative for file locks and rescued human edits; this design does not need it.

## Not probed, and why

- **The PowerShell 7.6 LTS MSI.** Not installed here; its PATH order is documented behaviour. The 7.7.0 ZIP build,
  the other fix decision 2 names, was run under real Claude (call 8, after the owner approved it): it stays in the job.
- **`PROC_THREAD_ATTRIBUTE_JOB_LIST`.** Argued, not tested: the escapee is never created in any job of the caller's,
  so assigning gg's own child at creation cannot reach it.
- **The `python` and `wt` aliases.** Identified by their reparse tag only. Here `python` resolves first to a
  `C:\Python314` install and the alias is the App Installer stub; `wt` opens a window.
- **`winget`.** `winget --version` exited before a 300 ms poll could see it, so its job membership was not observed;
  it ran without failing under `nobreakaway`.
- **CI's `ubuntu-24.04` runner.** Whether it has a systemd user manager for `systemd-run --user` was not probed; #289
  lists it as a precondition.
- **WSL processes started by `wsl.exe`.** They run in the WSL VM, not as Windows processes; what ending `wsl.exe` does
  to them was not probed.
- **Codex's MXC**, re-probed: not, by the launch notes; #479's finding stands above.

## Follow-up tickets

Filed on 2026-11-22, once the owner accepted ADR 0030, as sub-issues of epic #506: 1 is #530, 2 is #531 (blocked by
#530), 3 is #532 (blocked by #531) and 4 is #533 (blocked by #480). Each test fails today.

1. **gg's job lets no process break away.**
   - Scope: `lib/containment.ts`'s `createJob` limits and the comment at `:39`; the texts ADR 0030's Supersedes assigns
     to this ticket (ADR 0016's and ADR 0021's breakaway lines, `docs/testing.md:239` and GLOSSARY.md's "or breaks away
     from the job"); the suite launcher shares the limits (`scripts/run-suite.ts:191`).
   - Test that fails today (`test/contract/exec/`, on `windows-2025`, the real job): `a Git Bash command's background
     node ends with its launch` and `… with runShell`:
     `bash.exe -c 'node -e "setTimeout(() => {}, 60000)" <marker> &'` leaves no marked process once the result is in.
     Today the node runs on, under `confirmed: true`. The contract test `test/contract/exec/exec.job.test.ts:150-182`,
     "a child that asks to break away from the job still starts", asserts the breakaway this removes: it becomes `a
     child that asks to break away fails to start`, over the same `test/support/child-scripts/breakaway-child.ts`, and
     `scripts/run-suite.ts:184`'s comment changes with it.
2. **A Windows launch and a Check watch their descendants, and adopt or end each one outside gg's job.**
   - Scope: the watcher on win32 (`lib/exec.ts:193`, `:363`, `lib/process-tree.ts`), adoption into gg's job or a new
     nested kill-on-close job (`lib/containment.ts`), the kill plan and report (`lib/command-cleanup.ts`), and
     `closeJob` closing the adopted jobs, with a handle held per linked process (question 3); the POSIX `observe`
     (`lib/command-cleanup.ts:182-193`), which links an unrelated child through a seed whose pid was reused; and the
     comments ADR 0030's Supersedes assigns to this ticket. The poll gap and a snapshot shared by concurrent watchers
     are this ticket's choices, at the costs above.
   - Tests that fail today: small, in `test/unit/command-cleanup.test.ts`, `a linked process outside the job's members
     is ended and its cleanup is confirmed only once it is gone`, and `a seen descendant's pid reused between two polls
     by an unrelated process is not linked, adopted or ended`, for the Windows watcher and the POSIX `observe` (today
     `observe` links pid 300 and the leftover plan kills it, question 3); medium, in `test/contract/exec/` on
     `windows-2025`, with a kernel32 copy whose `SetInformationJobObject` adds `BREAKAWAY_OK` back (ADR 0021's
     replaced-function seam) so Git Bash's node leaves the job as a packaged app's child does: `a launch's escapee is
     ended` and `a runShell escapee is ended`, and, with that copy's kill of the escapee failing, `an escapee gg cannot
     end is a survivor with confirmed false`, for each. Today the node runs on and cleanup says `confirmed: true`.
3. **A call whose watcher sees an escapee saves its containment as `none` before gg adopts or ends it.**
   - Scope: the call intent's second write (`lib/agent-call.ts`, `lib/attempt.ts`), from the watcher's first sight of
     an escapee, after ticket 2; `RECORD_SCHEMA_VERSION` 3 to 4 and `FAKE_HARNESS_VERSION` 5 to 6, with record.md's
     containment paragraph and harness.md's `started` rule restated (ADR 0030 decision 4), and the other texts ADR
     0030's Supersedes assigns to this ticket. No rule for a `job` saved before the bump, and no test of one.
   - Tests that fail today (small, beside `test/unit/interpreter.retry.test.ts`): `a crash after the none save commits
     holds the Interrupted Attempt`, the crash point between the committed `none` save and the adoption; `a none save
     that is interrupted stops the Run before the escapee is adopted or ended`, which pins the order (the call stays
     `job`, ADR 0030 decision 8's residual risk); `a none save that fails ends the escapee, then stops the Run` (ADR
     0030 decision 4); and `an Interrupted Attempt whose call had an escapee gg adopted
     is rescued and held, not reset`. Today its payload says `job` and it is reset.
4. **One shell check for both Harnesses: a packaged shell fails preflight, and `--probe` checks a command stays in
   gg's job.**
   - Scope: one check both Harnesses' `doctor` call, replacing `shellCheck` (`lib/harnesses/claude-doctor.ts:199`) and
     serving #484's `pwsh` check: whichever of this ticket and #484 lands first builds it, and the other calls it; with
     #480's shared doctor helpers and #494's passed-check line.
   - Tests that fail today (small, `test/unit/doctor.cli-checks.test.ts`): `a first pwsh on PATH that is an alias to an
     app under WindowsApps fails the shell check` (today it passes, "PowerShell is on PATH"), and `under --probe, a
     shell whose command's child is outside gg's job fails the containment probe` (no such probe today).

Linux needs no new ticket: #289's Definition of done already asks for a command "that called `setsid` and one whose
parent exited", and #128 shares its mechanism; the stdio-closed double fork above is the case both should name.
