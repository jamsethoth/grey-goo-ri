// A taskkill that takes 31 s: it runs the real one on the pid runShell appends, and exits with its status. 31 s is
// longer than the 30 s ceiling runShell once had.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawnSync } from 'node:child_process';

const [pid] = process.argv.slice(2);
if (pid) setTimeout(() => process.exit(spawnSync('taskkill', ['/T', '/F', '/PID', pid]).status ?? 1), 31_000);
