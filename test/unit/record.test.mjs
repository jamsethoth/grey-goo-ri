import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as sqlite from '../../lib/sqlite.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const dbPath = (commonDir) => join(commonDir, 'gg', 'gg.db');

// Reads and writes rows directly, as another SQLite client would.
function withDb(commonDir, fn) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function newExecution(commonDir, ticket = 8) {
  return record.createExecution({
    commonDir,
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

function withoutCommonDir(r) {
  const { commonDir, ...rest } = r;
  return rest;
}

test('a fresh Execution Record declares every field it can hold', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const executionRecord = newExecution(commonDir);
  assert.match(executionRecord.execution, /^8\.[0-9a-f]{6}$/);
  assert.notEqual(newExecution(commonDir).execution, executionRecord.execution);
  assert.equal(executionRecord.commonDir, commonDir);
  const expected = {
    schemaVersion: 1,
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
    visits: {},
    traversals: {},
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
  const noEpic = record.createExecution({
    commonDir,
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

test('saving a record never adds a field createExecution did not declare', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const executionRecord = newExecution(commonDir);
  executionRecord.admission = { kind: 'hold' };
  await assert.rejects(record.save(executionRecord), (err) => {
    assert.ok(err instanceof record.RecordSaveError, err.stack);
    assert.match(err.message, /\badmission\b/);
    return true;
  });
  assert.equal(await record.load(commonDir, 'ticket', 8), null, 'nothing is saved');

  const epicRecord = record.createEpicRecord({ commonDir, epic: 1 });
  epicRecord.approval = null;
  await assert.rejects(record.save(epicRecord), /\bapproval\b/);
  assert.equal(await record.load(commonDir, 'epic', 1), null, 'nothing is saved');
});

test('saving a record never drops a field createExecution declared', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const executionRecord = newExecution(commonDir);
  delete executionRecord.admissionStop;
  await assert.rejects(record.save(executionRecord), /\badmissionStop\b/);
  assert.equal(await record.load(commonDir, 'ticket', 8), null, 'nothing is saved');
});

test('a fresh Epic Record declares every field it can hold', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const epicRecord = record.createEpicRecord({ commonDir, epic: 1 });
  const expected = { schemaVersion: 1, epic: 1, planDecision: null, approvalRequest: null };
  assert.deepEqual(withoutCommonDir(epicRecord), expected);
  assert.deepEqual(Object.keys(withoutCommonDir(epicRecord)), Object.keys(expected));
});

test('a write-ahead entry carries every field, null where its step has none', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const executionRecord = newExecution(commonDir);
  await record.intent(executionRecord, 'm1', 'commit', { tree: 't1' });
  await record.evidence(executionRecord, 'm1', { sha: 's1' });
  await record.complete(executionRecord, 'm1');
  const entries = executionRecord.writeAheadLog;
  assert.ok(Array.isArray(entries), 'the record has a writeAheadLog');
  assert.deepEqual(
    entries.map(({ time, ...entry }) => entry),
    [
      { step: 'intent', actionMarker: 'm1', effect: 'commit', payload: { tree: 't1' }, evidence: null },
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const r = newExecution(commonDir);
  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  await record.save(r);
  await record.save(epic);
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'no gg/records directory');
  withDb(commonDir, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ['check_results', 'configs', 'events', 'records']);
    const rows = db
      .prepare('SELECT kind, n, json FROM records ORDER BY kind')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { kind: 'epic', n: 1, json: JSON.stringify(withoutCommonDir(epic), null, 2) + '\n' },
      { kind: 'ticket', n: 8, json: JSON.stringify(withoutCommonDir(r), null, 2) + '\n' },
    ]);
  });
  assert.equal(sqlite.DB_SCHEMA_VERSION, 1);
});

test('load returns null for a missing row and the record for a saved one', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const r = newExecution(commonDir);
  await record.save(r);
  assert.equal(await record.load(commonDir, 'ticket', 9), null);
  assert.equal(await record.load(commonDir, 'epic', 8), null);
  // Changed behind the module's back, so the load must come from the row.
  withDb(commonDir, (db) => {
    db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = 8").run(
      JSON.stringify({ ...withoutCommonDir(r), state: 'ready-for-qa' }),
    );
  });
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.equal(loaded.commonDir, commonDir);
  assert.deepEqual(loaded, { ...r, state: 'ready-for-qa' });

  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  await record.save(epic);
  assert.deepEqual(await record.load(commonDir, 'epic', 1), epic);
});

