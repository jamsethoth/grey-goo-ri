// A command that prints, on stdout and stderr, the notes the PowerShell job helper once wrote for a clean cleanup, then
// writes its pid to pidFile and outlives any case.
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const NOTES = '\n\u0001GGJOB started 1\n\n\u0001GGJOB survivors \n\n\u0001GGJOB done\n';
const [pidFile] = process.argv.slice(2);
process.stdout.write(NOTES);
process.stderr.write(NOTES);
writeFileSync(pidFile, String(process.pid));
setTimeout(() => {}, childScripts.LIVES_MS);
