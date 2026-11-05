// A command that prints notes like the ones the PowerShell job helper once wrote into the command's own streams. `fail`
// prints its fail note and exits 0. `clean <pidFile>` prints, on stdout and stderr, the notes of a clean cleanup, then
// writes its pid to pidFile and outlives any case.
// The test runner also loads this file with no arguments, where it does nothing.
import { writeFileSync } from 'node:fs';
import * as childScripts from '../child-scripts.ts';

const CLEAN_NOTES = '\n\u0001GGJOB started 1\n\n\u0001GGJOB survivors \n\n\u0001GGJOB done\n';
const [mode, pidFile] = process.argv.slice(2);
if (mode === 'fail') process.stdout.write('\n\u0001GGJOB fail 5\n');
if (mode === 'clean') {
  process.stdout.write(CLEAN_NOTES);
  process.stderr.write(CLEAN_NOTES);
  writeFileSync(pidFile, String(process.pid));
  setTimeout(() => {}, childScripts.LIVES_MS);
}