test('the write-ahead log records intent, evidence and completion per marker', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', { message: 'red' });
  await record.evidence(r, 'm1', { sha: 'deadbeef' });
  await record.complete(r, 'm1');
  assert.deepEqual(
    r.writeAheadLog.map(({ time, ...e }) => e),
    [
      { step: 'intent', actionMarker: 'm1', effect: 'commit', payload: { message: 'red' }, evidence: null },
      { step: 'evidence', actionMarker: 'm1', effect: 'commit', payload: null, evidence: { sha: 'deadbeef' } },
      { step: 'complete', actionMarker: 'm1', effect: 'commit', payload: null, evidence: null },
    ],
  );
  assert.deepEqual(
    r.writeAheadLog.map((e) => typeof e.time),
    ['string', 'string', 'string'],
  );
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.deepEqual(loaded.writeAheadLog, r.writeAheadLog, 'each step saves');
});

test('a record transition and its event commit together', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  // Every Event insert fails while `appends.failing` is set, as a disk error would.
  const appends = { failing: true };
  const database = record.createStateDatabase({
    beforeAppend: () => {
      if (appends.failing) throw new Error('disk I/O error');
    },
  });
  const ev = events.eventLog(commonDir, { run: 'run-1', ticket: 8 }, database);
  const r = newExecution(commonDir);
  const eventTypes = () => events.readEvents(commonDir).map((e) => e.type);
  const start = () => ev('ticket_start', { execution: r.execution });

  await assert.rejects(record.save(r, start), (err) => err.name === 'RecordSaveError', 'a failed Event fails the save');
  assert.equal(await record.load(commonDir, 'ticket', 8), null, 'no record is created without its Event');
  appends.failing = false;
  await record.save(r, start);
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'active');
  assert.deepEqual(eventTypes(), ['ticket_start']);

  appends.failing = true;
  r.state = 'held';
  await assert.rejects(
    record.save(r, () => ev('ticket_end', { execution: r.execution })),
    (err) => err.name === 'RecordSaveError',
  );
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'active', 'the previous row stays');
  assert.deepEqual(eventTypes(), ['ticket_start'], 'and no Event lands');
  appends.failing = false;
  await record.save(r, () => ev('ticket_end', { execution: r.execution }));
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'held');
  assert.deepEqual(eventTypes(), ['ticket_start', 'ticket_end']);
  r.state = 'ready-for-qa';
  await record.save(r);
  assert.equal(
    (await record.load(commonDir, 'ticket', 8)).state,
    'ready-for-qa',
    'a plain save still works after a rollback',
  );
});

test('openIntents lists intents without completion oldest first', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', {});
  assert.deepEqual(
    writeAhead.openIntents(r).map((e) => e.actionMarker ?? e),
    ['m1'],
  );
  await record.intent(r, 'm2', 'push', {});
  await record.intent(r, 'm3', 'comment', {});
  await record.evidence(r, 'm2', { ok: true });
  await record.complete(r, 'm2');
  assert.deepEqual(
    writeAhead.openIntents(r).map((e) => e.actionMarker ?? e),
    ['m1', 'm3'],
  );
  await record.complete(r, 'm1');
  await record.complete(r, 'm3');
  assert.deepEqual(writeAhead.openIntents(r), []);
});

test('loadAll lists every ticket record', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  assert.deepEqual(await record.loadAll(commonDir, 'ticket'), []);
  await record.save(newExecution(commonDir, 8));
  await record.save(newExecution(commonDir, 12));
  await record.save(record.createEpicRecord({ commonDir, epic: 1 }));
  const all = await record.loadAll(commonDir, 'ticket');
  assert.deepEqual(
    all.map((r) => r.ticket).sort((a, b) => a - b),
    [8, 12],
  );
});

test('loadAll reports a corrupt row and an unknown schemaVersion and returns the rest', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  await record.save(newExecution(commonDir, 8));
  const unknown = JSON.stringify({ schemaVersion: 99, ticket: 10 });
  withDb(commonDir, (db) => {
    const insert = db.prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?)');
    insert.run('ticket', 9, '{');
    insert.run('ticket', 10, unknown);
  });
  const isCorrupt = (name) => (err) => {
    assert.ok(err instanceof record.RecordCorruptError);
    assert.ok(err.file.includes(dbPath(commonDir)), `${err.file} names the database`);
    assert.ok(err.file.includes(name), `${err.file} names ${name}`);
    assert.ok(err.message.includes(err.file));
    return true;
  };
  await assert.rejects(record.load(commonDir, 'ticket', 9), isCorrupt('ticket-9'));
  await assert.rejects(record.load(commonDir, 'ticket', 10), isCorrupt('ticket-10'));

  const corrupt = [];
  const records = await record.loadAll(commonDir, 'ticket', { onCorrupt: (err) => corrupt.push(err) });
  assert.deepEqual(
    records.map((r) => r.ticket),
    [8],
  );
  assert.equal(corrupt.length, 2);
  const byName = corrupt.sort((a, b) => a.file.localeCompare(b.file));
  isCorrupt('ticket-10')(byName[0]);
  isCorrupt('ticket-9')(byName[1]);

  withDb(commonDir, (db) => {
    const json = (n) => db.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(n).json;
    assert.equal(json(9), '{', 'the corrupt row is left untouched');
    assert.equal(json(10), unknown);
  });
});

