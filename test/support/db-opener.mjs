// Spawned by the record tests: another gg process that only opens the State Database, then closes it. It prints
// `locking` as it starts to wait for the open lock, which is after it has read the database's version, and then how
// long the open took, `opened in <ms> ms`, whether or not the open succeeded.
// The test runner also loads this file with no arguments, where it does nothing.
import { DatabaseSync } from 'node:sqlite';
import * as record from '../../lib/record.mjs';
const [commonDir] = process.argv.slice(2);
if (commonDir) {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'BEGIN EXCLUSIVE') process.stdout.write('locking\n');
    return exec.call(this, sql);
  };
  const started = Date.now();
  try {
    record.openDb(commonDir);
  } finally {
    process.stdout.write(`opened in ${Date.now() - started} ms\n`);
  }
  record.close(commonDir);
}
