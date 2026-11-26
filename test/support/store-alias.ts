import type { TestContext } from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import * as caseEnv from './case-env.ts';
import * as tempDirectory from './temp-directory.ts';

// A stand-in for the Microsoft Store's app execution alias to PowerShell 7 (#533), until the case ends: a file symlink
// named `file` in a folder named bin, to a missing target under a WindowsApps folder. As the real alias's target, which
// the user cannot stat, it is a link existsSync does not see, so only following it to its target finds the app it
// starts. Gives the bin folder.
export function storeAlias(t: TestContext, file = 'pwsh.exe'): string {
  const directory = tempDirectory.tempDirectory(t, 'gg-store-alias-');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const app = join(directory, 'Program Files', 'WindowsApps', 'Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe');
  symlinkSync(join(app, file), join(bin, file), 'file');
  return bin;
}

// An unpackaged pwsh first on PATH until the case ends, so a shipped Harness's shell check passes whatever the
// machine's first is (#533).
export function unpackagedShellFirst(t: TestContext) {
  const directory = tempDirectory.tempDirectory(t, 'gg-unpackaged-shell-');
  writeFileSync(join(directory, 'pwsh.exe'), '');
  caseEnv.caseEnv(t, { PATH: [directory, process.env.PATH ?? ''].join(delimiter) });
}
