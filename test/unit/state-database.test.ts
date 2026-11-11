import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');

// Reads gg.db directly, as another SQLite client would.
function withDb<Result>(commonDir: string, query: (db: DatabaseSync) => Result) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return query(db);
  } finally {
    db.close();
  }
}

const knownRecord = (commonDir: string) =>
  record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 8,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/8',
    base: 'main',
  });

const MARKER = 'gg:8.run-1:implement:1:commit:1';

// A record whose write-ahead log holds an open intent, so evidence and complete reach their save.
function withIntent(commonDir: string) {
  const executionRecord = knownRecord(commonDir);
  executionRecord.writeAheadLog.push(
    writeAhead.entryOf('intent', MARKER, 'commit', { payload: { message: 'red', tree: 't1', parent: 'p1' } }),
  );
  return executionRecord;
}

test('create makes a State Database in WAL mode at the version this gg reads, which open then reads', (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-state-');
  assert.equal(stateDatabase.create(commonDir), true, 'create says it created one');
  assert.ok(existsSync(dbPath(commonDir)), 'create made gg.db');
  assert.deepEqual(readdirSync(join(commonDir, 'gg')), ['gg.db'], 'no temp file is left beside it');
  assert.deepEqual(
    withDb(commonDir, (db) => ({
      mode: db.prepare('PRAGMA journal_mode').get()?.journal_mode,
      version: db.prepare('PRAGMA user_version').get()?.user_version,
    })),
    { mode: 'wal', version: stateDatabase.SCHEMA_VERSION },
  );
  assert.deepEqual(record.loadAll(commonDir, 'ticket'), []);
});

test('create keeps an existing State Database and the records it holds', (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-state-');
  stateDatabase.create(commonDir);
  record.save(knownRecord(commonDir));
  stateDatabase.close(commonDir);
  assert.equal(stateDatabase.create(commonDir), false, 'create says it kept the existing one');
  assert.equal(record.load(commonDir, 'ticket', 8)?.ticket, 8, 'the saved record is still there');
});

test('open refuses a missing State Database by name, telling the person to run gg init, and creates nothing', (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-state-');
  assert.throws(() => stateDatabase.open(commonDir), {
    message: `no State Database at ${dbPath(commonDir)}: run gg init`,
  });
  assert.equal(existsSync(join(commonDir, 'gg')), false, 'no gg directory');
});

// Each export of the modules that reach the State Database, called on a common dir without one: an entry point's call,
// or null for an export that never opens it. create is the one that makes it.
const ENTRY_POINTS: Record<string, Record<string, ((commonDir: string) => unknown) | null>> = {
  stateDatabase: {
    filePath: null,
    missingMessage: null,
    create: null,
    open: (commonDir) => stateDatabase.open(commonDir),
    close: null,
    savePinnedConfiguration: (commonDir) => stateDatabase.savePinnedConfiguration(commonDir, 'hash-1', '{}'),
    loadPinnedConfiguration: (commonDir) => stateDatabase.loadPinnedConfiguration(commonDir, 'hash-1'),
    saveCheckResult: (commonDir) =>
      stateDatabase.saveCheckResult(commonDir, {
        tree: 't',
        command: 'npm test',
        state: 'passed',
        marker: MARKER,
        output: '',
      }),
    reusablePass: (commonDir) => stateDatabase.reusablePass(commonDir, 't', 'npm test'),
  },
  record: {
    terminalCursor: null,
    createExecutionRecord: null,
    createEpicRecord: null,
    createStateDatabase: null,
    toJson: null,
    fromJson: null,
    beforeAppend: null,
    load: (commonDir) => record.load(commonDir, 'ticket', 8),
    removeRecord: (commonDir) => record.removeRecord(commonDir, 'ticket', 8),
    loadAll: (commonDir) => record.loadAll(commonDir, 'ticket'),
    save: (commonDir) => record.save(knownRecord(commonDir)),
    intent: (commonDir) =>
      record.intent(knownRecord(commonDir), MARKER, 'commit', { message: 'red', tree: 't1', parent: 'p1' }),
    evidence: (commonDir) => record.evidence(withIntent(commonDir), MARKER, { sha: 'abc' }),
    complete: (commonDir) => record.complete(withIntent(commonDir), MARKER),
  },
  events: {
    actionEvent: null,
    lifecycleEvent: null,
    diffStats: null,
    eventLog: (commonDir) => events.eventLog(commonDir)('run_start', { run: 'r1' }),
    readEvents: (commonDir) => events.readEvents(commonDir),
    executionEvents: (commonDir) => events.executionEvents(commonDir, '8.run-1'),
    hasTicketEnd: (commonDir) => events.hasTicketEnd(commonDir, '8.run-1'),
  },
};
const MODULES: Record<string, object> = { stateDatabase, record, events };

// A thrown class is no entry point; every other function export is one or says it is not.
const isClass = (value: unknown) => /^class\b/.test(Function.prototype.toString.call(value));
const functionExports = (module: object) =>
  Object.entries(module)
    .filter(([, value]) => typeof value === 'function' && !isClass(value))
    .map(([name]) => name)
    .sort();

test('the entry point table names every function each State Database module exports, so a new one is classed', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(MODULES).map(([name, module]) => [name, functionExports(module)])),
    Object.fromEntries(Object.entries(ENTRY_POINTS).map(([name, calls]) => [name, Object.keys(calls).sort()])),
  );
});

for (const [moduleName, calls] of Object.entries(ENTRY_POINTS)) {
  for (const [name, call] of Object.entries(calls)) {
    if (call === null) continue;
    test(`${moduleName}.${name} refuses a missing State Database and creates nothing`, (t) => {
      const commonDir = tempDirectory.tempDirectory(t, 'gg-state-');
      assert.throws(() => call(commonDir), { message: `no State Database at ${dbPath(commonDir)}: run gg init` });
      assert.equal(existsSync(join(commonDir, 'gg')), false, 'no gg directory');
    });
  }
}

// A lost gg.db must not come back empty (#150): with gg/ still there, SQLite would create the file but for mode=rw.
test('open refuses a gg.db deleted from an existing gg directory, and creates no empty one in its place', (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-state-');
  stateDatabase.create(commonDir);
  rmSync(dbPath(commonDir));
  assert.throws(() => stateDatabase.open(commonDir), {
    message: `no State Database at ${dbPath(commonDir)}: run gg init`,
  });
  assert.equal(existsSync(dbPath(commonDir)), false, 'no gg.db is created');
});
