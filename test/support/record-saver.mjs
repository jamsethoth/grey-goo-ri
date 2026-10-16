// Spawned by the record and integrity tests: another gg process saving one ticket record `count` times.
// The test runner also loads this file with no arguments, where it does nothing.
import * as record from '../../lib/record.mjs';
const [commonDir, ticket, count, worktree] = process.argv.slice(2);
if (commonDir) {
  const r = record.createExecution({
    commonDir, ticket: Number(ticket), epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123',
    run: 'run-1', worktree: worktree ?? `${commonDir}/wt-${ticket}`, branch: `ticket/${ticket}`, base: 'main',
  });
  for (let i = 1; i <= Number(count); i++) {
    r.activity = { busy: i % 2 === 1, generation: i };
    await record.save(r);
  }
  record.close(commonDir);
}
