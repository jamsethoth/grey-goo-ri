// A process that starts a long-lived child detached, with stdio 'ignore' or 'inherit', writes that child's pid to
// pidFile and exits: the command has finished, and left the child running, however slowly the child starts. The child
// writes its own file, so it never truncates pidFile while a case reads it.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [stdio, pidFile] = process.argv.slice(2);
if (pidFile) {
  const child = spawn(process.execPath, [childScripts.LONG_LIVED, `${pidFile}.child`], {
    detached: true,
    stdio: stdio === 'inherit' ? 'inherit' : 'ignore',
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}
