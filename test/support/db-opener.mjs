// Spawned by the record tests: another gg process that only opens the State Database, then closes it. It prints
// `locking` as it starts to wait for the open lock, which is after it has read the database's version, and
// `failed: <statement>` when a statement fails, so a case can tell which wait gave up. Started with `gated`, it prints
// `ready` once loaded and opens only when stdin brings `go`, so a case can start many openers' waits together.
// The test runner also loads this file with no arguments, where it does nothing.
import { DatabaseSync } from 'node:sqlite';
import * as record from '../../lib/record.mjs';
const [commonDir, gated] = process.argv.slice(2);
if (commonDir) {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'BEGIN EXCLUSIVE') process.stdout.write('locking\n');
    try {
      return exec.call(this, sql);
    } catch (err) {
      process.stdout.write(`failed: ${sql}\n`);
      throw err;
    }
  };
  const open = () => {
    record.openDb(commonDir);
    record.close(commonDir);
  };
  if (gated === 'gated') {
    let input = '';
    process.stdin.setEncoding('utf8').on('data', (chunk) => {
      input += chunk;
      if (input.includes('go\n')) {
        process.stdin.destroy();
        open();
      }
    });
    process.stdout.write('ready\n');
  } else {
    open();
  }
}
