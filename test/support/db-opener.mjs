// Spawned by the record tests: another gg process that only opens the State Database, then closes it.
// The test runner also loads this file with no arguments, where it does nothing.
import * as record from '../../lib/record.mjs';
const [commonDir] = process.argv.slice(2);
if (commonDir) {
  process.stdout.write('opening\n');
  record.openDb(commonDir);
  record.close(commonDir);
}
