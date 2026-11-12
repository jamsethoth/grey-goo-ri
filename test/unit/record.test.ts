import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as recordRow from '../support/record-row.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');

// Reads and writes rows directly, as another SQLite client would.
function withDb<Result>(commonDir: string, query: (db: DatabaseSync) => Result) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function knownRecord(commonDir: string, ticket = 8) {
  return record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: `ticket/${ticket}`,
    base: 'main',
  });
}

function withoutCommonDir<Saved extends { commonDir: string }>(savedRecord: Saved) {
  const { commonDir, ...rest } = savedRecord;
  return rest;
}

test('a fresh Execution Record declares every field it can hold', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  assert.match(executionRecord.execution, /^8\.[0-9a-f]{6}$/);
  assert.notEqual(knownRecord(commonDir).execution, executionRecord.execution);
  assert.equal(executionRecord.commonDir, commonDir);
  const expected = {
    schemaVersion: 1,
    repository: 'o/r',
    execution: executionRecord.execution,
    ticket: 8,
    epic: 1,
    flow: 'default',
    configHash: 'abc123',
    run: 'run-1',
    state: 'active',
    terminalReason: null,
    terminalStop: null,
    admissionStop: null,
    cursor: { vertex: 'implement', visit: 1, action: null, recovery: 0, attempt: 1 },
    visits: new Map(),
    traversals: new Map(),
    retries: {},
    sessions: {},
    attempts: 0,
    outputs: [],
    testCommits: { first: null, baseline: null },
    history: [],
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/8',
    base: 'main',
    pr: null,
    approvalRequest: null,
    configurationSnapshot: null,
    visitState: null,
    activity: { busy: false, generation: 0 },
    heartbeat: null,
    writeAheadLog: [],
  };
  // deepEqual ignores key order, and the saved JSON keeps it, so the order is asserted too.
  assert.deepEqual(withoutCommonDir(executionRecord), expected);
  assert.deepEqual(Object.keys(withoutCommonDir(executionRecord)), Object.keys(expected));

  const { epic, ...withoutEpic } = expected;
  const noEpic = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 8,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/8',
    base: 'main',
  });
  assert.equal(epic, 1);
  assert.deepEqual(withoutCommonDir(noEpic), { ...withoutEpic, epic: null, execution: noEpic.execution });
});

// A record read outside its State Database still says which repository it belongs to and where its Flow came from: a
// user Flow's name carries its source (ADR 0022).
test("a created record carries its repository and its Flow's source, and keeps both through a save", async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'acme/app',
    ticket: 8,
    flow: { name: 'user:strict', entry: 'red' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/8',
    base: 'main',
  });
  assert.equal(executionRecord.repository, 'acme/app');
  assert.equal(executionRecord.flow, 'user:strict');
  record.save(executionRecord);
  const saved = record.load(commonDir, 'ticket', 8);
  assert.equal(saved?.repository, 'acme/app');
  assert.equal(saved?.flow, 'user:strict');
});

