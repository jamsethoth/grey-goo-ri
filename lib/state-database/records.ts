// The records table: one row per Execution or Epic Record, keyed on its kind and number. lib/record.ts makes the row a
// record saves as, and lib/record-json.ts reads one back.
import type { DatabaseSync } from 'node:sqlite';
import type * as recordJson from '../record-json.ts';

type Kind = recordJson.RecordRow['kind'];

export function upsert(connection: DatabaseSync, { kind, n: recordNumber, json }: recordJson.RecordRow): void {
  connection
    .prepare(
      'INSERT INTO records (kind, n, json) VALUES (?, ?, ?) ON CONFLICT(kind, n) DO UPDATE SET json = excluded.json',
    )
    .run(kind, recordNumber, json);
}

// `body`'s writes on this connection commit together or not at all. It must be synchronous: nothing awaited may run
// inside the transaction.
export function inTransaction(connection: DatabaseSync, body: () => void): void {
  try {
    connection.exec('BEGIN IMMEDIATE');
    body();
    connection.exec('COMMIT');
  } catch (err) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw err;
  }
}

export const select = (connection: DatabaseSync, kind: Kind, recordNumber: number): recordJson.RecordRow | undefined =>
  connection.prepare('SELECT kind, n, json FROM records WHERE kind = ? AND n = ?').get(kind, recordNumber) as
    recordJson.RecordRow | undefined;

export const selectAll = (connection: DatabaseSync, kind: Kind): recordJson.RecordRow[] =>
  connection
    .prepare('SELECT kind, n, json FROM records WHERE kind = ? ORDER BY n')
    .all(kind) as unknown as recordJson.RecordRow[];

// Says whether a row was deleted.
export const remove = (connection: DatabaseSync, kind: Kind, recordNumber: number): boolean =>
  Number(connection.prepare('DELETE FROM records WHERE kind = ? AND n = ?').run(kind, recordNumber).changes) > 0;
