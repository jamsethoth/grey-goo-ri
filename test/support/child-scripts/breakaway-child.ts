// A process that starts `node script args` with CREATE_BREAKAWAY_FROM_JOB through node:ffi, prints
// `created pid=<pid>` or `failed win32error=<code>`, writes the same to createdFile, and outlives any case.
// STARTUPINFOW is 104 bytes on 64-bit Windows, and PROCESS_INFORMATION's dwProcessId sits at byte 16.
// The test runner also loads this file with no arguments, where it does nothing.
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const [createdFile, ...command] = process.argv.slice(2);
if (createdFile) {
  const ffi = process.getBuiltinModule('node:ffi');
  const kernel32 = ffi.dlopen('kernel32.dll', {
    CreateProcessW: {
      arguments: [
        'pointer',
        'buffer',
        'pointer',
        'pointer',
        'int32',
        'uint32',
        'pointer',
        'pointer',
        'buffer',
        'buffer',
      ],
      return: 'int32',
    },
    GetLastError: { arguments: [], return: 'uint32' },
  } as const).functions;
  const startup = Buffer.alloc(104);
  startup.writeUInt32LE(104, 0);
  const info = Buffer.alloc(24);
  const line = Buffer.from(`${[process.execPath, ...command].map((arg) => `"${arg}"`).join(' ')}\0`, 'utf16le');
  const created = kernel32.CreateProcessW(0n, line, 0n, 0n, 0, CREATE_BREAKAWAY_FROM_JOB, 0n, 0n, startup, info);
  const report = created ? `created pid=${info.readUInt32LE(16)}` : `failed win32error=${kernel32.GetLastError()}`;
  console.log(report);
  writeFileSync(createdFile, report);
  setTimeout(() => {}, childScripts.LIVES_MS);
}
