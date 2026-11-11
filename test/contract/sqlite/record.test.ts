import { test } from 'node:test';
import type { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as locks from '../../../lib/locks.ts';
import * as record from '../../../lib/record.ts';
import * as stateDatabase from '../../../lib/state-database.ts';
import * as lockHolder from '../../support/lock-holder.ts';
import * as childExit from '../../support/child-exit.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const saver = fileURLToPath(new URL('../../support/record-saver.ts', import.meta.url));
const opener = fileURLToPath(new URL('../../support/state-database-opener.ts', import.meta.url));
const holderScript = fileURLToPath(new URL('../../support/write-lock-holder.ts', import.meta.url));

const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');

// Cases that wait for another process to reach a lock or exit: one that never does fails at this bound.
const CASE = { timeout: 120_000 };

// Another gg process opening the State Database (support/state-database-opener.ts). said(text) resolves once it has
// printed text, and rejects with its exit if it closes without printing it; exit resolves with its code, output and
// error text. A gated opener waits after loading until go() is called.
function openInChild(commonDir: string, { gated = false } = {}) {
  const child = spawn(process.execPath, [opener, commonDir, ...(gated ? ['gated'] : [])], {
    stdio: [gated ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const exit = childExit.exitOf(child).then(({ code, stdout = '', err }) => ({ code, stdout, err }));
  const stdout = child.stdout as Readable;
  let printed = '';
  stdout.on('data', (chunk: string) => {
    printed += chunk;
  });
  const said = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => (printed.includes(text) ? resolve() : stdout.once('data', check));
      check();
      exit.then((exited) => reject(new Error(`the opener closed without printing ${text}: ${JSON.stringify(exited)}`)));
    });
  return { child, said, exit, go: () => (child.stdin as Writable).end('go\n') };
}

// Reads and writes rows directly, as another SQLite client would.
function withDb<Result>(commonDir: string, read: (db: DatabaseSync) => Result) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

test('an open that finds no tables waits for the first opener, not for its saves', CASE, async (t) => {
  // Plays the first opener: holds the open lock while it creates the tables, then saves until the second opener exits.
  // A second opener that read the old version must not wait on the database write lock behind those saves: had it
  // waited, the busy timeout would fail it, since the saves end only once it has exited.
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  mkdirSync(join(commonDir, 'gg', 'locks'), { recursive: true });
  const db = new DatabaseSync(dbPath(commonDir));
  const lock = new DatabaseSync(join(commonDir, 'gg', 'locks', 'open.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    lock.exec('BEGIN EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    const { child, said, exit } = openInChild(commonDir);
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    await said('locking'); // it has read the empty version and waits for the open lock
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n));
      CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT,
        ticket INTEGER, json TEXT NOT NULL);
      PRAGMA user_version = ${stateDatabase.SCHEMA_VERSION};`);
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  const exits = await Promise.all(
    [1, 2].map((ticket) =>
      childExit
        .exitOf(
          spawn(process.execPath, [saver, commonDir, String(ticket), '200'], { stdio: ['ignore', 'ignore', 'pipe'] }),
        )
        .then((exit) => ({ ticket, ...exit })),
    ),
  );
  assert.deepEqual(exits, [
    { ticket: 1, code: 0, err: '' },
    { ticket: 2, code: 0, err: '' },
  ]);
  withDb(commonDir, (db) => {
    const rows = db
      .prepare('SELECT kind, n FROM records ORDER BY n')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      // eslint-disable-next-line id-length -- n is the records table's column
      { kind: 'ticket', n: 1 },
      // eslint-disable-next-line id-length -- n is the records table's column
      { kind: 'ticket', n: 2 },
    ]);
  });
  const all = record.loadAll(commonDir, 'ticket').sort((left, right) => left.ticket - right.ticket);
  assert.deepEqual(
    all.map((executionRecord) => [executionRecord.ticket, executionRecord.activity]),
    [
      [1, { busy: false, generation: 200 }],
      [2, { busy: false, generation: 200 }],
    ],
  );
});

// SQLite's busy handler is not fair, so on a loaded Windows runner another process's burst of writes held a save off
// past the old 5 s busy_timeout and it failed with `database is locked` (grey-goo-ri issue #136, ADR 0015). The save
// runs in this process, so the time it blocks is the time it waited for the other process's lock.
test('a save waits out another process that holds the write lock for longer than 5 s', CASE, async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  stateDatabase.open(commonDir);
  const holder = spawn(process.execPath, [holderScript, commonDir, '8000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => {
    if (holder.exitCode === null) holder.kill();
  });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 1,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: `${commonDir}/wt-1`,
    branch: 'ticket/1',
    base: 'main',
  });
  const started = Date.now();
  record.save(executionRecord);
  assert.ok(Date.now() - started > 5000, `the save did not wait past 5 s: ${Date.now() - started} ms`);
  assert.deepEqual(
    record.loadAll(commonDir, 'ticket').map((saved) => saved.ticket),
    [1],
  );
});

const tickets = [1, 2, 3, 4, 5, 6, 7, 8];

// Another gg process opening the State Database and saving one record, resolving with its exit.
function saveOnce(commonDir: string, ticket: number) {
  return childExit
    .exitOf(spawn(process.execPath, [saver, commonDir, String(ticket), '1'], { stdio: ['ignore', 'ignore', 'pipe'] }))
    .then((exit) => ({ ticket, ...exit }));
}

const allOk = tickets.map((ticket) => ({ ticket, code: 0, err: '' }));
const journalMode = (commonDir: string) =>
  withDb(commonDir, (db) => (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode);

// Without the open lock about one open in 100-200 failed with SQLITE_BUSY here. One round shows the wiring; the race
// itself needs many rounds, which `node test/support/state-database-open-stress.ts` runs outside the suite.
test('eight processes creating one new database at once all open it in WAL mode', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  assert.deepEqual(await Promise.all(tickets.map((ticket) => saveOnce(commonDir, ticket))), allOk);
  assert.equal(journalMode(commonDir), 'wal');
});

test(
  'openers of a new database queue while the open lock is held and all succeed once it is released',
  CASE,
  async (t) => {
    // node:test skips later after hooks once one throws, and removing the temp directory throws while the open lock is
    // held, so this hook comes first: it kills the openers, since a gated one waits for go forever, and frees the lock.
    const openers: ReturnType<typeof openInChild>[] = [];
    let openLock: locks.LockHandle | null = null;
    t.after(async () => {
      const running = openers.filter(({ child }) => child.exitCode === null);
      for (const { child } of running) child.kill();
      await Promise.all(running.map(({ exit }) => exit));
      if (openLock?.db.isOpen) await locks.release(openLock);
    });
    const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
    openLock = await locks.tryAcquire(commonDir, 'open');
    assert.ok(openLock);
    for (const _ of tickets) openers.push(openInChild(commonDir, { gated: true }));
    // Each opener's 5 s busy timeout starts at its `locking`. Under load eight Node start-ups spread over more than
    // that (grey-goo-ri issue #188), so the openers start their waits together once all have loaded.
    await Promise.all(openers.map(({ said }) => said('ready')));
    for (const { go } of openers) go();
    await Promise.all(openers.map(({ said }) => said('locking')));
    // An opener that got past the held lock switches to WAL within milliseconds of its `locking`, as fast as this
    // process could release, so the lock stays held a while longer to let one show itself. The marker written just
    // before the release then tells each switch's side of it: a queued opener switches only once it holds the lock,
    // after the marker.
    await sleep(1000);
    writeFileSync(join(commonDir, 'released'), '');
    await locks.release(openLock);
    const exits = await Promise.all(openers.map(({ exit }) => exit));
    assert.deepEqual(
      exits.map(({ stdout }) => stdout.match(/^switching \w+$/gm)),
      tickets.map(() => ['switching released']),
      'no opener gets past a held open lock, and each switches once it is released',
    );
    assert.deepEqual(
      exits.map(({ code, err }) => ({ code, err })),
      tickets.map(() => ({ code: 0, err: '' })),
      `every opener opens once the lock is released: ${JSON.stringify(exits)}`,
    );
    assert.equal(journalMode(commonDir), 'wal');
  },
);

test('an opener of a new database proceeds when the process holding the open lock dies', CASE, async (t) => {
  let holder: lockHolder.LockHolder | undefined;
  // before the temp directory's removal, which throws while the holder has the lock open
  t.after(() => holder?.child.kill());
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  holder = await lockHolder.holdLock(t, commonDir, 'open');
  assert.ok(holder.report.handle, 'the child holds the open lock');
  const { child, said, exit } = openInChild(commonDir);
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await said('locking');
  await holder.release();
  const { code, err } = await exit;
  assert.deepEqual({ code, err }, { code: 0, err: '' });
  assert.equal(journalMode(commonDir), 'wal');
});

// The opener names the statement that gave up: the open lock's BEGIN EXCLUSIVE, which waits under its 5 s busy
// timeout, not a statement on gg.db, which would wait 60 s. How long it took depends on the machine's load, so it is
// not checked.
test(
  'an opener of a new database fails with SQLITE_BUSY after the 5 s busy timeout when the open lock is never released',
  CASE,
  async (t) => {
    const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
    const openLock = await locks.tryAcquire(commonDir, 'open');
    const { code, stdout, err } = await openInChild(commonDir).exit.finally(() =>
      locks.release(openLock as locks.LockHandle),
    );
    assert.notEqual(code, 0);
    assert.match(err, /errcode: 5/);
    assert.match(stdout, /^failed: BEGIN EXCLUSIVE$/m, `the open lock's wait gave up: ${stdout}`);
  },
);

test('an opener of an existing WAL database does not wait for the open lock', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
  stateDatabase.open(commonDir);
  await stateDatabase.close(commonDir);
  const openLock = await locks.tryAcquire(commonDir, 'open');
  // The open lock is held until the opener exits, so exit 0 proves it was skipped; waiting for it fails with errcode 5.
  const { code, err } = await saveOnce(commonDir, 1).finally(() => locks.release(openLock as locks.LockHandle));
  assert.deepEqual({ code, err }, { code: 0, err: '' });
});