// Every Map and Set in a value, by path: plain objects and arrays are walked, so a Map field added later is found too.
function collectionsIn(value: unknown, path = ''): [string, Map<string, unknown> | Set<unknown>][] {
  if (value instanceof Map || value instanceof Set) return [[path, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => collectionsIn(item, path ? `${path}.${key}` : key));
}

// A Vertex or Check named like a property every object inherits must stay data through the row (#174, #330).
test('toJson and fromJson round-trip every Map of the record, keyed __proto__ and toString', () => {
  const commonDir = join(tmpdir(), 'gg-record-json');
  const executionRecord = knownRecord(commonDir);
  executionRecord.visitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  const maps = collectionsIn(executionRecord);
  assert.deepEqual(
    maps.map(([path]) => path),
    ['visits', 'traversals', 'visitState.runs', 'visitState.checks'],
  );
  const entries: Record<string, (key: string) => unknown> = {
    'visitState.runs': (key) => ({ output: `${key} output`, reason: null, failure: null, recoverable: false }),
    'visitState.checks': (key) => ({ id: key, kind: 'command', state: 'passed', tree: null }),
  };
  for (const [path, map] of maps)
    for (const key of ['__proto__', 'toString']) (map as Map<string, unknown>).set(key, entries[path]?.(key) ?? 1);

  const json = record.toJson(executionRecord);
  assert.deepEqual(collectionsIn(json), [], 'the JSON holds no Map or Set');
  assert.equal(Object.hasOwn(json, 'commonDir'), false, 'the row leaves out commonDir');
  assert.deepEqual(
    json.visits,
    Object.fromEntries([
      ['__proto__', 1],
      ['toString', 1],
    ]),
  );
  const revived = record.fromJson(JSON.parse(JSON.stringify(json)) as typeof json, commonDir);
  // deepEqual compares a Map's entries, so each revived Map holds both keys as entries, not properties.
  assert.deepEqual(revived, executionRecord);
});

test('saving a record never adds a field createExecutionRecord did not declare', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  Object.assign(executionRecord, { admission: { kind: 'hold' } });
  assert.throws(
    () => record.save(executionRecord),
    (err: Error) => {
      assert.ok(err instanceof record.RecordSaveError, String(err.stack));
      assert.match(err.message, /\badmission\b/);
      return true;
    },
  );
  assert.equal(record.load(commonDir, 'ticket', 8), null, 'nothing is saved');

  const epicRecord = record.createEpicRecord({ commonDir, epic: 1 });
  Object.assign(epicRecord, { approval: null });
  assert.throws(() => record.save(epicRecord), /\bapproval\b/);
  assert.equal(record.load(commonDir, 'epic', 1), null, 'nothing is saved');
});

test('saving a record never drops a field createExecutionRecord declared', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  delete (executionRecord as Partial<record.ExecutionRecord>).admissionStop;
  assert.throws(() => record.save(executionRecord), /\badmissionStop\b/);
  assert.equal(record.load(commonDir, 'ticket', 8), null, 'nothing is saved');
});

test('decidedBy is exactly one of a hold, a human or an Action, and any of its keys reads without a test', () => {
  const forms: record.DecidedBy[] = [
    { hold: 'dirty-worktree' },
    { hold: null },
    { human: 'gg:needs-human' },
    { vertex: 'red', visit: 1, action: 'agent', recovery: 0 },
    { vertex: 'red', visit: null, action: null, recovery: 0 },
  ];
  assert.deepEqual(
    forms.map((decidedBy) => decidedBy.hold ?? decidedBy.human ?? decidedBy.vertex),
    ['dirty-worktree', undefined, 'gg:needs-human', 'red', 'red'],
  );
  // @ts-expect-error two deciders at once
  const mixed: record.DecidedBy = { hold: 'dirty-worktree', human: 'gg:needs-human' };
  // @ts-expect-error no decider
  const none: record.DecidedBy = {};
  // @ts-expect-error half an Action's identity
  const partial: record.DecidedBy = { vertex: 'red' };
  assert.equal([mixed, none, partial].length, 3);
});

test('a fresh Epic Record declares every field it can hold', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const epicRecord = record.createEpicRecord({ commonDir, epic: 1 });
  const expected = { schemaVersion: 1, epic: 1, planDecision: null, approvalRequest: null };
  assert.deepEqual(withoutCommonDir(epicRecord), expected);
  assert.deepEqual(Object.keys(withoutCommonDir(epicRecord)), Object.keys(expected));
});

