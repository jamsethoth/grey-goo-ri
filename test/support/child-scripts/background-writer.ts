// A process that appends to path, writes its pid to pidFile, and keeps appending until something kills it, as a
// background process a command left behind would go on changing the worktree. The first append comes before the pid, so
// a command that waits for the pid has always changed the worktree by the time it ends.
// The test runner also loads this file with no arguments, where it does nothing.
import { appendFileSync, writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [pidFile, path] = process.argv.slice(2);
if (path) {
  appendFileSync(path, 'more\n');
  writeFileSync(pidFile!, String(process.pid));
  setInterval(() => appendFileSync(path, 'more\n'), 20);
  setTimeout(() => process.exit(0), childScripts.LIVES_MS);
}
