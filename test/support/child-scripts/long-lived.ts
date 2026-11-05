// A process that outlives any case, so only a kill ends it. Given a file, it writes its pid there once it runs; given a
// line too, it prints the line first.
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const [pidFile, line] = process.argv.slice(2);
if (line) console.log(line);
if (pidFile) writeFileSync(pidFile, String(process.pid));
setTimeout(() => {}, childScripts.LIVES_MS);
