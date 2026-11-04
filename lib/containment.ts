// A Windows command and every process it starts, orphans included, held in a job object gg creates through node:ffi
// (ADR 0021): started inside it, listed, terminated and confirmed empty. A Linux cgroup backend (#128) belongs here.
import { spawn, type ChildProcess } from 'node:child_process';
import type * as ffi from 'node:ffi';
import { setTimeout as sleep } from 'node:timers/promises';
import * as commandCleanup from './command-cleanup.ts';

// The struct offsets below are 64-bit Windows', the only Windows Node 26 is built for (x64 and arm64).
const SIGNATURES = {
  CreateJobObjectW: { arguments: ['pointer', 'pointer'], return: 'pointer' },
  SetInformationJobObject: { arguments: ['pointer', 'int32', 'buffer', 'uint32'], return: 'int32' },
  QueryInformationJobObject: { arguments: ['pointer', 'int32', 'buffer', 'uint32', 'pointer'], return: 'int32' },
  AssignProcessToJobObject: { arguments: ['pointer', 'pointer'], return: 'int32' },
  TerminateJobObject: { arguments: ['pointer', 'uint32'], return: 'int32' },
  OpenProcess: { arguments: ['uint32', 'int32', 'uint32'], return: 'pointer' },
  CloseHandle: { arguments: ['pointer'], return: 'int32' },
  GetLastError: { arguments: [], return: 'uint32' },
  CreateToolhelp32Snapshot: { arguments: ['uint32', 'uint32'], return: 'pointer' },
  Process32FirstW: { arguments: ['pointer', 'buffer'], return: 'int32' },
  Process32NextW: { arguments: ['pointer', 'buffer'], return: 'int32' },
} as const;

// The kernel32 functions gg calls. bin/gg.mjs opens them once and passes them down; a test passes null or a copy with
// some replaced.
export type Kernel32 = ffi.DynamicLibraryResult<typeof SIGNATURES>['functions'];

// A bare cmd.exe or taskkill.exe is looked up in the child's working directory before PATH (libuv's search_path), and
// an agent can write there.
export const SYSTEM32 = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32`;

const KILL_ON_JOB_CLOSE = 0x2000;
// Without it a tool that asks to break away fails to start its child; a child that asks is outside the job by design.
const BREAKAWAY_OK = 0x800;
const EXTENDED_LIMIT_INFORMATION = 9; // 144 bytes, LimitFlags at byte 16
const BASIC_PROCESS_ID_LIST = 3; // two counts, then one 8-byte pid per process
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001; // what AssignProcessToJobObject needs
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
    return process.getBuiltinModule('node:ffi')?.dlopen('kernel32.dll', SIGNATURES).functions ?? null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function processes(kernel32: Kernel32): commandCleanup.ProcessEntry[] {
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

// The pids still linked to rootPid through parent pids, for the fallback that has no job to list.
export function linkedDescendants(kernel32: Kernel32, rootPid: number): number[] {
  const rows = processes(kernel32).map(({ pid, parentPid }): commandCleanup.ProcessRow => [pid, parentPid, '']);
  const linked: number[] = [];
  commandCleanup.growTree(new Set([rootPid]), rows, process.pid, ([pid]) => linked.push(pid));
  return linked;
}

export type Job = {
  // the pids in the job; throws when the job cannot be read, which must never pass for an empty job
  members(): number[];
  // the members once the command has exited, less the console host its spawn gave it
  leftovers(commandPid: number): number[];
  terminate(): void;
  // resolves once a terminated job is empty, however long a loaded machine takes to finish the exits
  emptied(): Promise<void>;
  // lets the members run on and closes gg's handle; throws, keeping the handle, when kill-on-close cannot be dropped,
  // since closing it then would kill them
  release(): void;
  close(): void;
};

function setLimits(kernel32: Kernel32, handle: bigint, flags: number) {
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(flags, 16);
  return kernel32.SetInformationJobObject(handle, EXTENDED_LIMIT_INFORMATION, limits, limits.length);
}

// A job holding pid, with kill-on-close: gg holds its only handle, so the job's processes die with gg too.
function createJob(kernel32: Kernel32, pid: number): Job {
  const handle = kernel32.CreateJobObjectW(0n, 0n);
  if (!handle) throw failure(kernel32, 'CreateJobObjectW');
  try {
    if (!setLimits(kernel32, handle, KILL_ON_JOB_CLOSE | BREAKAWAY_OK))
      throw failure(kernel32, 'SetInformationJobObject');
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
    release() {
      if (!setLimits(kernel32, handle, BREAKAWAY_OK)) throw failure(kernel32, 'SetInformationJobObject');
      kernel32.CloseHandle(handle);
    },
    close() {
      kernel32.CloseHandle(handle);
    },
  };
}

// The command, running; its job, or null with the reason it runs uncontained.
export type Started = { child: ChildProcess; job: Job | null; containmentError?: string };

// Starts commandLine through cmd.exe, which waits on a gate line of stdin, puts cmd.exe in a new job, and then opens
// the gate, so nothing the command starts is outside the job. The gate swallows any stdin written with it, so the
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
  let job: Job | null = null;
  let reason: string | undefined = kernel32 ? undefined : 'node:ffi is unavailable';
  if (kernel32 && child.pid !== undefined)
    try {
      job = createJob(kernel32, child.pid);
    } catch (err) {
      reason = (err as Error).message;
    }
  child.stdin.on('error', () => {}); // cmd.exe already gone: its exit reports it
  child.stdin.end('go\n');
  if (!reason) return { child, job };
  return { child, job, containmentError: `job object unavailable (${reason}): orphaned descendants are not contained` };
}