test('a write-ahead entry carries every field, null where its step has none', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  record.intent(executionRecord, 'm1', 'commit', { message: 'red', tree: 't1', parent: 'p1' });
  record.evidence(executionRecord, 'm1', { sha: 's1' });
  record.complete(executionRecord, 'm1');
  const entries = executionRecord.writeAheadLog;
  assert.ok(Array.isArray(entries), 'the record has a writeAheadLog');
  assert.deepEqual(
    entries.map(({ time, ...entry }) => entry),
    [
      {
        step: 'intent',
        actionMarker: 'm1',
        effect: 'commit',
        payload: { message: 'red', tree: 't1', parent: 'p1' },
        evidence: null,
      },
      { step: 'evidence', actionMarker: 'm1', effect: 'commit', payload: null, evidence: { sha: 's1' } },
      { step: 'complete', actionMarker: 'm1', effect: 'commit', payload: null, evidence: null },
    ],
  );
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry), ['step', 'actionMarker', 'effect', 'payload', 'evidence', 'time']);
    assert.ok(!Number.isNaN(Date.parse(entry.time)), entry.time);
  }
});

test('save writes a records row and never a records directory', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  record.save(executionRecord);
  record.save(epic);
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'no gg/records directory');
  withDb(commonDir, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ['check_results', 'configs', 'events', 'records']);
    const rows = db
      .prepare('SELECT kind, n, json FROM records ORDER BY kind')
      .all()
      .map((row) => ({ ...row }));
    /* eslint-disable id-length -- n is the records table's column */
    assert.deepEqual(rows, [
      { kind: 'epic', n: 1, json: recordRow.json(withoutCommonDir(epic)) },
      { kind: 'ticket', n: 8, json: recordRow.json(record.toJson(executionRecord)) },
    ]);
    /* eslint-enable id-length */
  });
  assert.equal(stateDatabase.SCHEMA_VERSION, 1);
});

test('load returns null for a missing row and the record for a saved one', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  record.save(executionRecord);
  assert.equal(record.load(commonDir, 'ticket', 9), null);
  assert.equal(record.load(commonDir, 'epic', 8), null);
  // Changed behind the module's back, so the load must come from the row.
  withDb(commonDir, (db) => {
    db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = 8").run(
      recordRow.json({ ...record.toJson(executionRecord), state: 'ready-for-qa' }),
    );
  });
  const loaded = record.load(commonDir, 'ticket', 8);
  assert.equal(loaded?.commonDir, commonDir);
  assert.deepEqual(loaded, { ...executionRecord, state: 'ready-for-qa' });

  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  record.save(epic);
  assert.deepEqual(record.load(commonDir, 'epic', 1), epic);
});

// An empty Map and {} write the same JSON, so only a record with entries shows a row built without its Maps (#327).
test('a record with visits entries survives the golden-row comparison and a raw-row write', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  executionRecord.visits.set('green', 2);
  executionRecord.traversals.set('green->review:pass', 1);
  record.save(executionRecord);
  withDb(commonDir, (db) => {
    const row = db.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = 8").get();
    assert.equal(row?.json, recordRow.json(record.toJson(executionRecord)));
    db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = 8").run(
      recordRow.json({ ...record.toJson(executionRecord), state: 'ready-for-qa' }),
    );
  });
  assert.deepEqual(record.load(commonDir, 'ticket', 8), { ...executionRecord, state: 'ready-for-qa' });
});

test('the write-ahead log records intent, evidence and completion per marker', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  record.intent(executionRecord, 'm1', 'commit', { message: 'red', tree: 't1', parent: 'p1' });
  record.evidence(executionRecord, 'm1', { sha: 'deadbeef' });
  record.complete(executionRecord, 'm1');
  assert.deepEqual(
    executionRecord.writeAheadLog.map(({ time, ...entry }) => entry),
    [
      {
        step: 'intent',
        actionMarker: 'm1',
        effect: 'commit',
        payload: { message: 'red', tree: 't1', parent: 'p1' },
        evidence: null,
      },
      { step: 'evidence', actionMarker: 'm1', effect: 'commit', payload: null, evidence: { sha: 'deadbeef' } },
      { step: 'complete', actionMarker: 'm1', effect: 'commit', payload: null, evidence: null },
    ],
  );
  assert.deepEqual(
    executionRecord.writeAheadLog.map((entry) => typeof entry.time),
    ['string', 'string', 'string'],
  );
  const loaded = record.load(commonDir, 'ticket', 8);
  assert.deepEqual(loaded?.writeAheadLog, executionRecord.writeAheadLog, 'each step saves');
});

