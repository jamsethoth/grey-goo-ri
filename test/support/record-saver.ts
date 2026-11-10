// Spawned by the record and integrity tests: another gg process saving one ticket record `count` times.
// The test runner also loads this file with no arguments, where it does nothing.
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';

const [commonDir, ticket, count, worktree] = process.argv.slice(2);
if (commonDir) {
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: Number(ticket),
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: worktree ?? `${commonDir}/wt-${ticket}`,
    branch: `ticket/${ticket}`,
    base: 'main',
  });
  for (let i = 1; i <= Number(count); i++) {
    executionRecord.activity = { busy: i % 2 === 1, generation: i };
    record.save(executionRecord);
  }
  stateDatabase.close(commonDir);
}
