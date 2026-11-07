---
status: accepted
date: 2026-11-02
---

# Windows commands run in a job object gg holds through node:ffi

Supersedes ADR 0017.

On Windows, `exec.runShell` puts a command and everything it starts in a job object, so a timeout kills orphans too
and the job's member list proves the tree is gone. Until now a PowerShell helper, `lib/winjob.ps1`, compiled C# that
created the job, and wrote its answers as `\x01GGJOB` notes into the command's own stdout and stderr (grey-goo-ri issue
#245). That vehicle had four faults:

- It added 0.5 to 0.7 s to every call once its assembly was cached (ADR 0017), and seconds when it was not.
- The command could forge the notes: a printed `fail` note turned an exit 0 into 127, and an empty `survivors` note
  with `done` markers read as a clean cleanup while the processes ran on.
- Under AppLocker or WDAC, PowerShell's Constrained Language Mode blocks `Add-Type`, and a Group Policy execution
  policy overrides `-ExecutionPolicy Bypass`. The helper then never started, and the command ran uncontained without a
  word unless it timed out.
- It used its own stdin as the control channel, so the command could never be given stdin.

`lib/containment.ts` now calls kernel32 through `node:ffi`, in gg's own process:

- `cmd.exe` starts as `cmd.exe /d /s /c "set /p GG_GATE= & set "GG_GATE=" & <command>"`, waiting on one line of
  stdin. gg creates a job with kill-on-close and breakaway-OK, assigns `cmd.exe` to it, then writes the gate line `go`
  and ends stdin. Nothing the command starts is outside the job, and the command reads EOF, as it read NUL before.
  The gate line is not empty, since `set /p` given an empty line leaves the error level at 1, which a bare `exit /b`
  or `if errorlevel` in the command would read; the variable is then cleared. The gate also swallows any stdin
  written with the gate line, so this start is only for commands given no stdin.
- On timeout gg terminates the job and lists its members until it is empty. A job it cannot read or terminate is
  reported, its processes named as survivors, and its handle kept, so kill-on-close takes them when gg exits.
- gg holds the job's only handle, so the job's processes also die when gg does. The result names its containment,
  `job` or `none`, which is what a call intent records (ADR 0011, decisions N1 and L14).
- A command that finishes has its background processes ended and named as leftovers: gg keeps kill-on-close and
  terminates the job, and the job's member list confirms it (amended 2026-11-06 for grey-goo-ri issue #118, decision L6;
  until then gg dropped kill-on-close and let them run on, which left a writer free to write after a rescue's
  verification or into the next Vertex's worktree). A job it cannot terminate or read keeps its handle, names what is
  left as survivors, and the Ticket holds (decision L11). libuv starts `cmd.exe`
  with CREATE_NO_WINDOW under `windowsHide`, which gives it a `conhost.exe` of its own in the job. That console host
  is excluded by name and parent rather than by spawning without `windowsHide`, which would open a console window
  whenever gg has none. A member listed in the job but no longer in a process snapshot is still exiting and is not a
  leftover either.
- `cmd.exe` and `taskkill.exe` run from `%SystemRoot%\System32`. libuv looks a bare name up in the child's working
  directory before `PATH`, unless `NoDefaultCurrentDirectoryInExePath` is set, and an agent can write there; this was
  checked on Node 26.13 with a planted `taskkill.exe`.
- `bin/gg.ts` opens the kernel32 functions once and passes them down through `exec.createExec` (ADR 0019). A test
  passes `null` or a copy with some functions replaced.

## node:ffi is experimental

`node:ffi` is Stability 1 and on by default since Node 26.9, below the 26.13 floor (ADR 0020). It is missing from a
Node built without FFI support or run with `--no-experimental-ffi`, and it needs `--allow-ffi` under the Permission
Model. Experimental features are not covered by semantic versioning.

- When `node:ffi` is missing, or the job cannot be created or assigned, the command runs uncontained: a timeout runs
  `taskkill /T` on the shell, and every result, timed out or not, carries `containment: 'none'` and a
  `containmentError` saying orphaned descendants are not contained.
- gg prints no ExperimentalWarning: `openKernel32` drops the warnings emitted while it loads `node:ffi`.
- The struct offsets are 64-bit Windows'. Node 26 ships Windows builds only for x64 and arm64.
- The official 26.13.0 `win-arm64` build includes `node:ffi`: its `node.exe`, from the zip whose SHA-256 matches the
  release's `SHASUMS256.txt`, was configured with `"node_use_ffi": true`, as the x64 build was. It was not run, since
  no arm64 machine was at hand.

Each pull request that bumps the Node version checks:

- the release notes and `doc/api/ffi.md` for changes to `dlopen`, the `pointer`, `buffer`, `int32` and `uint32` types,
  or the default-on status;
- that the `test/contract/exec/` suite passes on `windows-2025`, whose cases run the real job;
- that `node -p "process.config.variables.node_use_ffi"` prints `true` for the official x64 build, and the `node.exe`
  of the official `win-arm64` zip contains `"node_use_ffi": true`.

## Considered options

- Keeping the PowerShell helper and moving its notes out of band. Rejected: it fixes the forgery but keeps the cost,
  the PowerShell policy failure and the stdin limit.
- A shipped helper executable. Rejected: a binary per architecture, a toolchain in CI and a binary a reviewer cannot
  read, for what `node:ffi` does in-process.
- `taskkill /T` only. Rejected: it cannot find orphans, which is the reason for the job.
- `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, which starts the process inside the job. Deferred to the
  agent calls that need stdin: it needs named-pipe stdio of its own, where the gate reuses Node's `spawn`.

## Consequences

- A warm `runShell` of `exit /b 0` on `windows-2025` takes a median of 21 ms, against 317 ms through the helper and 17
  ms for a plain spawn of `cmd.exe` (20 runs each, workflow run 41540768520). The timeout counts from the call again:
  there is no helper start-up to exclude.
- `lib/winjob.ps1`, `lib/winjob-cache/` and the helper's test seams are gone, and with them ADR 0017's cache and its
  threat model. A checkout that ran the suite before may still hold an untracked `lib/winjob-cache/`, which can be
  deleted.
- A wrong FFI signature crashes gg rather than raising an error. The signatures are fixed in `lib/containment.ts`;
  no agent input reaches them.
- Agent calls given stdin still need the JOB_LIST start above.
