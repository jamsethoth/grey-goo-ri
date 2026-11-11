// The State Database's SQLite file, <git common dir>/gg/gg.db: its creation by gg init, one connection per repository,
// and the tables beside the records and Events: the Pinned Configurations and the reusable Check results (ADR 0009,
// ADR 0023).
import { existsSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as paths from './paths.ts';

export const SCHEMA_VERSION = 1;
// SQLite's code for a file it cannot open.
const SQLITE_CANTOPEN = 14;

export const filePath = (commonDir: string): string => join(commonDir, 'gg', 'gg.db');
// One connection per directory however it is spelled, so close() finds it and Windows can remove the directory.
const connections = new Map<string, DatabaseSync>();

// A PRAGMA's value, read from the one row it returns.
const pragma = (connection: DatabaseSync, statement: string, column: string): unknown =>
  (connection.prepare(`PRAGMA ${statement}`).get() as Record<string, unknown>)[column];

const SCHEMA = `
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
`;

// The words every command but gg init gives for a repository without a State Database.
export const missingMessage = (commonDir: string): string => `no State Database at ${filePath(commonDir)}: run gg init`;

// A gg.db whose version this gg does not read: one written by a newer gg, or one left without its tables.
export class StateDatabaseVersionError extends Error {
  name = 'StateDatabaseVersionError';
  version: number;
  constructor(path: string, version: number) {
    super(`${path} has database version ${version}; this gg reads version ${SCHEMA_VERSION}`);
    this.version = version;
  }
}

// gg init's creation, safe while another gg init creates it too, with no lock (ADR 0023): the database is built whole
// in a temp file of its own, already in WAL mode, which is stored in the file, with its tables and version, then
// hard-linked to gg.db. The link fails if gg.db exists, so no database is ever recreated, and no opener sees one half
// built. Says whether this call created it.
export function create(directory: string): boolean {
  const path = filePath(resolve(directory));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.init-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const building = new DatabaseSync(temp);
    try {
      const mode = pragma(building, 'journal_mode = WAL', 'journal_mode');
      if (mode !== 'wal') throw new Error(`${temp} stayed in ${mode} journal mode`);
      building.exec(SCHEMA);
    } finally {
      building.close();
    }
    linkSync(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(temp, { force: true });
  }
}

// Opens the State Database gg init created, never creating one: mode=rw fails on a missing file where SQLite would
// otherwise make an empty one.
export function open(directory: string): DatabaseSync {
  const commonDir = resolve(directory);
  const key = paths.pathKey(commonDir);
  const known = connections.get(key);
  if (known) return known;
  const path = filePath(commonDir);
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'rw');
  let connection: DatabaseSync;
  try {
    connection = new DatabaseSync(url);
  } catch (err) {
    // SQLite says only that it cannot open a missing file, so its error is kept for any other cause.
    if ((err as { errcode?: number }).errcode === SQLITE_CANTOPEN && !existsSync(path))
      throw new Error(missingMessage(commonDir));
    throw err;
  }
  try {
    // SQLite's busy handler is not fair, so another process's burst of writes can hold a write off for seconds; gg's
    // write transactions are short and synchronous, so only a lock truly held this long fails (ADR 0015).
    connection.exec('PRAGMA busy_timeout = 60000');
    const version = pragma(connection, 'user_version', 'user_version') as number;
    if (version !== SCHEMA_VERSION) throw new StateDatabaseVersionError(path, version);
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

export function savePinnedConfiguration(commonDir: string, hash: string, json: string): void {
  open(commonDir)
    .prepare('INSERT OR IGNORE INTO configs (hash, json, firstSeen) VALUES (?, ?, ?)')
    .run(hash, json, new Date().toISOString());
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
