// An Execution Record as admission creates it, before its first Visit: of the fixture Ticket on its branch and
// worktree unless a case names others. It is not saved, so a case may change it first and then call record.save.
// seedExecution is for a record with Visits behind it.
import * as record from '../../lib/record.ts';
import * as golden from './golden.ts';

export const SEED_RUN = '20261016T000000Z-seed00';

export function unvisitedExecution(
  fixture: { commonDir: string; worktree: string },
  {
    ticket = golden.TICKET,
    run = SEED_RUN,
    branch = golden.BRANCH,
    worktree = fixture.worktree,
    repository = 'o/r',
  }: { ticket?: number; run?: string; branch?: string; worktree?: string; repository?: string } = {},
): record.ExecutionRecord {
  return record.createExecutionRecord({
    commonDir: fixture.commonDir,
    repository,
    ticket,
    epic: null,
    flow: { name: 'default', entry: 'red' },
    configHash: 'x',
    run,
    worktree,
    branch,
    base: 'main',
  });
}
