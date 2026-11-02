import type { ChildProcess } from 'node:child_process';
import type * as ffi from 'node:ffi';

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

export type Kernel32 = ffi.DynamicLibraryResult<typeof SIGNATURES>['functions'];

export type Job = {
  members(): number[];
  leftovers(commandPid: number): number[];
  terminate(): void;
  emptied(): Promise<number[]>;
  release(): void;
  close(): void;
};

export type Started = { child: ChildProcess; job: Job | null; containmentError?: string };

export function openKernel32(): Kernel32 | null {
  return null;
}

export function linkedTo(_kernel32: Kernel32, _rootPid: number): number[] {
  return [];
}

export function start(_kernel32: Kernel32 | null, _commandLine: string, _cwd: string | undefined): Started {
  throw new Error('not implemented');
}
