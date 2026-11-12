// The event log read back: each row of the events table parsed and checked against the declaration its Event was
// written from (lib/events.ts), so a corrupt row, or one another gg version wrote, is refused by name, never read as an
// Event. RecordCorruptError is the precedent for a record's row.
import type { SQLOutputValue } from 'node:sqlite';
import * as events from './events.ts';
import * as stateDatabase from './state-database.ts';

export class EventCorruptError extends Error {
  declare id: number;
  declare raw: string;
  constructor(id: number, type: string, reason: string, raw: string) {
    super(`corrupt event ${id} (${type}): ${reason}`);
    this.name = 'EventCorruptError';
    this.id = id;
    this.raw = raw;
  }
}

type EventRow = Record<string, SQLOutputValue>;

const SELECT = 'SELECT id, type, run, execution, ticket, json FROM events';
// eventLog copies these fields to indexed columns, and a filtered read trusts the column, so each must equal its field.
const COLUMNS = ['type', 'run', 'execution', 'ticket'];
// The fields gg's own readers use hold a string or null (#350); the declaration gives names, not value types.
const READ_FIELDS = ['failureClass', 'execution', 'run'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The fields an Event of this type declares after its header. A saved Event holds every one, an optional field null.
function declaredFields(type: unknown, agent: unknown): string[] {
  if (type === 'action') {
    if (typeof agent !== 'boolean') throw new Error('its agent is not true or false');
    return ['agent', ...Object.keys(events.ACTION), ...(agent ? Object.keys(events.AGENT) : [])];
  }
  // An own key only: `toString` would otherwise find Object.prototype's member and pass as a type.
  const shape = Object.entries(events.LIFECYCLE).find(([name]) => name === type)?.[1];
  if (!shape) throw new Error(`unknown type ${String(type)}`);
  return Object.keys(shape);
}

function checkFields(fields: Record<string, unknown>, declared: Set<string>): void {
  for (const key of declared) if (!Object.hasOwn(fields, key)) throw new Error(`missing field ${key}`);
  for (const key of Object.keys(fields)) if (!declared.has(key)) throw new Error(`undeclared field ${key}`);
  for (const key of READ_FIELDS) {
    const value = fields[key];
    if (declared.has(key) && value !== null && typeof value !== 'string')
      throw new Error(`its ${key} is not a string or null`);
  }
}

// What a row must hold to be read as an Event. tsc cannot follow a check over declared names, so the narrowing is
// this assertion function's, and its body is the whole check.
function assertEvent(value: unknown, row: EventRow): asserts value is events.Event {
  if (!isObject(value)) throw new Error('its JSON is not an object');
  const { schemaVersion, time, ...fields } = value;
  if (schemaVersion !== 2) throw new Error(`unknown schemaVersion ${String(schemaVersion)}`);
  if (typeof time !== 'string') throw new Error('its time is not a string');
  const { type, ...body } = fields;
  checkFields(body, new Set(declaredFields(type, fields.agent)));
  for (const column of COLUMNS) {
    const saved = fields[column] ?? null;
    if (row[column] !== saved)
      throw new Error(
        `its ${column} column is ${JSON.stringify(row[column])} but its JSON holds ${JSON.stringify(saved)}`,
      );
  }
}

function checked(row: EventRow): events.Event {
  const raw = String(row.json);
  const refused = (reason: string) => new EventCorruptError(Number(row.id), String(row.type), reason, raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw refused(`its JSON does not parse: ${(err as Error).message}`);
  }
  try {
    assertEvent(value, row);
    return value;
  } catch (err) {
    throw refused((err as Error).message);
  }
}

// The one read of the events table: each row checked, a refused one thrown, or handed to `onRefused` and left out.
function checkedRows(rows: EventRow[], onRefused?: (err: EventCorruptError) => void): events.Event[] {
  return rows.flatMap((row) => {
    try {
      return [checked(row)];
    } catch (err) {
      if (!onRefused || !(err instanceof EventCorruptError)) throw err;
      onRefused(err);
      return [];
    }
  });
}

export const readEvents = (commonDir: string): events.Event[] =>
  checkedRows(stateDatabase.open(commonDir).prepare(`${SELECT} ORDER BY id`).all());

// One Execution's Events, in the order they were appended.
export const executionEvents = (
  commonDir: string,
  execution: string,
  onRefused?: (err: EventCorruptError) => void,
): events.Event[] =>
  checkedRows(
    stateDatabase.open(commonDir).prepare(`${SELECT} WHERE execution = ? ORDER BY id`).all(execution),
    onRefused,
  );

// An Execution's Terminal has landed once a ticket_end of it passes the check. A refused one does not count, so the
// next Run finishes the report again, and that report's run-stop read names the row in the log.
export const hasTicketEnd = (commonDir: string, execution: string): boolean =>
  checkedRows(
    stateDatabase
      .open(commonDir)
      .prepare(`${SELECT} WHERE execution = ? AND type = 'ticket_end' ORDER BY id`)
      .all(execution),
    () => {},
  ).length > 0;
