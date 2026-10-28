// Spawned by the record tests: another SQLite client that takes gg.db's write lock, prints `held`, and commits after
// `ms` milliseconds.
// The test runner also loads this file with no arguments, where it does nothing.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const [commonDir, ms] = process.argv.slice(2);
if (commonDir) {
  const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
  db.exec('BEGIN IMMEDIATE');
  setTimeout(() => {
    db.exec('COMMIT');
    db.close();
  }, Number(ms));
  process.stdout.write('held\n');
}
