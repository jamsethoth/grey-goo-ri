// A process that starts a long-lived grandchild writing pidFile before it prints anything, then prints line once that
// pid is written, and outlives any case. On Windows the grandchild is detached, which keeps it out of the job libuv
// gives each node process's children, so only a job its launcher holds ends it with its parent; elsewhere it stays in
// its parent's process group, which no parent's death ends.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [pidFile, line] = process.argv.slice(2);
if (pidFile) {
  spawn(process.execPath, [childScripts.LONG_LIVED, pidFile], {
    detached: process.platform === 'win32',
    stdio: 'ignore',
  });
  const written = setInterval(() => {
    if (!existsSync(pidFile) || !(Number(readFileSync(pidFile, 'utf8')) > 0)) return;
    clearInterval(written);
    console.log(line);
    setTimeout(() => {}, childScripts.LIVES_MS);
  }, 20);
}
