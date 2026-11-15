import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import * as branchTip from '../../lib/branch-tip.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// Ticket 7's record with no commit of gg's, and a gg work resume that took `person-sha` as its baseline.
function resumedRecord(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-branch-tip-');
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 7,
    epic: null,
    flow: { name: 'default', entry: 'red' },
    configHash: 'x',
    run: '20261115T000000Z-seed00',
    worktree: commonDir,
    branch: 'ticket/7-add',
    base: 'main',
  });
  record.save(executionRecord);
  const { execution, ticket, owner } = executionRecord;
  events.eventLog(commonDir)('ticket_resumed', {
    execution,
    ticket,
    owner,
    human: 'octo-human',
    vertex: 'red',
    head: 'person-sha',
    superseded: [],
  });
  return { commonDir, executionRecord };
}

test('the branch tip is the one a resume took when gg has no commit after it', (t) => {
  const { executionRecord } = resumedRecord(t);
  assert.deepEqual(branchTip.provenTip(executionRecord), {
    sha: 'person-sha',
    what: 'person-sha, the tip gg work resume took as the baseline',
  });
});

// Without the resume it names, the branch would have no baseline at all, and Reconciliation would let any tip through.
test('a ticket_resumed row that fails its check stops the branch tip read', (t) => {
  const { commonDir, executionRecord } = resumedRecord(t);
  stateDatabase
    .open(commonDir)
    .prepare(`UPDATE events SET json = replace(json, '"head":"person-sha"', '"head":5') WHERE type = 'ticket_resumed'`)
    .run();
  assert.throws(() => branchTip.provenTip(executionRecord), eventRead.EventCorruptError);
});
