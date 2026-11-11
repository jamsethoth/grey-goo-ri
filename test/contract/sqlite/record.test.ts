import { test } from 'node:test';
import type { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as record from '../../../lib/record.ts';
import * as stateDatabase from '../../../lib/state-database.ts';
import * as childExit from '../../support/child-exit.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const saver = fileURLToPath(new URL('../../support/record-saver.ts', import.meta.url));
const creatorScript = fileURLToPath(new URL('../../support/state-database-creator.ts', import.meta.url));
const holderScript = fileURLToPath(new URL('../../support/write-lock-holder.ts', import.meta.url));

const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');

// Cases that wait for another process to reach a lock or exit: one that never does fails at this bound.
const CASE = { timeout: 120_000 };

// Reads and writes rows directly, as another SQLite client would.
function withDb<Result>(commonDir: string, read: (db: DatabaseSync) => Result) {
  const db = new DatabaseSync(dbPath(commonDir));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

test('two processes save different records concurrently without loss', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
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
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-record-');
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

// Another gg init creating the State Database (support/state-database-creator.ts). ready resolves once it has loaded;
// go() starts its create; exit resolves with its code, output and error text.
function createInChild(commonDir: string) {
  const child = spawn(process.execPath, [creatorScript, commonDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = childExit.exitOf(child).then(({ code, stdout = '', err }) => ({ code, stdout, err }));
  const ready = new Promise<void>((resolve, reject) => {
    (child.stdout as Readable).once('data', () => resolve());
    exit.then((exited) => reject(new Error(`the creator closed before it was ready: ${JSON.stringify(exited)}`)));
  });
  return { child, ready, exit, go: () => (child.stdin as Writable).end('go\n') };
}

const creators = [1, 2, 3, 4, 5, 6, 7, 8];

// Only gg init creates the State Database (#150), and two inits may run at once, so creation must not race: each builds
// its own temp file and links it into place, and the link fails for all but one.
test(
  'concurrent creators make one State Database: one creates it, the rest keep it, and it is in WAL mode',
  CASE,
  async (t) => {
    const commonDir = tempDirectory.tempDirectory(t, 'gg-record-');
    const started = creators.map(() => createInChild(commonDir));
    t.after(() => {
      for (const { child } of started) if (child.exitCode === null) child.kill();
    });
    // Eight Node start-ups spread over a while under load, so the creates start together once all have loaded.
    await Promise.all(started.map(({ ready }) => ready));
    for (const { go } of started) go();
    const exits = await Promise.all(started.map(({ exit }) => exit));
    assert.deepEqual(
      exits.map(({ code, err }) => ({ code, err })),
      creators.map(() => ({ code: 0, err: '' })),
      'every creator succeeds',
    );
    assert.deepEqual(
      exits.map(({ stdout }) => stdout.replace('ready\n', '')).sort(),
      ['created\n', 'kept\n', 'kept\n', 'kept\n', 'kept\n', 'kept\n', 'kept\n', 'kept\n'],
      'one creates it and the others keep it',
    );
    assert.deepEqual(readdirSync(join(commonDir, 'gg')), ['gg.db'], 'no creator leaves its temp file');
    assert.deepEqual(
      withDb(commonDir, (db) => ({
        mode: db.prepare('PRAGMA journal_mode').get()?.journal_mode,
        version: db.prepare('PRAGMA user_version').get()?.user_version,
      })),
      { mode: 'wal', version: stateDatabase.SCHEMA_VERSION },
    );
  },
);
