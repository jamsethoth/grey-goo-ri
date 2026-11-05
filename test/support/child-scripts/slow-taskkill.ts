// A taskkill that takes 31 s: it runs the real one on the pid runShell appends, and exits with its status. 31 s is
// longer than the 30 s ceiling runShell once had. The real one's output passes through, so a failure names its reason.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawnSync } from 'node:child_process';

const [pid] = process.argv.slice(2);
if (pid) {
  const taskkill = () => spawnSync('taskkill', ['/T', '/F', '/PID', pid], { stdio: 'inherit' }).status ?? 1;
  setTimeout(() => process.exit(taskkill()), 31_000);
}