test('a record transition and its event commit together', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  // Every Event insert fails while `appends.failing` is set, as a disk error would.
  const appends = { failing: true };
  const database = record.createStateDatabase({
    beforeAppend: () => {
      if (appends.failing) throw new Error('disk I/O error');
    },
  });
  const eventLog = events.eventLog(commonDir, { run: 'run-1', ticket: 8 }, database);
  const executionRecord = knownRecord(commonDir);
  const eventTypes = () => eventRead.readEvents(commonDir).map((event) => event.type);
  const start = () => eventLog('ticket_start', { execution: executionRecord.execution });

  assert.throws(
    () => record.save(executionRecord, start),
    (err: Error) => err.name === 'RecordSaveError',
    'a failed Event fails the save',
  );
  assert.equal(record.load(commonDir, 'ticket', 8), null, 'no record is created without its Event');
  appends.failing = false;
  record.save(executionRecord, start);
  assert.equal(record.load(commonDir, 'ticket', 8)?.state, 'active');
  assert.deepEqual(eventTypes(), ['ticket_start']);

  appends.failing = true;
  executionRecord.state = 'held';
  assert.throws(
    () => record.save(executionRecord, () => eventLog('ticket_end', { execution: executionRecord.execution })),
    (err: Error) => err.name === 'RecordSaveError',
  );
  assert.equal(record.load(commonDir, 'ticket', 8)?.state, 'active', 'the previous row stays');
  assert.deepEqual(eventTypes(), ['ticket_start'], 'and no Event lands');
  appends.failing = false;
  record.save(executionRecord, () => eventLog('ticket_end', { execution: executionRecord.execution }));
  assert.equal(record.load(commonDir, 'ticket', 8)?.state, 'held');
  assert.deepEqual(eventTypes(), ['ticket_start', 'ticket_end']);
  executionRecord.state = 'ready-for-qa';
  record.save(executionRecord);
  assert.equal(record.load(commonDir, 'ticket', 8)?.state, 'ready-for-qa', 'a plain save still works after a rollback');
});

test('openIntents lists intents without completion oldest first', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const executionRecord = knownRecord(commonDir);
  record.intent(executionRecord, 'm1', 'commit', { message: 'red', tree: 't1', parent: 'p1' });
  assert.deepEqual(
    writeAhead.openIntents(executionRecord).map((entry) => entry.actionMarker ?? entry),
    ['m1'],
  );
  record.intent(executionRecord, 'm2', 'push', { branch: 'ticket/8', sha: 'abc' });
  record.intent(executionRecord, 'm3', 'comment', { branch: 'ticket/8', sha: 'abc' });
  record.evidence(executionRecord, 'm2', { ok: true });
  record.complete(executionRecord, 'm2');
  assert.deepEqual(
    writeAhead.openIntents(executionRecord).map((entry) => entry.actionMarker ?? entry),
    ['m1', 'm3'],
  );
  record.complete(executionRecord, 'm1');
  record.complete(executionRecord, 'm3');
  assert.deepEqual(writeAhead.openIntents(executionRecord), []);
});

test('loadAll lists every ticket record', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  assert.deepEqual(record.loadAll(commonDir, 'ticket'), []);
  record.save(knownRecord(commonDir, 8));
  record.save(knownRecord(commonDir, 12));
  record.save(record.createEpicRecord({ commonDir, epic: 1 }));
  const all = record.loadAll(commonDir, 'ticket');
  assert.deepEqual(
    all.map((executionRecord) => executionRecord.ticket).sort((left, right) => left - right),
    [8, 12],
  );
});

