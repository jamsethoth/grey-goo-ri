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

// The resume row's own corruptions, one per column eventLog copies and per field it saves: each makes the row fail its
// check, and none may drop the baseline, whichever copy of the row is the corrupt one.
const ROW_CORRUPTIONS: Record<string, string> = {
  ...Object.fromEntries(
    eventRead.COLUMNS.map((column) => [`its ${column} column`, `${column} = ${column === 'ticket' ? 99 : "'other'"}`]),
  ),
  ...Object.fromEntries(
    ['schemaVersion', 'time', 'type', ...Object.keys(events.LIFECYCLE.ticket_resumed)].map((key) => [
      `no ${key} field`,
      `json = json_remove(json, '$.${key}')`,
    ]),
  ),
  'a head that is not a string': `json = json_set(json, '$.head', 5)`,
  'an undeclared field': `json = json_set(json, '$.extra', 1)`,
  'JSON that does not parse': `json = substr(json, 1, length(json) - 1)`,
};

test('every corruption of a resume row stops the branch tip read, and none of another Execution does', (t) => {
  assert.ok(Object.keys(ROW_CORRUPTIONS).length > 12, 'the corpus covers every column and field');
  for (const [name, change] of Object.entries(ROW_CORRUPTIONS)) {
    const { commonDir, executionRecord } = resumedRecord(t);
    stateDatabase.open(commonDir).prepare(`UPDATE events SET ${change} WHERE type = 'ticket_resumed'`).run();
    assert.throws(() => branchTip.provenTip(executionRecord), eventRead.EventCorruptError, name);
  }
  for (const [name, change] of Object.entries(ROW_CORRUPTIONS)) {
    if (name === 'its execution column') continue;
    const { commonDir, executionRecord } = resumedRecord(t);
    const other = { ...executionRecord.owner };
    events.eventLog(commonDir)('ticket_resumed', {
      execution: 'another-execution',
      ticket: 8,
      owner: { ...other, number: 8 },
      human: 'octo-human',
      vertex: 'red',
      head: 'other-sha',
      superseded: [],
    });
    stateDatabase
      .open(commonDir)
      .prepare(`UPDATE events SET ${change} WHERE type = 'ticket_resumed' AND ticket = 8`)
      .run();
    assert.equal(branchTip.provenTip(executionRecord)?.sha, 'person-sha', `${name}, on another Execution's row`);
  }
});

// A resume completes a commit it finds just before it saves ticket_resumed, so the two can share a millisecond; the
// person's tip, taken at the resume, is the later baseline.
test("a resume's tip outranks a commit of gg's saved in the same millisecond", (t) => {
  const { executionRecord } = resumedRecord(t);
  const [resumed] = eventRead.executionEvents(executionRecord.commonDir, executionRecord.execution);
  executionRecord.writeAheadLog.push({
    step: 'evidence',
    actionMarker: 'm-commit',
    effect: 'commit',
    payload: null,
    evidence: { sha: 'gg-sha' },
    time: resumed!.time,
  });
  assert.equal(branchTip.provenTip(executionRecord)?.sha, 'person-sha');
});
