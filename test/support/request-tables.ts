import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The request's key tables, which a Layer's author reads. A Keys column holds only key names, each a code span, so a
// table compares exactly with the key lists the code declares (#229).
const REQUEST = new URL('../../docs/requests/node-harness-dag.md', import.meta.url);
const spans = (cell: string) => (cell.match(/`[^`]+`/g) ?? []).map((span) => span.slice(1, -1));

// The rows of the table whose header line starts with `header`, each split into cells on its unescaped pipes.
function rows(header: string): string[][] {
  const lines = readFileSync(REQUEST, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(header));
  assert.ok(start >= 0, `the request has a table headed ${header}`);
  const found = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) break;
    found.push(line.split(/(?<!\\)\|/));
  }
  return found;
}

// Each code span of a first cell, mapped to its row's sorted Keys spans, in the table headed `| <first> | Keys |`.
export const keyTable = (first: string) =>
  Object.fromEntries(
    rows(`| ${first} | Keys |`).flatMap((cells) =>
      spans(cells[1] ?? '').map((name) => [name, spans(cells[2] ?? '').sort()]),
    ),
  );

// Every code span in the first column of a table headed `header`, sorted: a table that names fields row by row.
export const firstColumn = (header: string) =>
  rows(header)
    .flatMap((cells) => spans(cells[1] ?? ''))
    .sort();

export const sortedKeys = (table: Record<string, readonly string[]>) =>
  Object.fromEntries(Object.entries(table).map(([name, keys]) => [name, [...keys].sort()]));
