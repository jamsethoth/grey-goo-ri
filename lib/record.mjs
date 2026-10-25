import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathKey } from './paths.mjs';

const SCHEMA_VERSION = 1;
export const DB_SCHEMA_VERSION = 1;

export class RecordCorruptError extends Error {
  constructor(file, reason, raw) {
    super(`corrupt record ${file}: ${reason}`);
    this.name = 'RecordCorruptError';
    this.file = file;
    this.raw = raw;
  }
}

// A record transition whose Event failed was rolled back, but the record object still holds it: saving that object
// again would publish the transition without its Event, so it is rethrown and nothing more of it is saved.
export class RecordSaveError extends Error {
  constructor(cause) {
    super(`the record and its Event were not saved: ${cause?.message ?? cause}`, { cause });
    this.name = 'RecordSaveError';
  }
}

const dbPath = (commonDir) => join(commonDir, 'gg', 'gg.db');
const connections = new Map();

// Two connections switching a new gg.db to WAL can get SQLITE_BUSY without the busy handler, which SQLite skips on a
// SHARED to RESERVED upgrade to avoid deadlock. BEGIN EXCLUSIVE from no lock does wait on it, so a lock file
// serialises the switch (ADR 0009). WAL is stored in the file, so a database already in WAL skips the lock.
function underOpenLock(lockPath, fn) {
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec('PRAGMA busy_timeout = 5000');
    lock.exec('BEGIN EXCLUSIVE');
    return fn();
  } finally {
    lock.close();
  }
}

function switchToWal(db, path, lockPath) {
  if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') return;
  underOpenLock(lockPath, () => {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    if (mode !== 'wal') throw new Error(`${path} stayed in ${mode} journal mode`);
  });
}

