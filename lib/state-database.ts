// The State Database's SQLite file, <git common dir>/gg/gg.db: one connection per repository, its WAL mode and schema,
// and the tables beside the records and Events: the Pinned Configurations and the reusable Check results (ADR 0009).
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import * as jsonValue from './json-value.ts';
import * as paths from './paths.ts';

export const SCHEMA_VERSION = 1;

export const filePath = (commonDir: string): string => join(commonDir, 'gg', 'gg.db');
// One connection per directory however it is spelled, so close() finds it and Windows can remove the directory.
const connections = new Map<string, DatabaseSync>();

// A PRAGMA's value, read from the one row it returns.
const pragma = (connection: DatabaseSync, statement: string, column: string): unknown =>
  (connection.prepare(`PRAGMA ${statement}`).get() as Record<string, unknown>)[column];

// Two connections switching a new gg.db to WAL can get SQLITE_BUSY without the busy handler, which SQLite skips on a
// SHARED to RESERVED upgrade to avoid deadlock. BEGIN EXCLUSIVE from no lock does wait on it, so a lock file
// serialises the switch (ADR 0009). WAL is stored in the file, so a database already in WAL skips the lock.
function underOpenLock<T>(lockPath: string, work: () => T): T {
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec('PRAGMA busy_timeout = 5000');
    lock.exec('BEGIN EXCLUSIVE');
    return work();
  } finally {
    lock.close();
  }
}

function switchToWal(connection: DatabaseSync, path: string, lockPath: string): void {
  if (pragma(connection, 'journal_mode', 'journal_mode') === 'wal') return;
  underOpenLock(lockPath, () => {
    const mode = pragma(connection, 'journal_mode = WAL', 'journal_mode');
    if (mode !== 'wal') throw new Error(`${path} stayed in ${mode} journal mode`);
  });
}

// The first opener creates the tables under the open lock; the others then see its version.
function createSchema(connection: DatabaseSync, path: string): void {
  if (pragma(connection, 'user_version', 'user_version') === SCHEMA_VERSION) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    const version = pragma(connection, 'user_version', 'user_version');
    if (version === 0) {
      connection.exec(`
      CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n));
      CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT,
        ticket INTEGER, json TEXT NOT NULL);
      CREATE INDEX events_run ON events (run);
      CREATE INDEX events_execution ON events (execution);
      CREATE INDEX events_ticket ON events (ticket);
      CREATE INDEX events_ts ON events (ts);
      CREATE TABLE check_results (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, tree TEXT NOT NULL, command TEXT NOT NULL,
        state TEXT NOT NULL, marker TEXT NOT NULL, output TEXT NOT NULL);
      CREATE INDEX check_results_key ON check_results (tree, command);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(`${path} has database version ${version}; this gg reads version ${SCHEMA_VERSION}`);
    }
    connection.exec('COMMIT');
  } catch (err) {
    connection.exec('ROLLBACK');
    throw err;
  }
}

export function open(directory: string): DatabaseSync {
  const commonDir = resolve(directory);
  const key = paths.pathKey(commonDir);
  const known = connections.get(key);
  if (known) return known;
  mkdirSync(join(commonDir, 'gg', 'locks'), { recursive: true });
  const path = filePath(commonDir);
  const connection = new DatabaseSync(path);
  try {
    // SQLite's busy handler is not fair, so another process's burst of writes can hold a write off for seconds; gg's
    // write transactions are short and synchronous, so only a lock truly held this long fails (ADR 0015).
    connection.exec('PRAGMA busy_timeout = 60000');
    const lockPath = join(commonDir, 'gg', 'locks', 'open.db');
    switchToWal(connection, path, lockPath);
    // An existing schema is read without the write lock, so another process's writes cannot hold this open past
    // busy_timeout. A database without it is created under the open lock: the first opener creates the tables and the
    // others then see its version, so none takes IMMEDIATE while the first is already saving records.
    if (pragma(connection, 'user_version', 'user_version') !== SCHEMA_VERSION)
      underOpenLock(lockPath, () => createSchema(connection, path));
  } catch (err) {
    connection.close();
    throw err;
  }
  connections.set(key, connection);
  return connection;
}

// Windows cannot remove a directory holding an open database, so tests close it before cleanup.
export function close(commonDir: string): void {
  const key = paths.pathKey(commonDir);
  const connection = connections.get(key);
  connections.delete(key);
  connection?.close();
}

export function savePinnedConfiguration<Pinned>(
  commonDir: string,
  hash: string,
  pinned: Pinned & jsonValue.JsonChecked<Pinned>,
): void {
  open(commonDir)
    .prepare('INSERT OR IGNORE INTO configs (hash, json, firstSeen) VALUES (?, ?, ?)')
    .run(hash, jsonValue.text(pinned, 'the Pinned Configuration'), new Date().toISOString());
}

export function loadPinnedConfiguration(commonDir: string, hash: string): unknown {
  const row = open(commonDir).prepare('SELECT json FROM configs WHERE hash = ?').get(hash);
  return row ? JSON.parse(row.json as string) : null;
}

// A `reuse: tree` command Check's result: the tree it checked, its resolved command line, its state, the Action Marker
// of the Attempt that ran it, and its output.
export interface CheckResult {
  tree: string;
  command: string;
  state: string;
  marker: string;
  output: string;
}

// A `reuse: tree` command Check's result in this repository, keyed on the tree it checked and its resolved command line
// (L8, L13). Failing results are recorded too, but only a pass is ever reused.
export function saveCheckResult(commonDir: string, { tree, command, state, marker, output }: CheckResult): void {
  open(commonDir)
    .prepare('INSERT INTO check_results (ts, tree, command, state, marker, output) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), tree, command, state, marker, output);
}

export const reusablePass = (
  commonDir: string,
  tree: string,
  command: string,
): Pick<CheckResult, 'marker' | 'output'> | null =>
  (open(commonDir)
    .prepare(
      'SELECT marker, output FROM check_results WHERE tree = ? AND command = ? ' +
        "AND state = 'passed' ORDER BY id DESC LIMIT 1",
    )
    .get(tree, command) as Pick<CheckResult, 'marker' | 'output'> | undefined) ?? null;
