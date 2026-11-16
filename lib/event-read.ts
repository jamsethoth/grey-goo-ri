// The event log read back: each row of the events table parsed and checked against the declaration its Event was
// written from (lib/events.ts), so a corrupt row, or one another gg version wrote, is refused by name, never read as an
// Event. RecordCorruptError is the precedent for a record's row.
import * as effectErrors from './effect-errors.ts';
import * as events from './events.ts';
import type * as eventsTable from './state-database/events.ts';

export class EventCorruptError extends Error {
  declare id: number | string;
  declare type: string;
  declare raw: string;
  constructor(id: number | string, type: string, reason: string, raw: string) {
    super(`corrupt event ${id} (${type}): ${reason}`);
    this.name = 'EventCorruptError';
    this.id = id;
    this.type = type;
    this.raw = raw;
  }
}

type EventRow = eventsTable.EventRow;

// eventLog copies these fields to indexed columns, and a filtered read trusts the column, so each must equal its field.
export const COLUMNS = ['type', 'run', 'execution', 'ticket'];
// The fields gg's own readers use hold a string or null (#350); the declaration gives names, not value types.
const READ_FIELDS = ['failureClass', 'execution', 'run', 'head'];

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
  if (schemaVersion !== events.EVENT_SCHEMA_VERSION) throw new Error(`unknown schemaVersion ${String(schemaVersion)}`);
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
  const refused = (reason: string) =>
    new EventCorruptError(typeof row.id === 'number' ? row.id : String(row.id), String(row.type), reason, raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw refused(`its JSON does not parse: ${effectErrors.errorText(err)}`);
  }
  try {
    assertEvent(value, row);
    return value;
  } catch (err) {
    throw refused(effectErrors.errorText(err));
  }
}

// The one read of the events table (lib/state-database/events.ts): each row checked, a refused one thrown, or handed to
// `onRefused` and left out.
export function checkedRows(rows: EventRow[], onRefused?: (err: EventCorruptError) => void): events.Event[] {
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

// `execution`'s Events among rows that may be its own: a row whose columns are corrupt may still name it in its JSON.
export const ofExecution = (
  rows: EventRow[],
  execution: string,
  onRefused: (err: EventCorruptError) => void,
): events.Event[] =>
  checkedRows(rows, onRefused).filter((event) => ('execution' in event ? event.execution : null) === execution);

// The real State Database's Event reads, for callers that take no seam; a Run's path reaches them through the database
// it is handed (#367).
export { executionEvents, hasTicketEnd, readEvents, rowsNaming } from './state-database/index.ts';
