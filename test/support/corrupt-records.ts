// Each way an Execution Record's row is one the reader refuses, as a hand edit of the State Database, a damaged file or
// a row another gg version wrote leaves it, planted over a saved row by SQL: the field the reader names, when it names
// one, and the reason it gives.
import assert from 'node:assert/strict';
import * as stateDatabase from '../../lib/state-database/index.ts';

export interface Corruption {
  name: string;
  change: (row: string) => string;
  field?: string;
  reason: string;
}

export const CORRUPTIONS: Corruption[] = [
  {
    name: 'a field of the wrong type',
    change: (row) => row.replace(/"flow": "[^"]*"/, '"flow": 5'),
    field: 'flow',
    reason: 'its flow is not a string',
  },
  {
    name: 'a nested field of the wrong type',
    change: (row) => row.replace(/("cursor": \{[^}]*"recovery": )0/, '$1"0"'),
    field: 'cursor.recovery',
    reason: 'its cursor.recovery is not a number',
  },
  {
    name: 'a row that is not JSON',
    change: () => '{ "schemaVersion": 3, "log": [',
    reason: 'Unexpected end of JSON input',
  },
  {
    name: 'an unknown schemaVersion',
    change: (row) => row.replace(/"schemaVersion": \d+/, '"schemaVersion": 99'),
    field: 'schemaVersion',
    reason: 'unknown schemaVersion 99',
  },
];

// Ticket `ticket`'s saved row in `commonDir`, changed in place as `corruption` says.
export function plant(commonDir: string, ticket: number, corruption: Corruption): void {
  const database = stateDatabase.open(commonDir);
  const { json } = database.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(ticket) as {
    json: string;
  };
  const changed = corruption.change(json);
  assert.notEqual(changed, json, `${corruption.name} changes the row`);
  database.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = ?").run(changed, ticket);
}
