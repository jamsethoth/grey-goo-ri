import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as events from '../../lib/events.mjs';
import * as record from '../../lib/record.mjs';

// A temp commonDir whose database connection is closed before the directory is removed, as Windows requires.
async function tempCommonDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gg-record-'));
  t.after(async () => {
    await record.close(dir);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

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
    commonDir, ticket, epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123', run: 'run-1',
    worktree: join(commonDir, 'wt'), branch: `ticket/${ticket}`, base: 'main',
  });
}

function withoutCommonDir(r) {
  const { commonDir, ...rest } = r;
  return rest;
}

test('createExecution mints an execution id and the documented fields', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  assert.match(r.execution, /^8\.[0-9a-f]{6}$/);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.commonDir, commonDir);
  assert.equal(r.ticket, 8);
  assert.equal(r.epic, 1);
  assert.equal(r.configHash, 'abc123');
  assert.equal(r.run, 'run-1');
  assert.equal(r.state, 'active');
  assert.deepEqual(Object.keys(r.cursor).sort(), ['attempt', 'ordinal', 'phase', 'vertex', 'visit']);
  assert.equal(r.cursor.vertex, 'implement');
  assert.equal(r.cursor.visit, 1);
  assert.deepEqual(r.visits, {});
  assert.deepEqual(r.traversals, {});
  assert.deepEqual(r.retries, {});
  assert.deepEqual(r.sessions, {});
  assert.deepEqual(r.outputs, { red: null, implementation: [], reviews: [] });
  assert.deepEqual(r.history, []);
  assert.equal(r.branch, 'ticket/8');
  assert.equal(r.base, 'main');
  assert.equal(r.pr, null);
  assert.equal(r.pending, null);
  assert.equal(r.snapshot, null);
  assert.deepEqual(r.activity, { busy: false, generation: 0 });
  assert.equal(r.heartbeat, null);
  assert.deepEqual(r.log, []);
  assert.notEqual(newExecution(commonDir).execution, r.execution);
});

test('createEpicRecord has the documented fields', async (t) => {
  const commonDir = await tempCommonDir(t);
  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  assert.deepEqual(withoutCommonDir(epic), { schemaVersion: 1, epic: 1, approval: null, pending: null });
});

test('save writes a records row and never a records directory', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  await record.save(r);
  await record.save(epic);
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'no gg/records directory');
  withDb(commonDir, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, ['configs', 'events', 'records']);
    const rows = db.prepare('SELECT kind, n, json FROM records ORDER BY kind').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { kind: 'epic', n: 1, json: JSON.stringify(withoutCommonDir(epic), null, 2) + '\n' },
      { kind: 'ticket', n: 8, json: JSON.stringify(withoutCommonDir(r), null, 2) + '\n' },
    ]);
  });
  assert.equal(record.DB_SCHEMA_VERSION, 1);
});

test('load returns null for a missing row and the record for a saved one', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.save(r);
  assert.equal(await record.load(commonDir, 'ticket', 9), null);
  assert.equal(await record.load(commonDir, 'epic', 8), null);
  // Changed behind the module's back, so the load must come from the row.
  withDb(commonDir, (db) => {
    db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = 8")
      .run(JSON.stringify({ ...withoutCommonDir(r), state: 'done' }));
  });
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.equal(loaded.commonDir, commonDir);
  assert.deepEqual(loaded, { ...r, state: 'done' });

  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  await record.save(epic);
  assert.deepEqual(await record.load(commonDir, 'epic', 1), epic);
});

test('the write-ahead log records intent, evidence and completion per marker', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', { message: 'red' });
  await record.evidence(r, 'm1', { sha: 'deadbeef' });
  await record.complete(r, 'm1');
  assert.deepEqual(r.log.map(({ ts, ...e }) => e), [
    { step: 'intent', marker: 'm1', action: 'commit', payload: { message: 'red' } },
    { step: 'evidence', marker: 'm1', action: 'commit', evidence: { sha: 'deadbeef' } },
    { step: 'complete', marker: 'm1', action: 'commit' },
  ]);
  assert.deepEqual(r.log.map((e) => typeof e.ts), ['string', 'string', 'string']);
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.deepEqual(loaded.log, r.log, 'each step saves');
});

test('a record transition and its event commit together', async (t) => {
  const commonDir = await tempCommonDir(t);
  const ev = events.eventLog(commonDir, { run: 'run-1', ticket: 8 });
  const r = newExecution(commonDir);
  const db = record.openDb(commonDir);
  const failEvents = () => db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const eventTypes = () => events.readEvents(commonDir).map((e) => e.type);
  const start = () => ev('ticket_start', { execution: r.execution });

  failEvents();
  await assert.rejects(record.save(r, start), (err) => err.name === 'RecordSaveError', 'a failed Event fails the save');
  assert.equal(await record.load(commonDir, 'ticket', 8), null, 'no record is created without its Event');
  db.exec('DROP TRIGGER fail_event');
  await record.save(r, start);
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'active');
  assert.deepEqual(eventTypes(), ['ticket_start']);

  failEvents();
  r.state = 'held';
  await assert.rejects(record.save(r, () => ev('ticket_end', { execution: r.execution })), (err) => err.name === 'RecordSaveError');
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'active', 'the previous row stays');
  assert.deepEqual(eventTypes(), ['ticket_start'], 'and no Event lands');
  db.exec('DROP TRIGGER fail_event');
  await record.save(r, () => ev('ticket_end', { execution: r.execution }));
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'held');
  assert.deepEqual(eventTypes(), ['ticket_start', 'ticket_end']);
  r.state = 'done';
  await record.save(r);
  assert.equal((await record.load(commonDir, 'ticket', 8)).state, 'done', 'a plain save still works after a rollback');
});

