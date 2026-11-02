import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathKey } from './paths.ts';

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
    if (db.prepare('PRAGMA user_version').get().user_version !== DB_SCHEMA_VERSION)
      underOpenLock(lockPath, () => {
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
            CREATE TABLE check_results (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, tree TEXT NOT NULL, command TEXT NOT NULL,
              state TEXT NOT NULL, marker TEXT NOT NULL, output TEXT NOT NULL);
            CREATE INDEX check_results_key ON check_results (tree, command);
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

// The cursor of a Terminal: an end state or needs-human, with no Visit or Action left to run.
export const terminalCursor = (vertex) => ({ vertex, visit: null, action: null, recovery: 0, attempt: 1 });

// Every field the Execution Record will ever hold is declared here, null until set; save refuses any other key.
export function createExecution({ commonDir, ticket, epic = null, flow, configHash, run, worktree, branch, base }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    commonDir,
    execution: `${ticket}.${randomBytes(3).toString('hex')}`,
    ticket,
    epic,
    flow: flow.name,
    configHash,
    run,
    state: 'active',
    // Why the Execution reached its end state, kept beside the state (request 3.1).
    terminalReason: null,
    // How the Terminal classifies the stop: held, fault, abandoned, a run stop or a stop token (terminal.mjs).
    terminalStop: null,
    // A hold, abandonment or fault admission decided, until its Terminal reports it (run.mjs).
    admissionStop: null,
    cursor: { vertex: flow.entry, visit: 1, action: null, recovery: 0, attempt: 1 },
    visits: {},
    traversals: {},
    retries: {},
    sessions: {},
    // The Flow Attempts entered, which the Action Cap bounds (request 3.3).
    attempts: 0,
    // Each Action's outputs in Visit order, `{ vertex, visit, action, value }`, which later Vertices' inputs read.
    outputs: [],
    // gg's own: the Execution's first test commit, and the commit whose tests a Green Check holds immutable.
    testCommits: { first: null, baseline: null },
    history: [],
    worktree,
    branch,
    base,
    pr: null,
    // The open Approval Request: its Pending Instance and Approval Digest.
    approvalRequest: null,
    // The Configuration Snapshot the current Visit entered with.
    configurationSnapshot: null,
    // The current Visit's progress, saved so a restart routes what it already settled (interpreter.runVisit).
    visitState: null,
    activity: { busy: false, generation: 0 },
    heartbeat: null,
    // Intent, evidence and completion of every side effect (request 3.5).
    writeAheadLog: [],
  };
}

export function createEpicRecord({ commonDir, epic }) {
  return { schemaVersion: SCHEMA_VERSION, commonDir, epic, planDecision: null, approvalRequest: null };
}

const declaredFields = (kind) =>
  Object.keys(
    kind === 'ticket' ? createExecution({ flow: {}, ticket: 0 }) : createEpicRecord({ commonDir: null, epic: 0 }),
  );
const DECLARED = { ticket: declaredFields('ticket'), epic: declaredFields('epic') };

// A field no create function declares, or one a module deleted, would change the record's shape after the freeze (#23).
function assertDeclared(kind, record) {
  const declared = DECLARED[kind];
  const undeclared = Object.keys(record).filter((key) => !declared.includes(key));
  const missing = declared.filter((key) => !Object.hasOwn(record, key));
  if (undeclared.length) throw new Error(`the ${kind} record has undeclared fields ${undeclared.join(', ')}`);
  if (missing.length) throw new Error(`the ${kind} record is missing declared fields ${missing.join(', ')}`);
}

// With `writeEvent`, the row and the Event it inserts on the same connection commit together or not at all. It must be
// synchronous: nothing awaited may run inside the transaction. Any failed save is a RecordSaveError, after which the
// caller saves nothing more of the record.
async function saveRecord(record, writeEvent, beforeSave) {
  const { commonDir, ...data } = record;
  const kind = 'execution' in record ? 'ticket' : 'epic';
  const db = openDb(commonDir);
  const upsert = () => {
    assertDeclared(kind, record);
    beforeSave(record);
    db.prepare(
      'INSERT INTO records (kind, n, json) VALUES (?, ?, ?) ON CONFLICT(kind, n) DO UPDATE SET json = excluded.json',
    ).run(kind, kind === 'ticket' ? record.ticket : record.epic, JSON.stringify(data, null, 2) + '\n');
  };
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
  if (data?.schemaVersion !== SCHEMA_VERSION)
    throw new RecordCorruptError(file, `unknown schemaVersion ${data?.schemaVersion}`, json);
  // The version stays 1 until #23 freezes it, so a cursor from before Action ids is told apart by its shape, not misread.
  if (data.cursor && !Object.hasOwn(data.cursor, 'recovery')) {
    throw new RecordCorruptError(
      file,
      'its cursor has no Recovery Number, so it was written before Action ids (#111)',
      json,
    );
  }
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
  openDb(commonDir)
    .prepare('INSERT OR IGNORE INTO configs (hash, json, firstSeen) VALUES (?, ?, ?)')
    .run(hash, json, new Date().toISOString());
}

export function loadConfig(commonDir, hash) {
  const row = openDb(commonDir).prepare('SELECT json FROM configs WHERE hash = ?').get(hash);
  return row ? JSON.parse(row.json) : null;
}

// A `reuse: tree` command Check's result in this repository, keyed on the tree it checked and its resolved command line
// (L8, L13). Failing results are recorded too, but only a pass is ever reused.
export function saveCheckResult(commonDir, { tree, command, state, marker, output }) {
  openDb(commonDir)
    .prepare('INSERT INTO check_results (ts, tree, command, state, marker, output) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), tree, command, state, marker, output);
}

export const reusablePass = (commonDir, tree, command) =>
  openDb(commonDir)
    .prepare(
      "SELECT marker, output FROM check_results WHERE tree = ? AND command = ? AND state = 'passed' ORDER BY id DESC LIMIT 1",
    )
    .get(tree, command) ?? null;

// Every entry carries every field, so `payload` and `evidence` are null where its step has none.
const entryOf = (step, actionMarker, effect, { payload = null, evidence = null } = {}) => ({
  step,
  actionMarker,
  effect,
  payload,
  evidence,
  time: new Date().toISOString(),
});

function effectOf(record, actionMarker) {
  return record.writeAheadLog.find((e) => e.actionMarker === actionMarker && e.step === 'intent')?.effect ?? null;
}

// The State Database's writes. `beforeSave` sees each record about to be written, and `beforeAppend` each Event about to
// be inserted (events.eventLog), and either throws to fail that write, as a disk error would. The entry point passes
// neither; a test passes them to see or fail chosen writes.
export function stateDatabase({ beforeSave = () => {}, beforeAppend = () => {} } = {}) {
  const save = (record, writeEvent = null) => saveRecord(record, writeEvent, beforeSave);

  function append(record, entry, writeEvent) {
    record.writeAheadLog.push(entry);
    return save(record, writeEvent);
  }

  const intent = (record, actionMarker, effect, payload) =>
    append(record, entryOf('intent', actionMarker, effect, { payload }));

  const evidence = (record, actionMarker, evidence) =>
    append(record, entryOf('evidence', actionMarker, effectOf(record, actionMarker), { evidence }));

  // `evidence`, when given, is saved in the same write as the completion, and `event` commits with both.
  function complete(record, actionMarker, { evidence: found, event = null } = {}) {
    const effect = effectOf(record, actionMarker);
    if (found !== undefined) record.writeAheadLog.push(entryOf('evidence', actionMarker, effect, { evidence: found }));
    return append(record, entryOf('complete', actionMarker, effect), event);
  }

  return { save, intent, evidence, complete, beforeAppend };
}

// The real State Database, for callers that take no seam: this module is itself one, so it can stand for a `database`.
export const { save, intent, evidence, complete, beforeAppend } = stateDatabase();

// The evidence that proves a marker's effect landed. A failed effect saves evidence too (a label write that did not land
// saves { ok: false }), which proves nothing: that Action is reconciled and redone as if it had none.
export const proof = (record, actionMarker) =>
  record.writeAheadLog.findLast(
    (e) => e.actionMarker === actionMarker && e.step === 'evidence' && e.evidence?.ok !== false,
  );

export function openIntents(record) {
  const done = new Set(record.writeAheadLog.filter((e) => e.step === 'complete').map((e) => e.actionMarker));
  return record.writeAheadLog.filter((e) => e.step === 'intent' && !done.has(e.actionMarker));
}

// The evidence of the last commit gg made, or undefined before its first: the branch must still be at its sha.
export const lastCommit = (record) =>
  record.writeAheadLog.findLast((e) => e.step === 'evidence' && e.effect === 'commit' && e.evidence.sha);

// What a reference or template may name of a Visit (W2): its own outputs by Action id, and its `inputs`, where an absent
// input reads as nothing so a template renders it empty (T10).
export const visitScope = (record, { vertex, visit }) => ({
  ...Object.fromEntries(
    record.outputs.filter((o) => o.vertex === vertex && o.visit === visit).map((o) => [o.action, o.value]),
  ),
  inputs: Object.fromEntries(
    Object.entries(record.configurationSnapshot.inputs).map(([name, i]) => [name, i.absent ? undefined : i.value]),
  ),
});
