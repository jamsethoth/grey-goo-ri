import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as locks from '../../../lib/locks.mjs';
import * as record from '../../../lib/record.mjs';

const saver = fileURLToPath(new URL('../../support/record-saver.mjs', import.meta.url));
const contender = fileURLToPath(new URL('../../support/lock-contender.mjs', import.meta.url));
const opener = fileURLToPath(new URL('../../support/db-opener.mjs', import.meta.url));
const holderScript = fileURLToPath(new URL('../../support/write-lock-holder.mjs', import.meta.url));

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

// Cases that wait for another process to reach a lock or exit: one that never does fails at this bound.
const CASE = { timeout: 120_000 };

// Another gg process opening the State Database (support/db-opener.mjs). said(text) resolves once it has printed text;
// exit resolves with its code, output and error text.
function openInChild(commonDir) {
  const child = spawn(process.execPath, [opener, commonDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
  const exit = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const said = (text) => new Promise((resolve) => {
    const check = () => (out.includes(text) ? resolve() : child.stdout.once('data', check));
    check();
  });
  return { child, said, exit };
}

// Reads and writes rows directly, as another SQLite client would.
function withDb(commonDir, fn) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('an open that finds no tables waits for the first opener, not for its saves', CASE, async (t) => {
  // Plays the first opener: holds the open lock while it creates the tables, then saves until the second opener exits.
  // A second opener that read the old version must not wait on the database write lock behind those saves: had it
  // waited, the busy timeout would fail it, since the saves end only once it has exited.
  const commonDir = await tempCommonDir(t);
  mkdirSync(join(commonDir, 'gg', 'locks'), { recursive: true });
  const db = new DatabaseSync(dbPath(commonDir));
  const lock = new DatabaseSync(join(commonDir, 'gg', 'locks', 'open.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    lock.exec('BEGIN EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    const { child, said, exit } = openInChild(commonDir);
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await said('locking'); // it has read the empty version and waits for the open lock
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n));
      CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT,
        ticket INTEGER, json TEXT NOT NULL);
      PRAGMA user_version = ${record.DB_SCHEMA_VERSION};`);
    db.exec('COMMIT');
    lock.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    const { code, err } = await exit;
    assert.equal(code, 0, `the second open waited behind the saves or failed: ${err}`);
    db.exec('COMMIT');
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

// SQLite's busy handler is not fair, so on a loaded Windows runner another process's burst of writes held a save off
// past the old 5 s busy_timeout and it failed with `database is locked` (grey-goo-ri issue #136, ADR 0015). The save
// runs in this process, so the time it blocks is the time it waited for the other process's lock.
test('a save waits out another process that holds the write lock for longer than 5 s', CASE, async (t) => {
  const commonDir = await tempCommonDir(t);
  record.openDb(commonDir);
  const holder = spawn(process.execPath, [holderScript, commonDir, '8000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const r = record.createExecution({
    commonDir, ticket: 1, epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123',
    run: 'run-1', worktree: `${commonDir}/wt-1`, branch: 'ticket/1', base: 'main',
  });
  const started = Date.now();
  await record.save(r);
  assert.ok(Date.now() - started > 5000, `the save did not wait past 5 s: ${Date.now() - started} ms`);
  assert.deepEqual((await record.loadAll(commonDir, 'ticket')).map((saved) => saved.ticket), [1]);
});

const tickets = [1, 2, 3, 4, 5, 6, 7, 8];

// Another gg process opening the State Database and saving one record, resolving with its exit.
function saveOnce(commonDir, ticket) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, String(ticket), '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ ticket, code, err }));
  });
}

const allOk = tickets.map((ticket) => ({ ticket, code: 0, err: '' }));
const journalMode = (commonDir) => withDb(commonDir, (db) => db.prepare('PRAGMA journal_mode').get().journal_mode);

// Without the open lock about one open in 100-200 failed with SQLITE_BUSY here. One round shows the wiring; the race
// itself needs many rounds, which `node test/support/open-stress.mjs` runs outside the suite.
test('eight processes creating one new database at once all open it in WAL mode', async (t) => {
  const commonDir = await tempCommonDir(t);
  assert.deepEqual(await Promise.all(tickets.map((ticket) => saveOnce(commonDir, ticket))), allOk);
  assert.equal(journalMode(commonDir), 'wal');
});

test('openers of a new database queue while the open lock is held and all succeed once it is released', CASE, async (t) => {
  const commonDir = await tempCommonDir(t);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  assert.ok(openLock);
  const openers = tickets.map(() => openInChild(commonDir));
  t.after(() => { for (const { child } of openers) if (child.exitCode === null) child.kill(); });
  await Promise.all(openers.map(({ said }) => said('locking')));
  const codes = openers.map(({ child }) => child.exitCode);
  const early = await Promise.all(openers.filter(({ child }) => child.exitCode !== null).map(({ exit }) => exit));
  assert.deepEqual(codes, tickets.map(() => null), `no opener gets past a held open lock: ${JSON.stringify(early)}`);
  await locks.release(openLock);
  const exits = (await Promise.all(openers.map(({ exit }) => exit))).map(({ code, err }) => ({ code, err }));
  assert.deepEqual(exits, tickets.map(() => ({ code: 0, err: '' })));
  assert.equal(journalMode(commonDir), 'wal');
});

test('an opener of a new database proceeds when the process holding the open lock dies', CASE, async (t) => {
  const commonDir = await tempCommonDir(t);
  const holder = spawn(process.execPath, [contender, commonDir, 'open', '600000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  const report = await new Promise((resolve) => holder.stdout.once('data', (chunk) => resolve(JSON.parse(chunk))));
  assert.ok(report.handle, 'the child holds the open lock');
  const { child, said, exit } = openInChild(commonDir);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await said('locking');
  holder.kill();
  const { code, err } = await exit;
  assert.deepEqual({ code, err }, { code: 0, err: '' });
  assert.equal(journalMode(commonDir), 'wal');
});

// The opener names the statement that gave up: the open lock's BEGIN EXCLUSIVE, which waits under its 5 s busy timeout,
// not a statement on gg.db, which would wait 60 s. How long it took depends on the machine's load, so it is not checked.
test('an opener of a new database fails with SQLITE_BUSY after the 5 s busy timeout when the open lock is never released', CASE, async (t) => {
  const commonDir = await tempCommonDir(t);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  const { code, out, err } = await openInChild(commonDir).exit.finally(() => locks.release(openLock));
  assert.notEqual(code, 0);
  assert.match(err, /errcode: 5/);
  assert.match(out, /^failed: BEGIN EXCLUSIVE$/m, `the open lock's wait gave up: ${out}`);
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
