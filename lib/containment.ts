// A Windows command held in a job object gg creates through node:ffi (ADR 0021): started inside it, listed, named,
// terminated and confirmed empty. A process the command starts outside the job, as Windows starts a packaged app's, is
// held open once the watcher links it, and adopted or ended (ADR 0030 decision 3). A Linux cgroup backend (#128)
// belongs here.
import { spawn, type ChildProcess } from 'node:child_process';
import type * as ffi from 'node:ffi';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as commandCleanup from './command-cleanup.ts';

// The struct offsets below are 64-bit Windows', the only Windows Node 26 is built for (x64 and arm64).
const SIGNATURES = {
  CreateJobObjectW: { arguments: ['pointer', 'pointer'], return: 'pointer' },
  SetInformationJobObject: { arguments: ['pointer', 'int32', 'buffer', 'uint32'], return: 'int32' },
  QueryInformationJobObject: { arguments: ['pointer', 'int32', 'buffer', 'uint32', 'pointer'], return: 'int32' },
  AssignProcessToJobObject: { arguments: ['pointer', 'pointer'], return: 'int32' },
  TerminateJobObject: { arguments: ['pointer', 'uint32'], return: 'int32' },
  TerminateProcess: { arguments: ['pointer', 'uint32'], return: 'int32' },
  IsProcessInJob: { arguments: ['pointer', 'pointer', 'buffer'], return: 'int32' },
  WaitForSingleObject: { arguments: ['pointer', 'uint32'], return: 'uint32' },
  GetExitCodeProcess: { arguments: ['pointer', 'buffer'], return: 'int32' },
  OpenProcess: { arguments: ['uint32', 'int32', 'uint32'], return: 'pointer' },
  CloseHandle: { arguments: ['pointer'], return: 'int32' },
  GetLastError: { arguments: [], return: 'uint32' },
  CreateToolhelp32Snapshot: { arguments: ['uint32', 'uint32'], return: 'pointer' },
  Process32FirstW: { arguments: ['pointer', 'buffer'], return: 'int32' },
  Process32NextW: { arguments: ['pointer', 'buffer'], return: 'int32' },
  GetProcessTimes: { arguments: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer'], return: 'int32' },
} as const;
// kernel32 gives no other process's command line.
const NTDLL = {
  NtQueryInformationProcess: { arguments: ['pointer', 'int32', 'buffer', 'uint32', 'pointer'], return: 'int32' },
} as const;

// The kernel32 functions gg calls. bin/gg.ts opens them once and passes them down; a test passes null or a copy with
// some replaced.
export type Kernel32 = ffi.DynamicLibraryResult<typeof SIGNATURES & typeof NTDLL>['functions'];

// A bare cmd.exe or taskkill.exe is looked up in the child's working directory before PATH (libuv's search_path), and
// an agent can write there.
export const SYSTEM32 = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32`;

// Alone, with no breakaway limit: a child that asks to break away fails to start, so Git Bash's children stay in the
// job (ADR 0030).
const KILL_ON_JOB_CLOSE = 0x2000;
const EXTENDED_LIMIT_INFORMATION = 9; // 144 bytes, LimitFlags at byte 16
const BASIC_PROCESS_ID_LIST = 3; // two counts, then one 8-byte pid per process
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001; // what AssignProcessToJobObject needs
const PROCESS_QUERY_LIMITED = 0x1000; // what GetProcessTimes, IsProcessInJob and the command line query need
const SYNCHRONIZE = 0x10_0000; // what WaitForSingleObject needs
const PROCESS_HELD = PROCESS_SET_QUOTA_AND_TERMINATE | PROCESS_QUERY_LIMITED | SYNCHRONIZE;
const WAIT_OBJECT_0 = 0;
const STILL_ACTIVE = 259; // the exit code of a process not yet ending
const COMMAND_LINE_INFORMATION = 60; // a UNICODE_STRING of 16 bytes, its characters following it
const COMMAND_LINE_ROOM = 16 + 65_536;
const FILETIME_TO_UNIX_MS = 11_644_473_600_000n; // a FILETIME counts 100 ns from 1601
const ERROR_MORE_DATA = 234;
const SNAPSHOT_PROCESSES = 0x2;
const PROCESS_ENTRY_SIZE = 568; // PROCESSENTRY32W: pid at byte 8, parent pid at 32, exe name (260 UTF-16 units) at 44
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;

const failure = (kernel32: Kernel32, call: string) => new Error(`${call}: win32 error ${kernel32.GetLastError()}`);

// The kernel32 functions, or null off Windows and where node:ffi is missing: a Node built without it, or run with
// --no-experimental-ffi.
export function openKernel32(): Kernel32 | null {
  if (process.platform !== 'win32') return null;
  // node:ffi is experimental and warns on first use, a line gg would print on every Run
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const opened = process.getBuiltinModule('node:ffi');
    if (!opened) return null;
    return { ...opened.dlopen('kernel32.dll', SIGNATURES).functions, ...opened.dlopen('ntdll.dll', NTDLL).functions };
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function processes(kernel32: Kernel32): commandCleanup.ProcessEntry[] {
  const snapshot = kernel32.CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0);
  if (BigInt.asUintN(64, snapshot) === INVALID_HANDLE) throw failure(kernel32, 'CreateToolhelp32Snapshot');
  const entry = Buffer.alloc(PROCESS_ENTRY_SIZE);
  entry.writeUInt32LE(PROCESS_ENTRY_SIZE, 0);
  const found: commandCleanup.ProcessEntry[] = [];
  for (let more = kernel32.Process32FirstW(snapshot, entry); more; more = kernel32.Process32NextW(snapshot, entry)) {
    const exe = entry.toString('utf16le', 44, 44 + 520);
    found.push({ pid: entry.readUInt32LE(8), parentPid: entry.readUInt32LE(32), exe: exe.slice(0, exe.indexOf('\0')) });
  }
  kernel32.CloseHandle(snapshot);
  return found;
}

// The pids still linked to rootPid through parent pids, each started no earlier than its parent, for the fallback that
// has no job to list. Throws when the command's own start cannot be read, since no link to it can then be checked.
export function linkedDescendants(kernel32: Kernel32, rootPid: number): number[] {
  if (startOf(kernel32, rootPid) === null) throw failure(kernel32, `the start of command pid ${rootPid}`);
  return commandCleanup.linkedPids(rootPid, processes(kernel32), process.pid, (pid) => startOf(kernel32, pid));
}

// A process's start as a FILETIME, or null for one gone or closed to gg.
export function startOf(kernel32: Kernel32, pid: number): bigint | null {
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED, 0, pid);
  if (!handle) return null;
  try {
    return creationTime(kernel32, handle);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

// A process's start as a FILETIME.
function creationTime(kernel32: Kernel32, handle: bigint): bigint | null {
  const [creation, exit, inKernel, inUser] = [0, 1, 2, 3].map(() => Buffer.alloc(8)) as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  if (!kernel32.GetProcessTimes(handle, creation, exit, inKernel, inUser)) return null;
  return creation.readBigUInt64LE();
}

function createdAt(kernel32: Kernel32, handle: bigint): string | null {
  const created = creationTime(kernel32, handle);
  return created === null ? null : new Date(Number(created / 10_000n - FILETIME_TO_UNIX_MS)).toISOString();
}

function commandLineOf(kernel32: Kernel32, handle: bigint): string | null {
  const info = Buffer.alloc(COMMAND_LINE_ROOM);
  if (kernel32.NtQueryInformationProcess(handle, COMMAND_LINE_INFORMATION, info, info.length, 0n) !== 0) return null;
  return info.toString('utf16le', 16, 16 + info.readUInt16LE(0)) || null;
}

// A process as a human can recognise it; what the system will not say is null, with no kernel32 or for a pid gone.
export function describe(kernel32: Kernel32 | null, pid: number): commandCleanup.NamedProcess {
  const handle = kernel32?.OpenProcess(PROCESS_QUERY_LIMITED, 0, pid);
  if (!kernel32 || !handle) return { pid, created: null, commandLine: null };
  try {
    return { pid, created: createdAt(kernel32, handle), commandLine: commandLineOf(kernel32, handle) };
  } finally {
    kernel32.CloseHandle(handle);
  }
}

export type Job = {
  // the pids in the job; throws when the job cannot be read, which must never pass for an empty job
  members(): number[];
  // the members once the command has exited, less the console host its spawn gave it
  leftovers(commandPid: number): number[];
  terminate(): void;
  // resolves once a terminated job is empty, however long a loaded machine takes to finish the exits
  emptied(): Promise<void>;
  // A process the watcher linked outside the job's members, held by a handle gg keeps open, so its pid names no other
  // process while it is, and adopted through it: into this job, else a new kill-on-close job, else ended (ADR 0030
  // decision 3). One gg cannot open is not held, and named as far as the system will say.
  hold(entry: commandCleanup.ProcessEntry): commandCleanup.LinkedProcess;
  // whether a held process's handle has signalled; never for one gg does not hold, which it cannot see end
  exited(pid: number): boolean;
  // ends each held pid through its adopted job and its handle, and resolves once each whose end was accepted has exited
  endHeld(pids: number[]): Promise<void>;
  // closes the job, each job it adopted a process into, whose kill-on-close then fires, and each held handle
  close(): void;
};

function setLimits(kernel32: Kernel32, handle: bigint, flags: number) {
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(flags, 16);
  return kernel32.SetInformationJobObject(handle, EXTENDED_LIMIT_INFORMATION, limits, limits.length);
}

// A new job with kill-on-close: gg holds its only handle, so the job's processes die with gg too.
function killOnCloseJob(kernel32: Kernel32): bigint {
  const handle = kernel32.CreateJobObjectW(0n, 0n);
  if (!handle) throw failure(kernel32, 'CreateJobObjectW');
  if (setLimits(kernel32, handle, KILL_ON_JOB_CLOSE)) return handle;
  const error = failure(kernel32, 'SetInformationJobObject');
  kernel32.CloseHandle(handle);
  throw error;
}

// The processes a watcher linked outside gg's job, each held by its handle, and the jobs gg adopted them into.
function linkedHoldings(kernel32: Kernel32, ggJob: bigint) {
  const held = new Map<number, { handle: bigint; job: bigint | null }>();
  const exited = (pid: number) => {
    const holding = held.get(pid);
    return holding !== undefined && kernel32.WaitForSingleObject(holding.handle, 0) === WAIT_OBJECT_0;
  };
  // Windows nests a new job in any job the process is already in, so that job's limits still hold. Gives the new job.
  const adopt = (handle: bigint): bigint | null => {
    const inJob = Buffer.alloc(4);
    if (kernel32.IsProcessInJob(handle, ggJob, inJob) && inJob.readInt32LE()) return null;
    if (kernel32.AssignProcessToJobObject(ggJob, handle)) return null;
    let job: bigint | null = null;
    try {
      job = killOnCloseJob(kernel32);
      if (kernel32.AssignProcessToJobObject(job, handle)) return job;
    } catch {} // no new job: it is ended below
    if (job) kernel32.CloseHandle(job);
    kernel32.TerminateProcess(handle, 1); // refused, it stays held, and its cleanup names it
    return null;
  };
  const hold = ({ pid, parentPid }: commandCleanup.ProcessEntry): commandCleanup.LinkedProcess => {
    const handle = kernel32.OpenProcess(PROCESS_HELD, 0, pid);
    if (!handle) return { ...describe(kernel32, pid), parentPid, started: null, held: false };
    const named = { pid, created: createdAt(kernel32, handle), commandLine: commandLineOf(kernel32, handle) };
    const started = creationTime(kernel32, handle);
    held.set(pid, { handle, job: adopt(handle) });
    return { ...named, parentPid, started, held: true };
  };
  // A process already ending, as a terminated job's are, refuses TerminateProcess, but its handle signals soon after.
  const endingAlready = (handle: bigint) => {
    const code = Buffer.alloc(4);
    return kernel32.GetExitCodeProcess(handle, code) !== 0 && code.readUInt32LE() !== STILL_ACTIVE;
  };
  const endHeld = async (pids: number[]) => {
    const ending = pids.filter((pid) => {
      const holding = held.get(pid);
      if (!holding) return false;
      const jobEnded = holding.job !== null && kernel32.TerminateJobObject(holding.job, 1) !== 0;
      return kernel32.TerminateProcess(holding.handle, 1) !== 0 || jobEnded || endingAlready(holding.handle);
    });
    while (ending.some((pid) => !exited(pid))) await sleep(20);
  };
  const close = () => {
    for (const { job } of held.values()) if (job) kernel32.CloseHandle(job);
    for (const { handle } of held.values()) kernel32.CloseHandle(handle);
    held.clear();
  };
  return { hold, exited, endHeld, close };
}

// A job holding pid, with kill-on-close. The suite launcher holds one around itself (scripts/run-suite.ts).
export function createJob(kernel32: Kernel32, pid: number): Job {
  const handle = killOnCloseJob(kernel32);
  try {
    const processHandle = kernel32.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid);
    if (!processHandle) throw failure(kernel32, 'OpenProcess');
    try {
      if (!kernel32.AssignProcessToJobObject(handle, processHandle))
        throw failure(kernel32, 'AssignProcessToJobObject');
    } finally {
      kernel32.CloseHandle(processHandle);
    }
  } catch (err) {
    kernel32.CloseHandle(handle);
    throw err;
  }
  const holdings = linkedHoldings(kernel32, handle);
  // Closed once: a handle's number can come to name another object, so a second close could close that.
  let open = true;
  const members = () => {
    let room = 64;
    for (let attempt = 0; attempt < 6; attempt++) {
      const list = Buffer.alloc(8 + 8 * room);
      if (kernel32.QueryInformationJobObject(handle, BASIC_PROCESS_ID_LIST, list, list.length, 0n))
        return Array.from({ length: list.readUInt32LE(4) }, (_, i) => Number(list.readBigUInt64LE(8 + 8 * i)));
      const error = kernel32.GetLastError();
      if (error !== ERROR_MORE_DATA) throw new Error(`QueryInformationJobObject: win32 error ${error}`);
      room = Math.max(2 * room, list.readUInt32LE(0) + 16); // the job grew past the list; its header says to how many
    }
    throw new Error('QueryInformationJobObject: the job kept growing past its list');
  };
  return {
    members,
    leftovers(commandPid) {
      const left = members();
      return left.length ? commandCleanup.leftoverPids(left, processes(kernel32), commandPid) : left;
    },
    terminate() {
      if (!kernel32.TerminateJobObject(handle, 1)) throw failure(kernel32, 'TerminateJobObject');
    },
    async emptied() {
      while (members().length) await sleep(20);
    },
    hold: holdings.hold,
    exited: holdings.exited,
    endHeld: holdings.endHeld,
    close() {
      if (open) kernel32.CloseHandle(handle);
      open = false;
      holdings.close();
    },
  };
}

// The command, running; its job, or null with the reason it runs uncontained.
export type Started = { child: ChildProcess; job: Job | null; containmentError?: string };

// child put in a new job: with no kernel32, or a job that cannot be set up, it runs uncontained.
function contain(kernel32: Kernel32 | null, child: ChildProcess): Started {
  let job: Job | null = null;
  let reason: string | undefined = kernel32 ? undefined : 'node:ffi is unavailable';
  if (kernel32 && child.pid !== undefined)
    try {
      job = createJob(kernel32, child.pid);
    } catch (err) {
      reason = (err as Error).message;
    }
  if (!reason) return { child, job };
  return { child, job, containmentError: `job object unavailable (${reason}): orphaned descendants are not contained` };
}

// Starts commandLine through cmd.exe, which waits on a gate line of stdin, puts cmd.exe in a new job, and then opens
// the gate, so the command starts inside the job, as does each process it starts that Windows does not start outside
// it, as it does a packaged app's (ADR 0030 decision 3). The gate swallows any stdin written with it, so the
// command reads only EOF. The gate line is not empty, since an empty one leaves the error level at 1, and the gate
// variable is cleared, so the command starts as in a fresh cmd.exe. With no kernel32, or a job that cannot be set up,
// the command runs uncontained.
export function start(kernel32: Kernel32 | null, commandLine: string, cwd: string | undefined): Started {
  const gated = `"set /p GG_GATE= & set "GG_GATE=" & ${commandLine}"`;
  const child = spawn(`${SYSTEM32}\\cmd.exe`, ['/d', '/s', '/c', gated], {
    cwd,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started = contain(kernel32, child);
  child.stdin.on('error', () => {}); // cmd.exe already gone: its exit reports it
  child.stdin.end('go\n');
  return started;
}

const GATE = fileURLToPath(new URL('./containment-gate.ts', import.meta.url));

// An argv started with no shell: the node gate (lib/containment-gate.ts) starts first, is put in a new job, and only
// then is sent the argv, which it starts on its own stdio, so the argv starts inside the job, as start's command does.
// spawned
// settles once the gate has answered: null when the argv started, else the error that stopped it. Uncontained as start
// is.
export function startArgv(
  kernel32: Kernel32 | null,
  argv: { command: string; args: string[] },
  { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv },
): Started & { spawned: Promise<Error | null> } {
  const child = spawn(process.execPath, [GATE], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const spawned = new Promise<Error | null>((answer) => {
    child.on('message', (message) => {
      const { error } = message as { error?: { message: string; code?: string } };
      answer(error ? Object.assign(new Error(error.message), { code: error.code }) : null);
    });
    child.on('disconnect', () => answer(new Error(`the launch gate ended before it started ${argv.command}`)));
    child.on('error', answer);
  });
  const started = contain(kernel32, child);
  if (child.connected) child.send(argv);
  return { ...started, spawned };
}
