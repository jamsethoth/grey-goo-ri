// A record's row in the State Database: the JSON each record kind saves, the Execution Record's Map conversion both
// ways, and the parse that tells a corrupt row from a record. lib/record.ts re-exports what its callers use.

import type * as commandCleanup from './command-cleanup.ts';
import type * as record from './record.ts';
import * as recordRead from './record-read.ts';
import * as referencePaths from './reference-paths.ts';
import * as stateDatabase from './state-database.ts';
import type * as visit from './visit.ts';

export const SCHEMA_VERSION = 1;

export class RecordCorruptError extends Error {
  declare file: string;
  declare raw: string;
  constructor(file: string, reason: string, raw: string) {
    super(`corrupt record ${file}: ${reason}`);
    this.name = 'RecordCorruptError';
    this.file = file;
    this.raw = raw;
  }
}

// The current Visit's progress as its row saves it: the Check Maps as keyed objects, and the cleanup report without
// the job handle no save writes.
export type VisitStateJson = Omit<visit.VisitState, 'runs' | 'checks' | 'unconfirmedCleanup'> & {
  runs: Record<string, visit.CheckRun>;
  checks: Record<string, visit.CheckSignal>;
  unconfirmedCleanup: commandCleanup.SavedCleanup | null;
};

// The Execution Record as its row saves it: no commonDir, which is where the row is, and every Map a keyed object.
export type ExecutionRecordJson = Omit<record.ExecutionRecord, 'commonDir' | 'visits' | 'traversals' | 'visitState'> & {
  visits: Record<string, number>;
  traversals: Record<string, number>;
  visitState: VisitStateJson | null;
};

// The record's only Map conversion. Object.fromEntries defines own keys, so a name such as __proto__ stays data, and a
// spread over an existing key keeps the key's place, so the row keeps the record's field order.
export function toJson(executionRecord: record.ExecutionRecord): ExecutionRecordJson {
  const { commonDir, ...data } = executionRecord;
  const { visitState } = data;
  return {
    ...data,
    visits: Object.fromEntries(data.visits),
    traversals: Object.fromEntries(data.traversals),
    visitState: visitState && {
      ...visitState,
      runs: Object.fromEntries(visitState.runs),
      checks: Object.fromEntries(visitState.checks),
    },
  };
}

// JSON.parse gives only own keys, so every name revived is one the row holds. The row's shape is parseRow's to check.
export function fromJson(json: ExecutionRecordJson, commonDir: string): record.ExecutionRecord {
  const { visitState } = json;
  return {
    ...json,
    visits: new Map(Object.entries(json.visits)),
    traversals: new Map(Object.entries(json.traversals)),
    visitState: visitState && {
      ...visitState,
      runs: new Map(Object.entries(visitState.runs)),
      checks: new Map(Object.entries(visitState.checks)),
    },
    commonDir,
  };
}

// The Epic Record as its row saves it: it holds no Map, so only commonDir is left out.
export const epicJson = ({ commonDir, ...row }: record.EpicRecord) => row;

export interface RecordRow {
  kind: 'ticket' | 'epic';
  n: number;
  json: string;
}

// The row read whole (lib/record-read.ts): a field of the wrong type, a key left out or one its type does not
// declare is a corrupt row naming the field's path, never a value typed by assumption (#357).
export function parseRow(
  commonDir: string,
  { kind, n: recordNumber, json }: RecordRow,
): record.ExecutionRecord | record.EpicRecord {
  const file = `${stateDatabase.filePath(commonDir)}#${kind}-${recordNumber}`;
  const corrupt = (reason: string) => new RecordCorruptError(file, reason, json);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw corrupt(err instanceof Error ? err.message : String(err));
  }
  const version = referencePaths.isRecord(data) ? data.schemaVersion : undefined;
  if (!referencePaths.isRecord(data) || version !== SCHEMA_VERSION)
    throw corrupt(`unknown schemaVersion ${String(version)}`);
  // The version stays 1 until #23, so a cursor from before Action ids is told apart by its shape, not misread.
  if (referencePaths.isRecord(data.cursor) && !Object.hasOwn(data.cursor, 'recovery'))
    throw corrupt('its cursor has no Recovery Number, so it was written before Action ids (#111)');
  try {
    if (kind === 'epic') return { ...recordRead.epicRecord({ value: data, path: '' }), commonDir };
    return fromJson(recordRead.executionRecord({ value: data, path: '' }), commonDir);
  } catch (err) {
    if (err instanceof recordRead.RowFieldError) throw corrupt(err.message);
    throw err;
  }
}
