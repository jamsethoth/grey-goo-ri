// The events table: each Event's row, its indexed columns copied from its fields, and the reads by those columns.
// lib/event-read.ts checks each row read back against its Event's declaration.
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type * as events from '../events.ts';
import * as jsonValue from '../json-value.ts';

export type EventRow = Record<string, SQLOutputValue>;

// node:sqlite throws for the whole read on an integer beyond 2^53, before any check, so a number outside the safe range
// in id or ticket is read as text: the check then refuses its row by name.
const safeNumber = (column: string) =>
  `CASE WHEN typeof(${column}) IN ('integer', 'real') AND ${column} NOT BETWEEN -9007199254740991 AND ` +
  `9007199254740991 THEN CAST(${column} AS TEXT) ELSE ${column} END AS ${column}`;
const SELECT = `SELECT ${safeNumber('id')}, type, run, execution, ${safeNumber('ticket')}, json FROM events`;

export function insert(connection: DatabaseSync, event: events.Event): void {
  // Not every Event carries the indexed columns' fields.
  const columns = event as Partial<Record<'run' | 'execution' | 'ticket', string | number | null>>;
  connection
    .prepare('INSERT INTO events (ts, type, run, execution, ticket, json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      event.time,
      event.type,
      columns.run ?? null,
      columns.execution ?? null,
      columns.ticket ?? null,
      jsonValue.text(event, `the ${event.type} Event`),
    );
}

export const all = (connection: DatabaseSync): EventRow[] => connection.prepare(`${SELECT} ORDER BY events.id`).all();

export const ofExecution = (connection: DatabaseSync, execution: string): EventRow[] =>
  connection.prepare(`${SELECT} WHERE execution = ? ORDER BY events.id`).all(execution);

// Every row that may be `execution`'s: by its execution column, or naming it in its JSON, since a refused row's
// columns may be what is corrupt.
export const naming = (connection: DatabaseSync, execution: string): EventRow[] =>
  connection
    .prepare(`${SELECT} WHERE execution = ? OR instr(json, ?) > 0 ORDER BY events.id`)
    .all(execution, JSON.stringify(execution));

export const ticketEnds = (connection: DatabaseSync, execution: string): EventRow[] =>
  connection.prepare(`${SELECT} WHERE execution = ? AND type = 'ticket_end' ORDER BY events.id`).all(execution);