test('loadAll reports a corrupt row and an unknown schemaVersion and returns the rest', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  record.save(knownRecord(commonDir, 8));
  const unknown = JSON.stringify({ schemaVersion: 99, ticket: 10 });
  withDb(commonDir, (db) => {
    const insert = db.prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?)');
    insert.run('ticket', 9, '{');
    insert.run('ticket', 10, unknown);
  });
  const isCorrupt = (name: string) => (err: record.RecordCorruptError) => {
    assert.ok(err instanceof record.RecordCorruptError);
    assert.ok(err.file.includes(dbPath(commonDir)), `${err.file} names the database`);
    assert.ok(err.file.includes(name), `${err.file} names ${name}`);
    assert.ok(err.message.includes(err.file));
    return true;
  };
  assert.throws(() => record.load(commonDir, 'ticket', 9), isCorrupt('ticket-9'));
  assert.throws(() => record.load(commonDir, 'ticket', 10), isCorrupt('ticket-10'));

  const corrupt: record.RecordCorruptError[] = [];
  const records = record.loadAll(commonDir, 'ticket', { onCorrupt: (err) => corrupt.push(err) });
  assert.deepEqual(
    records.map((executionRecord) => executionRecord.ticket),
    [8],
  );
  assert.equal(corrupt.length, 2);
  const byName = corrupt.sort((left, right) => left.file.localeCompare(right.file));
  isCorrupt('ticket-10')(byName[0]);
  isCorrupt('ticket-9')(byName[1]);

  withDb(commonDir, (db) => {
    const json = (recordNumber: number) =>
      db.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(recordNumber)?.json;
    assert.equal(json(9), '{', 'the corrupt row is left untouched');
    assert.equal(json(10), unknown);
  });
});

// The counts a record keeps as Maps are read back from objects (#174): a row holding anything else is corrupt, and one
// such row leaves every other row readable.
test('a record whose visits, traversals or Check runs are not objects is corrupt; the rest load', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  record.save(knownRecord(commonDir, 8));
  const saved = JSON.parse(
    withDb(commonDir, (db) => db.prepare('SELECT json FROM records WHERE n = 8').get()!.json as string),
  ) as object;
  const broken: [number, Record<string, unknown>][] = [
    [20, { visits: null }],
    [21, { traversals: undefined }],
    [22, { visitState: { runs: {} } }],
  ];
  withDb(commonDir, (db) => {
    for (const [ticket, change] of broken)
      db.prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?)').run(
        'ticket',
        ticket,
        JSON.stringify({ ...saved, ticket, ...change }),
      );
  });
  for (const [ticket] of broken)
    assert.throws(
      () => record.load(commonDir, 'ticket', ticket),
      (err) => err instanceof record.RecordCorruptError,
    );
  const corrupt: record.RecordCorruptError[] = [];
  const records = record.loadAll(commonDir, 'ticket', { onCorrupt: (err) => corrupt.push(err) });
  assert.deepEqual(
    records.map((executionRecord) => executionRecord.ticket),
    [8],
  );
  assert.equal(corrupt.length, broken.length);
});

test('a record written before Action ids is corrupt, not misread', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  // Its cursor names a phase and ordinal, which a resume would read as an Action id and a Recovery Number.
  record.save(knownRecord(commonDir, 8));
  const old = {
    ...record.toJson(knownRecord(commonDir, 11)),
    cursor: { vertex: 'green', visit: 1, phase: 'green', ordinal: 3, attempt: 1 },
  };
  withDb(commonDir, (db) =>
    db.prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?)').run('ticket', 11, JSON.stringify(old)),
  );
  assert.throws(
    () => record.load(commonDir, 'ticket', 11),
    (err: Error) => err instanceof record.RecordCorruptError && /Recovery Number/.test(err.message),
  );
});

