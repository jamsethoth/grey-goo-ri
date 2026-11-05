// A process that starts a long-lived child detached, with stdio 'ignore' or 'inherit', and exits once that child has
// written its pid to pidFile: the command has finished, and left the child running.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [stdio, pidFile] = process.argv.slice(2);
spawn(process.execPath, [childScripts.LONG_LIVED, pidFile], {
  detached: true,
  stdio: stdio === 'inherit' ? 'inherit' : 'ignore',
}).unref();
setInterval(() => existsSync(pidFile) && process.exit(0), 20);
