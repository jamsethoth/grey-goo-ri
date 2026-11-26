import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as commandShim from '../../lib/command-shim.ts';

// A Store app's execution alias, as the user's WindowsApps folder holds one: a link the user may not stat.
const WINDOWS_APPS = 'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps';
const aliasStat = (file: string) => {
  if (file === `${WINDOWS_APPS}\\pwsh.exe`)
    throw Object.assign(new Error(`EACCES: permission denied, stat '${file}'`), { code: 'EACCES' });
  return undefined;
};

test(
  "a Store app's execution alias found first on PATH starts as named",
  { skip: process.platform !== 'win32' && 'argvOf resolves a command only on Windows' },
  () => {
    const argvOf = () =>
      commandShim.argvOf('pwsh', ['-c', 'exit'], { path: WINDOWS_APPS, cwd: 'C:\\work', stat: aliasStat });
    assert.doesNotThrow(argvOf, 'the alias it may not stat');
    assert.deepEqual(argvOf(), { command: 'pwsh', args: ['-c', 'exit'] });
  },
);