// SQLite's busy handler is not fair, so on a loaded Windows runner another process's burst of writes held a save off
// past the old 5 s busy_timeout and it failed with `database is locked` (grey-goo-ri issue #136).
test('the State Database waits up to 60 s for another writer', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  assert.deepEqual({ ...stateDatabase.open(commonDir).prepare('PRAGMA busy_timeout').get() }, { timeout: 60_000 });
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('savePinnedConfiguration stores a pinned configuration once per hash and loadPinnedConfiguration reads it back', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const pinned = { flow: { name: 'default' }, personas: { implementer: '# implementer\n' } };
  await stateDatabase.savePinnedConfiguration(commonDir, 'hash-1', pinned);
  const firstSeen = () =>
    withDb(commonDir, (db) => db.prepare("SELECT firstSeen FROM configs WHERE hash = 'hash-1'").get()?.firstSeen);
  const first = firstSeen();
  assert.ok(
    typeof first === 'string' && !Number.isNaN(Date.parse(first)) && new Date(first).toISOString() === first,
    `${first} is an ISO time`,
  );
  // An older firstSeen than any save could write, so a second save that replaced it would show.
  const older = '2020-01-01T00:00:00.000Z';
  withDb(commonDir, (db) => db.prepare("UPDATE configs SET firstSeen = ? WHERE hash = 'hash-1'").run(older));
  await stateDatabase.savePinnedConfiguration(commonDir, 'hash-1', pinned);
  assert.equal(firstSeen(), older, 'the second save keeps the first firstSeen');
  withDb(commonDir, (db) => assert.equal(db.prepare('SELECT count(*) AS n FROM configs').get()?.n, 1));
  assert.deepEqual(await stateDatabase.loadPinnedConfiguration(commonDir, 'hash-1'), pinned);
  assert.equal(await stateDatabase.loadPinnedConfiguration(commonDir, 'hash-2'), null);
});

test('an unknown database version is refused by name', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  mkdirSync(join(commonDir, 'gg'));
  const db = new DatabaseSync(dbPath(commonDir));
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(
    () => stateDatabase.open(commonDir),
    (err: Error) => {
      assert.ok(!(err instanceof TypeError), `not a missing function: ${err.message}`);
      assert.ok(err.message.includes(dbPath(commonDir)), `${err.message} names the database`);
      assert.match(err.message, /\b2\b/);
      assert.match(err.message, /\b1\b/);
      return true;
    },
  );
});

// Another gg process writing events must not starve a new connection: on a loaded Windows runner two appenders saw
// `database is locked` from stateDatabase.open's write transaction once its busy_timeout ran out.
test('opening an existing State Database does not wait for a writer', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  stateDatabase.open(commonDir);
  await stateDatabase.close(commonDir);
  const writer = new DatabaseSync(dbPath(commonDir));
  writer.exec('BEGIN IMMEDIATE');
  try {
    // The writer holds its lock until this case ends, so an open that waited for it would fail with SQLITE_BUSY.
    const db = stateDatabase.open(commonDir);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM records').get()?.n,
      0,
      'reads still work while the writer holds its lock',
    );
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});

test('stateDatabase.open shares one connection between spellings of the same directory', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
  const db = stateDatabase.open(commonDir);
  // String concatenation, not join: join would normalise the segments before open sees them.
  assert.equal(stateDatabase.open(`${commonDir}/./gg/../`), db, 'a relative-segment spelling hits the cache');
  // sep: backslashes on Windows; on POSIX a backslash is a filename character, not another spelling.
  await stateDatabase.close(`${commonDir}${sep}gg${sep}..`);
  assert.throws(() => db.prepare('SELECT 1'), /not open/, 'closing by another spelling closed the shared connection');
});

test('close releases the database so the directory can be removed', async (t) => {
  const commonDir = await mkdtemp(join(tmpdir(), 'gg-record-'));
  t.after(() => rm(commonDir, { recursive: true, force: true }));
  stateDatabase.create(commonDir);
  record.save(knownRecord(commonDir));
  await stateDatabase.savePinnedConfiguration(commonDir, 'hash-1', {});
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  await stateDatabase.close(commonDir);
  rmSync(commonDir, { recursive: true });
  assert.ok(!existsSync(commonDir));
  // Once gg init has made the database again, a later call opens a fresh connection rather than reusing the closed one.
  stateDatabase.create(commonDir);
  record.save(knownRecord(commonDir));
  assert.equal(record.load(commonDir, 'ticket', 8)?.ticket, 8);
  await stateDatabase.close(commonDir);
});
