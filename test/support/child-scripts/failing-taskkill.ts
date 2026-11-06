// A taskkill that does its work and then answers exit 255, as the real one does when the shell exits between its kills.
// `tree` runs the real one with /T, `shell` kills only the shell. The seam gets the pid as its last argument.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawnSync } from 'node:child_process';

const [mode, pid] = process.argv.slice(2);
if (pid) {
  spawnSync('taskkill', [...(mode === 'tree' ? ['/T'] : []), '/F', '/PID', pid], { stdio: 'ignore' });
  process.exit(255);
}
