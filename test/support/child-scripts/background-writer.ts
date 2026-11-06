// A process that writes its pid to pidFile, and then keeps appending to path until something kills it, as a background
// process a command left behind would go on changing the worktree.
// The test runner also loads this file with no arguments, where it does nothing.
import { appendFileSync, writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [pidFile, path] = process.argv.slice(2);
if (path) {
  writeFileSync(pidFile!, String(process.pid));
  setInterval(() => appendFileSync(path, 'more\n'), 20);
  setTimeout(() => process.exit(0), childScripts.LIVES_MS);
}
