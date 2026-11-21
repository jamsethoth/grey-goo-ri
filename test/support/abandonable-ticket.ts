// A Ticket for gg work abandon to forget: its Execution Record, one Event and its worktree in a new State Database,
// with the Ticket labelled in progress on the fake gh.
import type { TestContext } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as locks from '../../lib/locks.ts';
import * as record from '../../lib/record.ts';
import * as fakeGh from './fake-gh.ts';
import * as tempDirectory from './temp-directory.ts';

export const TICKET = 7;
export const IN_PROGRESS = 'gg:state:in-progress';

export function seed(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-work-');
  const worktree = join(commonDir, 'wt', 'ticket-7');
  mkdirSync(worktree, { recursive: true });
  record.save(
    record.createExecutionRecord({
      commonDir,
      repository: 'o/r',
      ticket: TICKET,
      epic: null,
      flow: { name: 'gone', entry: 'red' },
      configHash: 'x',
      run: '20261016T000000Z-seed00',
      worktree,
      branch: 'ticket/7-add',
      base: 'main',
    }),
  );
  events.eventLog(commonDir)('run_start', { run: '20261016T000000Z-seed00' });
  const fake = fakeGh.fakeGh({ branch: 'ticket/7-add', ticket: TICKET });
  fake.labels.add(IN_PROGRESS);
  const options = { ticket: TICKET, commonDir, cwd: commonDir, labelPrefix: 'gg', gh: github.createGh(fake.gh), locks };
  return { commonDir, worktree, fake, options };
}
