import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../lib/events.mjs';
import * as locks from '../lib/locks.mjs';
import * as record from '../lib/record.mjs';

const saver = fileURLToPath(new URL('./support/record-saver.mjs', import.meta.url));
const contender = fileURLToPath(new URL('./support/lock-contender.mjs', import.meta.url));
const opener = fileURLToPath(new URL('./support/db-opener.mjs', import.meta.url));

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
  assert.equal(r.log.length, 3);
  assert.deepEqual(r.log.map((e) => e.step), ['intent', 'evidence', 'complete']);
  for (const e of r.log) {
    assert.equal(e.marker, 'm1');
    assert.equal(e.action, 'commit');
    assert.equal(typeof e.ts, 'string');
  }
  assert.deepEqual(r.log[0].payload, { message: 'red' });
  assert.deepEqual(r.log[1].evidence, { sha: 'deadbeef' });
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

test('an open that finds no tables waits for the first opener, not for its saves', async (t) => {
  // Plays the first opener: holds the open lock while it creates the tables, then saves for longer than busy_timeout.
  // A second opener that read the old version must not wait on the database write lock behind those saves.
  const commonDir = await tempCommonDir(t);
  mkdirSync(join(commonDir, 'gg', 'locks'), { recursive: true });
  const db = new DatabaseSync(dbPath(commonDir));
  const lock = new DatabaseSync(join(commonDir, 'gg', 'locks', 'open.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    lock.exec('BEGIN EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    const child = spawn(process.execPath, [opener, commonDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const exit = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    await new Promise((resolve) => child.stdout.once('data', resolve));
    // shortcut: a fixed pause lets the child read the empty version before the tables commit; a slower start only
    // makes the case pass for the wrong reason, never fail.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n));
      CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT,
        ticket INTEGER, json TEXT NOT NULL);
      PRAGMA user_version = ${record.DB_SCHEMA_VERSION};`);
    db.exec('COMMIT');
    lock.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    await new Promise((resolve) => setTimeout(resolve, 6000));
    db.exec('COMMIT');
    assert.equal(await exit, 0, `the second open failed: ${err}`);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    lock.close();
  }
});

test('two processes save different records concurrently without loss', async (t) => {
  const commonDir = await tempCommonDir(t);
  const exits = await Promise.all([1, 2].map((ticket) => new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, String(ticket), '200'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ ticket, code, err }));
  })));
  assert.deepEqual(exits, [{ ticket: 1, code: 0, err: '' }, { ticket: 2, code: 0, err: '' }]);
  withDb(commonDir, (db) => {
    const rows = db.prepare('SELECT kind, n FROM records ORDER BY n').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ kind: 'ticket', n: 1 }, { kind: 'ticket', n: 2 }]);
  });
  const all = (await record.loadAll(commonDir, 'ticket')).sort((a, b) => a.ticket - b.ticket);
  assert.deepEqual(all.map((r) => [r.ticket, r.activity]), [
    [1, { busy: false, generation: 200 }],
    [2, { busy: false, generation: 200 }],
  ]);
});

const tickets = [1, 2, 3, 4, 5, 6, 7, 8];

// Another gg process opening the State Database and saving one record, resolving with its exit and elapsed time.
function saveOnce(commonDir, ticket) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, String(ticket), '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ ticket, code, err, ms: Date.now() - started }));
  });
}

const exitsOf = (results) => results.map(({ ticket, code, err }) => ({ ticket, code, err }));
const allOk = tickets.map((ticket) => ({ ticket, code: 0, err: '' }));
const journalMode = (commonDir) => withDb(commonDir, (db) => db.prepare('PRAGMA journal_mode').get().journal_mode);

// Without the open lock about one open in 100-200 failed with SQLITE_BUSY here, so 240 opens usually catch it.
test('eight processes creating one new database at once all open it in WAL mode', async (t) => {
  const root = await tempCommonDir(t);
  for (let round = 0; round < 30; round++) {
    const commonDir = join(root, String(round));
    const exits = exitsOf(await Promise.all(tickets.map((ticket) => saveOnce(commonDir, ticket))));
    assert.deepEqual(exits, allOk, `round ${round}`);
    assert.equal(journalMode(commonDir), 'wal');
  }
});

test('openers of a new database queue while the open lock is held and all succeed once it is released', async (t) => {
  const commonDir = await tempCommonDir(t);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  assert.ok(openLock);
  const pending = tickets.map((ticket) => saveOnce(commonDir, ticket));
  let finished = 0;
  for (const p of pending) p.then(() => finished++);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(finished, 0, 'no opener gets past a held open lock');
  await locks.release(openLock);
  assert.deepEqual(exitsOf(await Promise.all(pending)), allOk);
  assert.equal(journalMode(commonDir), 'wal');
});

test('an opener of a new database proceeds when the process holding the open lock dies', async (t) => {
  const commonDir = await tempCommonDir(t);
  const holder = spawn(process.execPath, [contender, commonDir, 'open', '60000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  const report = await new Promise((resolve) => holder.stdout.once('data', (chunk) => resolve(JSON.parse(chunk))));
  assert.ok(report.handle, 'the child holds the open lock');
  const pending = saveOnce(commonDir, 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  holder.kill();
  assert.deepEqual(exitsOf([await pending]), [{ ticket: 1, code: 0, err: '' }]);
  assert.equal(journalMode(commonDir), 'wal');
});

test('an opener of a new database fails with SQLITE_BUSY after the 5 s busy timeout when the open lock is never released', async (t) => {
  const commonDir = await tempCommonDir(t);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  const { code, err, ms } = await saveOnce(commonDir, 1).finally(() => locks.release(openLock));
  assert.notEqual(code, 0);
  assert.match(err, /errcode: 5/);
  assert.ok(ms >= 5000 && ms < 15000, `gave up after ${ms} ms`);
});

test('an opener of an existing WAL database does not wait for the open lock', async (t) => {
  const commonDir = await tempCommonDir(t);
  record.openDb(commonDir);
  await record.close(commonDir);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  // The open lock is held until the opener exits, so exit 0 proves it was skipped; waiting for it fails with errcode 5.
  const { code, err } = await saveOnce(commonDir, 1).finally(() => locks.release(openLock));
  assert.deepEqual({ code, err }, { code: 0, err: '' });
});

test('saveConfig stores a pinned configuration once per hash and loadConfig reads it back', async (t) => {
  const commonDir = await tempCommonDir(t);
  const pinned = { flow: { name: 'default' }, personas: { implementer: '# implementer\n' } };
  await record.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  const firstSeen = () => withDb(commonDir, (db) => db.prepare("SELECT firstSeen FROM configs WHERE hash = 'hash-1'").get().firstSeen);
  const first = firstSeen();
  assert.ok(!Number.isNaN(Date.parse(first)) && new Date(first).toISOString() === first, `${first} is an ISO time`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await record.saveConfig(commonDir, 'hash-1', JSON.stringify(pinned));
  assert.equal(firstSeen(), first, 'the second save keeps the first firstSeen');
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
    const started = Date.now();
    const db = record.openDb(commonDir);
    assert.ok(Date.now() - started < 2000, `openDb waited ${Date.now() - started} ms for the writer`);
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
