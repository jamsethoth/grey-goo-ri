import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
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
    createStateDatabase: null,
    load: (commonDir) => stateDatabase.load(commonDir, 'ticket', 8),
    removeRecord: (commonDir) => stateDatabase.removeRecord(commonDir, 'ticket', 8),
    loadAll: (commonDir) => stateDatabase.loadAll(commonDir, 'ticket'),
    save: (commonDir) => stateDatabase.save(knownRecord(commonDir)),
    intent: (commonDir) =>
      stateDatabase.intent(knownRecord(commonDir), MARKER, 'commit', { message: 'red', tree: 't1', parent: 'p1' }),
    evidence: (commonDir) => stateDatabase.evidence(withIntent(commonDir), MARKER, { sha: 'abc' }),
    complete: (commonDir) => stateDatabase.complete(withIntent(commonDir), MARKER),
    appendEvent: (commonDir) =>
      stateDatabase.appendEvent(commonDir, {
        schemaVersion: events.EVENT_SCHEMA_VERSION,
        time: 't',
        ...events.lifecycleEvent('run_start', { run: 'r1' }),
      }),
    readEvents: (commonDir) => stateDatabase.readEvents(commonDir),
    executionEvents: (commonDir) => stateDatabase.executionEvents(commonDir, '8.run-1'),
    hasTicketEnd: (commonDir) => stateDatabase.hasTicketEnd(commonDir, '8.run-1'),
    rowsNaming: (commonDir) => stateDatabase.rowsNaming(commonDir, '8.run-1', () => {}),
  },
  record: {
    terminalCursor: null,
    createExecutionRecord: null,
    createEpicRecord: null,
    toJson: null,
    fromJson: null,
    rowOf: null,
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
  },
  eventRead: {
    checkedRows: null,
    ofExecution: null,
    readEvents: (commonDir) => eventRead.readEvents(commonDir),
    executionEvents: (commonDir) => eventRead.executionEvents(commonDir, '8.run-1'),
    hasTicketEnd: (commonDir) => eventRead.hasTicketEnd(commonDir, '8.run-1'),
    rowsNaming: (commonDir) => eventRead.rowsNaming(commonDir, '8.run-1', () => {}),
  },
};
const MODULES: Record<string, object> = { stateDatabase, record, events, eventRead };

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

// Every lib module, by its path from the repository root.
const LIB_ROOT = new URL('../../', import.meta.url);
const libModules = (): string[] =>
  readdirSync(new URL('lib/', LIB_ROOT), { recursive: true, encoding: 'utf8' })
    .map((path) => `lib/${path.replaceAll('\\', '/')}`)
    .filter((path) => path.endsWith('.ts'))
    .sort();
const sourceOf = (path: string) => readFileSync(new URL(path, LIB_ROOT), 'utf8');

// A statement run on a SQLite connection: prepare, or exec given SQL text, never RegExp's exec over a value.
const SQL_CALL = /\.prepare\(|\.exec\(\s*[`'"A-Z]/;
const sqlSites = (path: string, text: string) =>
  text.split('\n').flatMap((line, index) => (SQL_CALL.test(line) ? [`${path}:${index + 1}`] : []));

test("the State Database's SQL lives under lib/state-database/, the locks apart (#367)", () => {
  // The census finds each form of statement, and passes over RegExp's exec.
  assert.deepEqual(
    sqlSites('sample.ts', "db.prepare('SELECT 1')\nconnection.exec('BEGIN')\nbuilding.exec(SCHEMA)\n/x/.exec(text)"),
    ['sample.ts:1', 'sample.ts:2', 'sample.ts:3'],
  );
  const sites = libModules().flatMap((path) => sqlSites(path, sourceOf(path)));
  assert.deepEqual(
    sites.filter((site) => !site.startsWith('lib/state-database/') && !site.startsWith('lib/locks.ts:')),
    [],
  );
  assert.ok(
    sites.some((site) => site.startsWith('lib/state-database/')),
    'the census reaches the SQL itself',
  );
});

// The modules whose exports reach the State Database by a repository's commonDir: the real instance's reads and
// writes, and the connection.
const REAL_INSTANCE = /^import \* as (\w+) from '(?:\.\.?\/)+(?:state-database(?:\/index)?|record|event-read)\.ts';$/gm;
const BY_COMMON_DIR = ['open', ...Object.keys(stateDatabase.createStateDatabase())];
const directCalls = (text: string): string[] =>
  [...text.matchAll(REAL_INSTANCE)]
    .flatMap(([, alias]) =>
      [...text.matchAll(new RegExp(`\\b${alias}\\s*\\.(${BY_COMMON_DIR.join('|')})\\(`, 'g'))].map(
        ([, method]) => `${alias}.${method}`,
      ),
    )
    .sort();
// Only the commands that take no dependency read or write it by commonDir: gg doctor and gg init (lib/doctor.ts) and gg
// work abandon (lib/work.ts), the owner's decision 2.
const TAKES_NO_DEPENDENCY: Record<string, string[]> = {
  'lib/doctor.ts': ['stateDatabase.open'],
  'lib/work.ts': ['stateDatabase.load', 'stateDatabase.open', 'stateDatabase.removeRecord'],
};

test("no lib module on a Run's path reaches the State Database by commonDir: each goes through database (#367)", () => {
  // The census sees a call on any name the module gives the real instance.
  assert.deepEqual(
    directCalls(
      "import * as records from './record.ts';\nrecords.load(commonDir, 'ticket', 1);\n" +
        'records\n  .loadAll(commonDir);\n' +
        'records.toJson(x);\n',
    ),
    ['records.load', 'records.loadAll'],
  );
  const found = Object.fromEntries(
    libModules()
      .filter((path) => !path.startsWith('lib/state-database/'))
      .map((path) => [path, directCalls(sourceOf(path))] as const)
      .filter(([, calls]) => calls.length > 0),
  );
  assert.deepEqual(found, TAKES_NO_DEPENDENCY);
});
