// A taskkill that takes 31 s: it runs the real one on the pid runShell appends, and exits with its status. 31 s is
// longer than the 30 s ceiling runShell once had.
import { spawnSync } from 'node:child_process';

const [pid] = process.argv.slice(2);
setTimeout(() => process.exit(spawnSync('taskkill', ['/T', '/F', '/PID', pid]).status ?? 1), 31_000);