export function openDb(dir) {
  // One connection per directory however it is spelled, so close() finds it and Windows can remove the directory.
  const commonDir = resolve(dir);
  const key = pathKey(commonDir);
  let db = connections.get(key);
  if (db) return db;
  mkdirSync(join(commonDir, 'gg', 'locks'), { recursive: true });
  const path = dbPath(commonDir);
  db = new DatabaseSync(path);
  try {
    // SQLite's busy handler is not fair, so another process's burst of writes can hold a write off for seconds; gg's
    // write transactions are short and synchronous, so only a lock truly held this long fails (ADR 0015).
    db.exec('PRAGMA busy_timeout = 60000');
    const lockPath = join(commonDir, 'gg', 'locks', 'open.db');
    switchToWal(db, path, lockPath);
    // An existing schema is read without the write lock, so another process's writes cannot hold this open past
    // busy_timeout. A database without it is created under the open lock: the first opener creates the tables and the
    // others then see its version, so none takes IMMEDIATE while the first is already saving records.
    if (db.prepare('PRAGMA user_version').get().user_version !== DB_SCHEMA_VERSION) underOpenLock(lockPath, () => {
      if (db.prepare('PRAGMA user_version').get().user_version === DB_SCHEMA_VERSION) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version === 0) {
          db.exec(`
            CREATE TABLE records (kind TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, n));
            CREATE TABLE configs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, firstSeen TEXT NOT NULL);
            CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, run TEXT, execution TEXT,
              ticket INTEGER, json TEXT NOT NULL);
            CREATE INDEX events_run ON events (run);
            CREATE INDEX events_execution ON events (execution);
            CREATE INDEX events_ticket ON events (ticket);
            CREATE INDEX events_ts ON events (ts);
            PRAGMA user_version = ${DB_SCHEMA_VERSION};
          `);
        } else if (version !== DB_SCHEMA_VERSION) {
          throw new Error(`${path} has database version ${version}; this gg reads version ${DB_SCHEMA_VERSION}`);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
  } catch (err) {
    db.close();
    throw err;
  }
  connections.set(key, db);
  return db;
}

// Windows cannot remove a directory holding an open database, so tests close it before cleanup.
export function close(commonDir) {
  const key = pathKey(commonDir);
  const db = connections.get(key);
  connections.delete(key);
  db?.close();
}

export function createExecution({ commonDir, ticket, epic, flow, configHash, run, worktree, branch, base }) {
  return {
    schemaVersion: SCHEMA_VERSION, commonDir,
    execution: `${ticket}.${randomBytes(3).toString('hex')}`,
    ticket, epic, flow: flow.name, configHash, run,
    state: 'active',
    cursor: { vertex: flow.entry, visit: 1, phase: null, ordinal: 0, attempt: 1 },
    visits: {}, traversals: {}, retries: {}, sessions: {},
    outputs: { red: null, implementation: [], reviews: [] },
    history: [], worktree, branch, base, pr: null, pending: null, snapshot: null,
    activity: { busy: false, generation: 0 }, heartbeat: null,
    log: [],
  };
}

export function createEpicRecord({ commonDir, epic }) {
  return { schemaVersion: SCHEMA_VERSION, commonDir, epic, approval: null, pending: null };
}

// With `writeEvent`, the row and the Event it inserts on the same connection commit together or not at all. It must be
// synchronous: nothing awaited may run inside the transaction. Any failed save is a RecordSaveError, after which the
// caller saves nothing more of the record.
export async function save(record, writeEvent = null) {
  const { commonDir, ...data } = record;
  const kind = 'execution' in record ? 'ticket' : 'epic';
  const db = openDb(commonDir);
  const upsert = () => db
    .prepare('INSERT INTO records (kind, n, json) VALUES (?, ?, ?) ON CONFLICT(kind, n) DO UPDATE SET json = excluded.json')
    .run(kind, kind === 'ticket' ? record.ticket : record.epic, JSON.stringify(data, null, 2) + '\n');
  if (!writeEvent) {
    try {
      return void upsert();
    } catch (err) {
      throw new RecordSaveError(err);
    }
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    upsert();
    writeEvent();
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw new RecordSaveError(err);
  }
}

function parseRow(commonDir, { kind, n, json }) {
  const file = `${dbPath(commonDir)}#${kind}-${n}`;
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new RecordCorruptError(file, err.message, json);
  }
  if (data?.schemaVersion !== SCHEMA_VERSION) throw new RecordCorruptError(file, `unknown schemaVersion ${data?.schemaVersion}`, json);
  return { ...data, commonDir };
}

export async function load(commonDir, kind, n) {
  const row = openDb(commonDir).prepare('SELECT kind, n, json FROM records WHERE kind = ? AND n = ?').get(kind, n);
  return row ? parseRow(commonDir, row) : null;
}

// One corrupt record must not hide every other worktree's activity: it is reported, not fatal.
export async function loadAll(commonDir, kind, { onCorrupt = () => {} } = {}) {
  const rows = openDb(commonDir).prepare('SELECT kind, n, json FROM records WHERE kind = ? ORDER BY n').all(kind);
  return rows.flatMap((row) => {
    try {
      return [parseRow(commonDir, row)];
    } catch (err) {
      if (!(err instanceof RecordCorruptError)) throw err;
      onCorrupt(err);
      return [];
    }
  });
}

export function saveConfig(commonDir, hash, json) {
  openDb(commonDir).prepare('INSERT OR IGNORE INTO configs (hash, json, firstSeen) VALUES (?, ?, ?)')
    .run(hash, json, new Date().toISOString());
}

export function loadConfig(commonDir, hash) {
  const row = openDb(commonDir).prepare('SELECT json FROM configs WHERE hash = ?').get(hash);
  return row ? JSON.parse(row.json) : null;
}

function append(record, marker, step, action, fields, writeEvent) {
  record.log.push({ step, marker, action, ...fields, ts: new Date().toISOString() });
  return save(record, writeEvent);
}

function actionOf(record, marker) {
  return record.log.find((e) => e.marker === marker && e.step === 'intent')?.action ?? null;
}

export function intent(record, marker, action, payload) {
  return append(record, marker, 'intent', action, { payload });
}

export function evidence(record, marker, evidence) {
  return append(record, marker, 'evidence', actionOf(record, marker), { evidence });
}

// `evidence`, when given, is saved in the same write as the completion, and `event` commits with both.
export function complete(record, marker, { evidence: found, event = null } = {}) {
  const action = actionOf(record, marker);
  if (found !== undefined) record.log.push({ step: 'evidence', marker, action, evidence: found, ts: new Date().toISOString() });
  return append(record, marker, 'complete', action, {}, event);
}

// The evidence that proves a marker's effect landed. A failed effect saves evidence too (a label write that did not land
// saves { ok: false }), which proves nothing: that Action is reconciled and redone as if it had none.
export const proof = (record, marker) =>
  record.log.findLast((e) => e.marker === marker && e.step === 'evidence' && e.evidence?.ok !== false);

export function openIntents(record) {
  const done = new Set(record.log.filter((e) => e.step === 'complete').map((e) => e.marker));
  return record.log.filter((e) => e.step === 'intent' && !done.has(e.marker));
}

// The evidence of the last commit gg made, or undefined before its first: the branch must still be at its sha.
export const lastCommit = (record) => record.log.findLast((e) => e.step === 'evidence' && e.action === 'commit' && e.evidence.sha);