test('openIntents lists intents without completion oldest first', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', {});
  assert.deepEqual(record.openIntents(r).map((e) => e.marker ?? e), ['m1']);
  await record.intent(r, 'm2', 'push', {});
  await record.intent(r, 'm3', 'comment', {});
  await record.evidence(r, 'm2', { ok: true });
  await record.complete(r, 'm2');
  assert.deepEqual(record.openIntents(r).map((e) => e.marker ?? e), ['m1', 'm3']);
  await record.complete(r, 'm1');
  await record.complete(r, 'm3');
  assert.deepEqual(record.openIntents(r), []);
});

test('loadAll lists every ticket record', async (t) => {
  const commonDir = await tempCommonDir(t);
  assert.deepEqual(await record.loadAll(commonDir, 'ticket'), []);
  await record.save(newExecution(commonDir, 8));
  await record.save(newExecution(commonDir, 12));
  await record.save(record.createEpicRecord({ commonDir, epic: 1 }));
  const all = await record.loadAll(commonDir, 'ticket');
  assert.deepEqual(all.map((r) => r.ticket).sort((a, b) => a - b), [8, 12]);
});

test('loadAll reports a corrupt row and an unknown schemaVersion and returns the rest', async (t) => {
  const commonDir = await tempCommonDir(t);
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
  assert.deepEqual(records.map((r) => r.ticket), [8]);
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

// SQLite's busy handler is not fair, so on a loaded Windows runner another process's burst of writes held a save off
// past the old 5 s busy_timeout and it failed with `database is locked` (grey-goo-ri issue #136).
test('the State Database waits up to 60 s for another writer', async (t) => {
  const commonDir = await tempCommonDir(t);
  assert.deepEqual({ ...record.openDb(commonDir).prepare('PRAGMA busy_timeout').get() }, { timeout: 60_000 });
});

test('saveConfig stores a pinned configuration once per hash and loadConfig reads it back', async (t) => {
  const commonDir = await tempCommonDir(t);
  const pinned = { flow: { name: 'default' }, personas: { implementer: '# implementer\n' } };
  await record.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  const firstSeen = () => withDb(commonDir, (db) => db.prepare("SELECT firstSeen FROM configs WHERE hash = 'hash-1'").get().firstSeen);
  const first = firstSeen();
  assert.ok(!Number.isNaN(Date.parse(first)) && new Date(first).toISOString() === first, `${first} is an ISO time`);
  // An older firstSeen than any save could write, so a second save that replaced it would show.
  const older = '2020-01-01T00:00:00.000Z';
  withDb(commonDir, (db) => db.prepare("UPDATE configs SET firstSeen = ? WHERE hash = 'hash-1'").run(older));
  await record.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  assert.equal(firstSeen(), older, 'the second save keeps the first firstSeen');
  withDb(commonDir, (db) => assert.equal(db.prepare('SELECT count(*) AS n FROM configs').get().n, 1));
  assert.deepEqual(await record.loadConfig(commonDir, 'hash-1'), pinned);
  assert.equal(await record.loadConfig(commonDir, 'hash-2'), null);
});

test('an unknown database version is refused by name', async (t) => {
  const commonDir = await tempCommonDir(t);
  mkdirSync(join(commonDir, 'gg'));
  const db = new DatabaseSync(dbPath(commonDir));
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(() => record.openDb(commonDir), (err) => {
    assert.ok(!(err instanceof TypeError), `not a missing function: ${err.message}`);
    assert.ok(err.message.includes(dbPath(commonDir)), `${err.message} names the database`);
    assert.match(err.message, /\b2\b/);
    assert.match(err.message, /\b1\b/);
    return true;
  });
});

// Another gg process writing events must not starve a new connection: on a loaded Windows runner two appenders saw
// `database is locked` from openDb's write transaction once its busy_timeout ran out.
test('opening an existing State Database does not wait for a writer', async (t) => {
  const commonDir = await tempCommonDir(t);
  record.openDb(commonDir);
  await record.close(commonDir);
  const writer = new DatabaseSync(dbPath(commonDir));
  writer.exec('BEGIN IMMEDIATE');
  try {
    // The writer holds its lock until this case ends, so an openDb that waited for it would fail with SQLITE_BUSY.
    const db = record.openDb(commonDir);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 0, 'reads still work while the writer holds its lock');
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});

test('openDb shares one connection between spellings of the same directory', async (t) => {
  const commonDir = await tempCommonDir(t);
  const db = record.openDb(commonDir);
  // String concatenation, not join: join would normalise the segments before openDb sees them.
  assert.equal(record.openDb(`${commonDir}/./gg/../`), db, 'a relative-segment spelling hits the cache');
  // sep: backslashes on Windows; on POSIX a backslash is a filename character, not another spelling.
  await record.close(`${commonDir}${sep}gg${sep}..`);
  assert.throws(() => db.prepare('SELECT 1'), /not open/, 'closing by another spelling closed the shared connection');
});

test('close releases the database so the directory can be removed', async (t) => {
  const commonDir = await mkdtemp(join(tmpdir(), 'gg-record-'));
  t.after(() => rm(commonDir, { recursive: true, force: true }));
  await record.save(newExecution(commonDir));
  await record.saveConfig(commonDir, 'hash-1', '{}');
  assert.ok(existsSync(dbPath(commonDir)), 'gg/gg.db exists');
  await record.close(commonDir);
  rmSync(commonDir, { recursive: true });
  assert.ok(!existsSync(commonDir));
  // A later call opens a fresh connection rather than reusing the closed one.
  await record.save(newExecution(commonDir));
  assert.equal((await record.load(commonDir, 'ticket', 8)).ticket, 8);
  await record.close(commonDir);
});
