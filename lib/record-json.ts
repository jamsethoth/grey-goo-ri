// A record's row in the State Database: the JSON each record kind saves, the Execution Record's Map conversion both
// ways, and the parse that tells a corrupt row from a record. lib/record.ts re-exports what its callers use.

import type * as record from './record.ts';
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

// The current Visit's progress as its row saves it, the Check Maps as keyed objects.
export type VisitStateJson = Omit<visit.VisitState, 'runs' | 'checks'> & {
  runs: Record<string, visit.CheckRun>;
  checks: Record<string, visit.CheckSignal>;
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

export function parseRow<Saved extends record.ExecutionRecord | record.EpicRecord>(
  commonDir: string,
  { kind, n: recordNumber, json }: RecordRow,
): Saved {
  const file = `${stateDatabase.filePath(commonDir)}#${kind}-${recordNumber}`;
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new RecordCorruptError(file, (err as Error).message, json);
  }
  if (data?.schemaVersion !== SCHEMA_VERSION)
    throw new RecordCorruptError(file, `unknown schemaVersion ${data?.schemaVersion}`, json);
  // The version stays 1 until #23, so a cursor from before Action ids is told apart by its shape, not misread.
  if (data.cursor && !Object.hasOwn(data.cursor, 'recovery')) {
    throw new RecordCorruptError(
      file,
      'its cursor has no Recovery Number, so it was written before Action ids (#111)',
      json,
    );
  }
  // The counts kept as Maps are saved as objects (#174); anything else makes the row corrupt, not a TypeError.
  const objects = (holder: Record<string, unknown> | null, keys: string[]) => {
    for (const key of holder ? keys : []) {
      const saved = holder![key];
      if (!saved || typeof saved !== 'object' || Array.isArray(saved))
        throw new RecordCorruptError(file, `its ${key} is not an object`, json);
    }
  };
  if (kind === 'epic') return { ...data, commonDir };
  objects(data, ['visits', 'traversals']);
  objects(data.visitState, ['runs', 'checks']);
  return fromJson(data, commonDir) as Saved;
}
