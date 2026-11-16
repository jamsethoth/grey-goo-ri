// The State Database's SQLite file, <git common dir>/gg/gg.db: its creation by gg init, one connection per repository,
// and the database a Run is handed (ADR 0019), every read and write a Run makes to it (#367). Its SQL lives in this
// directory, one module per table group (ADR 0009, ADR 0023).
import { existsSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as eventRead from '../event-read.ts';
import type * as events from '../events.ts';
import type * as jsonValue from '../json-value.ts';
import * as paths from '../paths.ts';
import * as record from '../record.ts';
import * as recordJson from '../record-json.ts';
import * as writeAhead from '../write-ahead.ts';
import * as checkResults from './check-results.ts';
import * as eventsTable from './events.ts';
import * as pinnedConfigurations from './pinned-configurations.ts';
import * as records from './records.ts';

export type { CheckResult } from './check-results.ts';

export const SCHEMA_VERSION = 1;
// SQLite's code for a file it cannot open.
const SQLITE_CANTOPEN = 14;

export const filePath = paths.stateDatabaseFile;
// One connection per directory however it is spelled, so close() finds it and Windows can remove the directory.
const connections = new Map<string, DatabaseSync>();

// A PRAGMA's value, read from the one row it returns.
const pragma = (connection: DatabaseSync, statement: string, column: string): unknown =>
  connection.prepare(`PRAGMA ${statement}`).get()?.[column];
// A thrown value's code, read with no assertion of its type: Node's `code`, or SQLite's `errcode`.
const codeOf = (err: unknown, field: 'code' | 'errcode'): unknown =>
  typeof err === 'object' && err !== null ? Reflect.get(err, field) : null;

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
    if (codeOf(err, 'code') === 'EEXIST') return false;
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
    if (codeOf(err, 'errcode') === SQLITE_CANTOPEN && !existsSync(path)) throw new Error(missingMessage(commonDir));
    throw err;
  }
  try {
    // SQLite's busy handler is not fair, so another process's burst of writes can hold a write off for seconds; gg's
    // write transactions are short and synchronous, so only a lock truly held this long fails (ADR 0015).
    connection.exec('PRAGMA busy_timeout = 60000');
    const version = pragma(connection, 'user_version', 'user_version');
    if (version !== SCHEMA_VERSION) throw new StateDatabaseVersionError(path, Number(version));
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

type AnyRecord = record.ExecutionRecord | record.EpicRecord;
type RecordKind = recordJson.RecordRow['kind'];
// Inserts the Event that commits with a record's row; see save.
type WriteEvent = (() => void) | null;
type Evidence = writeAhead.WriteAheadEntry['evidence'];

// Each kind's row reads back as its own record: the row's kind is the one asked for, and parseRow reads it by kind.
export function load(commonDir: string, kind: 'ticket', recordNumber: number): record.ExecutionRecord | null;
export function load(commonDir: string, kind: 'epic', recordNumber: number): record.EpicRecord | null;
export function load(commonDir: string, kind: RecordKind, recordNumber: number): AnyRecord | null {
  const row = records.select(open(commonDir), kind, recordNumber);
  return row ? recordJson.parseRow(commonDir, row) : null;
}

// A record's row deleted, as gg work abandon forgets a Ticket's position; its Events stay. Says whether one was.
export const removeRecord = (commonDir: string, kind: RecordKind, recordNumber: number): boolean =>
  records.remove(open(commonDir), kind, recordNumber);

// One corrupt record must not hide every other worktree's activity: it is reported, not fatal.
interface LoadAllOptions {
  onCorrupt?: (err: recordJson.RecordCorruptError) => void;
}
export function loadAll(commonDir: string, kind: 'ticket', options?: LoadAllOptions): record.ExecutionRecord[];
export function loadAll(commonDir: string, kind: 'epic', options?: LoadAllOptions): record.EpicRecord[];
export function loadAll(
  commonDir: string,
  kind: RecordKind,
  { onCorrupt = () => {} }: LoadAllOptions = {},
): AnyRecord[] {
  return records.selectAll(open(commonDir), kind).flatMap((row) => {
    try {
      return [recordJson.parseRow(commonDir, row)];
    } catch (err) {
      if (!(err instanceof recordJson.RecordCorruptError)) throw err;
      onCorrupt(err);
      return [];
    }
  });
}

type Refused = (err: eventRead.EventCorruptError) => void;

export const readEvents = (commonDir: string): events.Event[] =>
  eventRead.checkedRows(eventsTable.all(open(commonDir)));

// One Execution's Events, in the order they were appended.
export const executionEvents = (commonDir: string, execution: string, onRefused?: Refused): events.Event[] =>
  eventRead.checkedRows(eventsTable.ofExecution(open(commonDir), execution), onRefused);

// `execution`'s Events, read from every row that may be its own (eventsTable.naming).
export const rowsNaming = (commonDir: string, execution: string, onRefused: Refused): events.Event[] =>
  eventRead.ofExecution(eventsTable.naming(open(commonDir), execution), execution, onRefused);

// An Execution's Terminal has landed once a ticket_end of it passes the check. A refused one does not count, so the
// next Run finishes the report again, and that report's run-stop read names the row in the log.
export const hasTicketEnd = (commonDir: string, execution: string): boolean =>
  eventRead.checkedRows(eventsTable.ticketEnds(open(commonDir), execution), () => {}).length > 0;

export const savePinnedConfiguration = <Pinned>(
  commonDir: string,
  hash: string,
  pinned: Pinned & NoInfer<jsonValue.JsonChecked<Pinned>>,
): void => pinnedConfigurations.save<Pinned>(open(commonDir), hash, pinned);

export const loadPinnedConfiguration = (commonDir: string, hash: string): unknown =>
  pinnedConfigurations.load(open(commonDir), hash);

export const saveCheckResult = (commonDir: string, result: checkResults.CheckResult): void =>
  checkResults.save(open(commonDir), result);

export const reusablePass = (
  commonDir: string,
  tree: string,
  command: string,
): Pick<checkResults.CheckResult, 'marker' | 'output'> | null =>
  checkResults.reusablePass(open(commonDir), tree, command);

// The reads and writes no hook sees.
const UNHOOKED = {
  load,
  loadAll,
  removeRecord,
  readEvents,
  executionEvents,
  rowsNaming,
  hasTicketEnd,
  savePinnedConfiguration,
  loadPinnedConfiguration,
  saveCheckResult,
  reusablePass,
};

// The database a Run is handed (ADR 0019): every read and write it makes to the State Database. `beforeSave` sees each
// record about to be written, and `beforeAppend` each Event about to be inserted, and either throws to fail that
// write, as a disk error would. The entry point passes neither; a test passes them to see or fail chosen writes, and
// replaces a read by spreading the database with that one method changed.
export function createStateDatabase({
  beforeSave = () => {},
  beforeAppend = () => {},
}: {
  beforeSave?: (record: AnyRecord) => void;
  beforeAppend?: (event: events.Event) => void;
} = {}) {
  // With `writeEvent`, the row and the Event it inserts on the same connection commit together or not at all. Any
  // failed save is a RecordSaveError, after which the caller saves nothing more of the record.
  function save(saved: AnyRecord, writeEvent: WriteEvent = null): void {
    const connection = open(saved.commonDir);
    const upsert = () => records.upsert(connection, record.rowOf(saved, beforeSave));
    try {
      if (writeEvent)
        records.inTransaction(connection, () => {
          upsert();
          writeEvent();
        });
      else upsert();
    } catch (err) {
      throw new record.RecordSaveError(err);
    }
  }

  function append(saved: record.ExecutionRecord, entry: writeAhead.WriteAheadEntry, writeEvent?: WriteEvent) {
    saved.writeAheadLog.push(entry);
    return save(saved, writeEvent);
  }

  const intent = (saved: record.ExecutionRecord, actionMarker: string, effect: string, payload: writeAhead.Payload) =>
    append(saved, writeAhead.entryOf('intent', actionMarker, effect, { payload }));

  const evidence = (saved: record.ExecutionRecord, actionMarker: string, found: Evidence) =>
    append(
      saved,
      writeAhead.entryOf('evidence', actionMarker, writeAhead.effectOf(saved, actionMarker), { evidence: found }),
    );

  // `evidence`, when given, is saved in the same write as the completion, and `event` commits with both.
  function complete(
    saved: record.ExecutionRecord,
    actionMarker: string,
    { evidence: found, event = null }: { evidence?: Evidence; event?: WriteEvent } = {},
  ) {
    const effect = writeAhead.effectOf(saved, actionMarker);
    if (found !== undefined)
      saved.writeAheadLog.push(writeAhead.entryOf('evidence', actionMarker, effect, { evidence: found }));
    return append(saved, writeAhead.entryOf('complete', actionMarker, effect), event);
  }

  function appendEvent(commonDir: string, event: events.Event): void {
    beforeAppend(event);
    eventsTable.insert(open(commonDir), event);
  }

  return { save, intent, evidence, complete, appendEvent, ...UNHOOKED };
}

// The database the entry point builds and passes down as `database` (ADR 0019).
export type StateDatabase = ReturnType<typeof createStateDatabase>;

// The real State Database, for callers that take no seam: this module is itself one, so it can stand for a `database`.
export const { save, intent, evidence, complete, appendEvent } = createStateDatabase();
