// Spawned by the events tests: another gg process appending `count` run_start Events for run `run`.
// The test runner also loads this file with no arguments, where it does nothing.
import * as events from '../../lib/events.ts';
import * as sqlite from '../../lib/sqlite.ts';
const [commonDir, run, count] = process.argv.slice(2);
if (commonDir) {
  const log = events.eventLog(commonDir, { run });
  for (let i = 1; i <= Number(count); i++) log('run_start');
  sqlite.close(commonDir);
}