test('a record written before Action ids is corrupt, not misread', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  // Its cursor names a phase and ordinal, which a resume would read as an Action id and a Recovery Number.
  await record.save(newExecution(commonDir, 8));
  const old = {
    ...newExecution(commonDir, 11),
    cursor: { vertex: 'green', visit: 1, phase: 'green', ordinal: 3, attempt: 1 },
  };
  delete old.commonDir;
  withDb(commonDir, (db) =>
    db.prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?)').run('ticket', 11, JSON.stringify(old)),
  );
  await assert.rejects(
    record.load(commonDir, 'ticket', 11),
    (err) => err instanceof record.RecordCorruptError && /Recovery Number/.test(err.message),
  );
});

// SQLite's busy handler is not fair, so on a loaded Windows runner another process's burst of writes held a save off
// past the old 5 s busy_timeout and it failed with `database is locked` (grey-goo-ri issue #136).
test('the State Database waits up to 60 s for another writer', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  assert.deepEqual({ ...sqlite.openDb(commonDir).prepare('PRAGMA busy_timeout').get() }, { timeout: 60_000 });
});

test('saveConfig stores a pinned configuration once per hash and loadConfig reads it back', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const pinned = { flow: { name: 'default' }, personas: { implementer: '# implementer\n' } };
  await sqlite.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  const firstSeen = () =>
    withDb(commonDir, (db) => db.prepare("SELECT firstSeen FROM configs WHERE hash = 'hash-1'").get().firstSeen);
  const first = firstSeen();
  assert.ok(!Number.isNaN(Date.parse(first)) && new Date(first).toISOString() === first, `${first} is an ISO time`);
  // An older firstSeen than any save could write, so a second save that replaced it would show.
  const older = '2020-01-01T00:00:00.000Z';
  withDb(commonDir, (db) => db.prepare("UPDATE configs SET firstSeen = ? WHERE hash = 'hash-1'").run(older));
  await sqlite.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  assert.equal(firstSeen(), older, 'the second save keeps the first firstSeen');
  withDb(commonDir, (db) => assert.equal(db.prepare('SELECT count(*) AS n FROM configs').get().n, 1));
  assert.deepEqual(await sqlite.loadConfig(commonDir, 'hash-1'), pinned);
  assert.equal(await sqlite.loadConfig(commonDir, 'hash-2'), null);
});

test('an unknown database version is refused by name', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  mkdirSync(join(commonDir, 'gg'));
  const db = new DatabaseSync(dbPath(commonDir));
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(
    () => sqlite.openDb(commonDir),
    (err) => {
      assert.ok(!(err instanceof TypeError), `not a missing function: ${err.message}`);
      assert.ok(err.message.includes(dbPath(commonDir)), `${err.message} names the database`);
      assert.match(err.message, /\b2\b/);
      assert.match(err.message, /\b1\b/);
      return true;
    },
  );
});

// Another gg process writing events must not starve a new connection: on a loaded Windows runner two appenders saw
// `database is locked` from openDb's write transaction once its busy_timeout ran out.
test('opening an existing State Database does not wait for a writer', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  sqlite.openDb(commonDir);
  await sqlite.close(commonDir);
  const writer = new DatabaseSync(dbPath(commonDir));
  writer.exec('BEGIN IMMEDIATE');
  try {
    // The writer holds its lock until this case ends, so an openDb that waited for it would fail with SQLITE_BUSY.
    const db = sqlite.openDb(commonDir);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM records').get().n,
      0,
      'reads still work while the writer holds its lock',
    );
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});

test('openDb shares one connection between spellings of the same directory', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const db = sqlite.openDb(commonDir);
  // String concatenation, not join: join would normalise the segments before openDb sees them.
  assert.equal(sqlite.openDb(`${commonDir}/./gg/../`), db, 'a relative-segment spelling hits the cache');
  // sep: backslashes on Windows; on POSIX a backslash is a filename character, not another spelling.
  await sqlite.close(`${commonDir}${sep}gg${sep}..`);
  assert.throws(() => db.prepare('SELECT 1'), /not open/, 'closing by another spelling closed the shared connection');
});

test('close releases the database so the directory can be removed', async (t) => {
  const commonDir = await mkdtemp(join(tmpdir(), 'gg-record-'));
  t.after(() => rm(commonDir, { recursive: true, force: true }));
  await record.save(newExecution(commonDir));
  await sqlite.saveConfig(commonDir, 'hash-1', '{}');
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  await sqlite.close(commonDir);
  rmSync(commonDir, { recursive: true });
  assert.ok(!existsSync(commonDir));
  // A later call opens a fresh connection rather than reusing the closed one.
  await record.save(newExecution(commonDir));
  assert.equal((await record.load(commonDir, 'ticket', 8)).ticket, 8);
  await sqlite.close(commonDir);
});
