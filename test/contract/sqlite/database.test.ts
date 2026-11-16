// The reads and writes a Run makes through `database` (#367), each held over the real State Database and over the
// failing wrapper with no failure added, its second adapter (docs/testing.md, Test doubles).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as events from '../../../lib/events.ts';
import * as record from '../../../lib/record.ts';
import * as stateDatabase from '../../../lib/state-database/index.ts';
import * as caseDatabase from '../../support/case-database.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const ADAPTERS: [string, (t: TestContext) => stateDatabase.StateDatabase][] = [
  ['the real State Database', () => stateDatabase],
  ['the failing wrapper', (t) => caseDatabase.caseDatabase(t)],
];

const OWNER = { kind: 'ticket', number: 7 } as const;
const ticketRecord = (commonDir: string, ticket: number) =>
  record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, `wt-${ticket}`),
    branch: `ticket/${ticket}`,
    base: 'main',
  });

const typesOf = (found: events.Event[]) => found.map((event) => event.type);

for (const [name, databaseOf] of ADAPTERS) {
  test(`${name}: open passes a State Database gg init made, and refuses a missing one by name`, (t) => {
    const database = databaseOf(t);
    database.open(tempDirectory.stateDatabaseDirectory(t, 'gg-database-'));
    const missing = tempDirectory.tempDirectory(t, 'gg-database-');
    assert.throws(() => database.open(missing), {
      message: `no State Database at ${join(missing, 'gg', 'gg.db')}: run gg init`,
    });
  });

  test(`${name}: a Pinned Configuration reads back by its hash, and a second save of the hash keeps the first`, (t) => {
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-database-');
    const database = databaseOf(t);
    database.savePinnedConfiguration(commonDir, 'hash-1', { flows: ['first'] });
    database.savePinnedConfiguration(commonDir, 'hash-1', { flows: ['second'] });
    assert.deepEqual(database.loadPinnedConfiguration(commonDir, 'hash-1'), { flows: ['first'] });
    assert.equal(database.loadPinnedConfiguration(commonDir, 'hash-2'), null);
  });

  test(`${name}: reusablePass gives the latest pass for the tree and command, never a failure`, (t) => {
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-database-');
    const database = databaseOf(t);
    const result = { tree: 't1', command: 'npm test', state: 'passed', marker: 'm1', output: 'ok 1\n' };
    database.saveCheckResult(commonDir, result);
    database.saveCheckResult(commonDir, { ...result, marker: 'm2', output: 'ok 2\n' });
    database.saveCheckResult(commonDir, { ...result, state: 'failed', marker: 'm3', output: 'not ok\n' });
    database.saveCheckResult(commonDir, { ...result, tree: 't2', marker: 'm4' });
    assert.deepEqual({ ...database.reusablePass(commonDir, 't1', 'npm test') }, { marker: 'm2', output: 'ok 2\n' });
    assert.equal(database.reusablePass(commonDir, 't1', 'npm run lint'), null);
    assert.equal(database.reusablePass(commonDir, 't3', 'npm test'), null);
  });

  test(`${name}: an Execution's Events read back in the order they were appended`, (t) => {
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-database-');
    const database = databaseOf(t);
    const log = events.eventLog(commonDir, {}, database);
    log('run_start', { run: 'r1' });
    log('ticket_start', { run: 'r1', execution: 'e1', ticket: 7, owner: OWNER });
    log('ticket_start', { run: 'r1', execution: 'e2', ticket: 8, owner: { kind: 'ticket', number: 8 } });
    assert.equal(database.hasTicketEnd(commonDir, 'e1'), false);
    log('ticket_end', { run: 'r1', execution: 'e1', ticket: 7, owner: OWNER });

    assert.deepEqual(typesOf(database.readEvents(commonDir)), [
      'run_start',
      'ticket_start',
      'ticket_start',
      'ticket_end',
    ]);
    assert.deepEqual(typesOf(database.executionEvents(commonDir, 'e1')), ['ticket_start', 'ticket_end']);
    assert.deepEqual(typesOf(database.rowsNaming(commonDir, 'e1', () => {})), ['ticket_start', 'ticket_end']);
    assert.equal(database.hasTicketEnd(commonDir, 'e1'), true);
    assert.equal(database.hasTicketEnd(commonDir, 'e2'), false);
  });

  test(`${name}: an Event appended directly is read back whole`, (t) => {
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-database-');
    const database = databaseOf(t);
    const event: events.Event = {
      schemaVersion: events.EVENT_SCHEMA_VERSION,
      time: '2026-11-16T00:00:00.000Z',
      ...events.lifecycleEvent('ticket_start', { run: 'r1', execution: 'e1', ticket: 7, owner: OWNER }),
    };
    database.appendEvent(commonDir, event);
    assert.deepEqual(database.executionEvents(commonDir, 'e1'), [event]);
  });

  test(`${name}: load and loadAll read the records save wrote, and removeRecord deletes one`, (t) => {
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-database-');
    const database = databaseOf(t);
    database.save(ticketRecord(commonDir, 2));
    database.save(ticketRecord(commonDir, 1));
    assert.equal(database.load(commonDir, 'ticket', 2)?.branch, 'ticket/2');
    assert.deepEqual(
      database.loadAll(commonDir, 'ticket').map((executionRecord) => executionRecord.ticket),
      [1, 2],
    );
    assert.equal(database.removeRecord(commonDir, 'ticket', 2), true);
    assert.equal(database.removeRecord(commonDir, 'ticket', 2), false);
    assert.equal(database.load(commonDir, 'ticket', 2), null);
  });
}
