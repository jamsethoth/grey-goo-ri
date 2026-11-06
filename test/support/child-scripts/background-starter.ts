// A command that finishes and leaves a child running: it starts a script as an ordinary child, in its own process group
// or job, with stdio 'ignore' or 'inherit', waits until the script has written pidFile, and exits with exitCode. So the
// child is running by the time the command ends, however slowly it starts.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const [stdio, exitCode, pidFile, script, ...rest] = process.argv.slice(2);
if (script) {
  spawn(process.execPath, [script, pidFile!, ...rest], { stdio: stdio === 'inherit' ? 'inherit' : 'ignore' }).unref();
  const wait = setInterval(() => {
    if (!existsSync(pidFile!)) return;
    clearInterval(wait);
    process.exit(Number(exitCode));
  }, 20);
}
