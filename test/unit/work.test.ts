import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as locks from '../../lib/locks.ts';
import * as record from '../../lib/record.ts';
import * as work from '../../lib/work.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const TICKET = 7;
const IN_PROGRESS = 'gg:state:in-progress';

// A repository's common dir holding Ticket 7's Execution Record, one Event and its worktree, with the Ticket labelled
// in progress on the fake gh.
function abandoning(t: TestContext) {
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

test('gg work abandon deletes the Execution Record row and keeps its Events and worktree', async (t) => {
  const { commonDir, worktree, fake, options } = abandoning(t);
  const text = await work.abandon(options);
  assert.equal(record.load(commonDir, 'ticket', TICKET), null, 'the row is deleted');
  assert.deepEqual(
    eventRead.readEvents(commonDir).map((event) => event.type),
    ['run_start'],
    'the Events are kept',
  );
  assert.ok(existsSync(worktree), 'the worktree is kept');
  assert.ok(!fake.labels.has(IN_PROGRESS), 'the Ticket is no longer labelled in progress');
  assert.equal(
    text,
    'gg work abandon deleted Execution Record ticket-7 of Flow gone and removed the gg:state:in-progress label; its ' +
      `Events, its worktree ${worktree} and its branch ticket/7-add are kept. gg run 7 --flow <name> starts a new ` +
      'Execution on that branch.\n',
  );
});

// Readiness refuses a Ticket with any State Label, so abandoning a held Ticket clears its needs-human too.
test('gg work abandon removes every State Label the Ticket carries, so the next Run can admit it', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  fake.labels.add('gg:state:needs-human');
  fake.labels.add('gg:await:approve');
  const text = await work.abandon(options);
  assert.equal(record.load(commonDir, 'ticket', TICKET), null, 'the row is deleted');
  assert.deepEqual([...fake.labels].sort(), ['gg:await:approve'], 'only the State Labels go');
  assert.match(text, / and removed the gg:state:in-progress, gg:state:needs-human labels; /);
});

test('gg work abandon refuses while the ticket lock is held', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  const held = await locks.tryAcquire(commonDir, `ticket-${TICKET}`);
  assert.ok(held, 'the case holds the ticket lock');
  try {
    await assert.rejects(work.abandon(options), {
      message: 'another process holds the ticket-7 lock, so Ticket 7 may be running; abandon it once that process ends',
    });
  } finally {
    // Before the temp directory goes: Windows will not remove an open lock file.
    await locks.release(held);
  }
  assert.ok(record.load(commonDir, 'ticket', TICKET), 'the record is kept');
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

test('gg work abandon of a Ticket with no Execution Record says so and changes nothing', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  assert.ok(record.removeRecord(commonDir, 'ticket', TICKET), 'removeRecord says it deleted a row');
  await assert.rejects(work.abandon(options), { message: 'Ticket 7 has no Execution Record to abandon' });
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

// A record deleted while the label stays would read as stuck, so a failed label update keeps the record.
test('gg work abandon keeps the record when its in-progress label cannot be removed', async (t) => {
  const { commonDir, fake, options } = abandoning(t);
  fake.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'edit', status: 502 });
  await assert.rejects(work.abandon(options), /label update .* failed: .*; Execution Record ticket-7 is kept$/);
  assert.ok(record.load(commonDir, 'ticket', TICKET), 'the record is kept');
  assert.ok(fake.labels.has(IN_PROGRESS), 'the label is kept');
});

// Only gg init creates the State Database (#150), so abandon refuses a repository without one before it takes the
// ticket lock, which would leave a lock file behind.
test('gg work abandon refuses a missing State Database before it takes the ticket lock', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-work-');
  const fake = fakeGh.fakeGh({ branch: 'ticket/7-add', ticket: TICKET });
  const options = { ticket: TICKET, commonDir, cwd: commonDir, labelPrefix: 'gg', gh: github.createGh(fake.gh), locks };
  await assert.rejects(work.abandon(options), {
    message: `no State Database at ${join(commonDir, 'gg', 'gg.db')}: run gg init`,
  });
  assert.equal(existsSync(join(commonDir, 'gg')), false, 'no gg directory: no lock file and no database');
  assert.deepEqual(fake.calls, [], 'no gh call');
});
