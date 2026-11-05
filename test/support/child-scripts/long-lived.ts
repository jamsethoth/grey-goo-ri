// A process that writes its pid to pidFile and then outlives any case, so only a kill ends it. Given a line, it prints
// the line first.
// The test runner also loads this file with no arguments, where it does nothing.
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [pidFile, line] = process.argv.slice(2);
if (pidFile) {
  if (line) console.log(line);
  writeFileSync(pidFile, String(process.pid));
  setTimeout(() => {}, childScripts.LIVES_MS);
}
