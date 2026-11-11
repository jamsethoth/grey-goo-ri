// Spawned by the record tests: another gg init creating the State Database. It prints `ready` once loaded and creates
// only when stdin brings `go`, so a case can start many creators together, then prints `created` or `kept`.
// The test runner also loads this file with no arguments, where it does nothing.
import * as stateDatabase from '../../lib/state-database.ts';

const [commonDir] = process.argv.slice(2);
if (commonDir) {
  let input = '';
  process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
    input += chunk;
    if (!input.includes('go\n')) return;
    process.stdin.destroy();
    process.stdout.write(stateDatabase.create(commonDir) ? 'created\n' : 'kept\n');
  });
  process.stdout.write('ready\n');
}
