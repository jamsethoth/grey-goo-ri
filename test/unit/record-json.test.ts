import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as effects from '../../lib/effects/index.ts';
import * as recordJson from '../../lib/record-json.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as typeShape from '../support/type-shape.ts';

// parseRow checks the whole row (#357): each case below walks every node of a full row, so a field the read leaves
// unchecked fails here by its path. What each node may hold is read from the record types.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Segment = string | number;
interface Fixture {
  execution: { [key: string]: Json };
  variants: Record<string, Json[]>;
  epic: { [key: string]: Json };
}

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/record-rows.json', import.meta.url), 'utf8')) as Fixture;
const COMMON_DIR = 'C:/repo/.git';

// The row's rules, read from the record types (test/support/type-shape.ts): what each node is declared as, with each
// union read as the form the row's value there fits (#402).
const shapes = new typeShape.TypeShapes();
const SHAPES = {
  ticket: shapes.shapeOf('lib/record-json.ts', 'ExecutionRecordJson'),
  epic: shapes.shapeOf('lib/record-json.ts', 'EpicRecordJson'),
};
type Kind = keyof typeof SHAPES;

const valueAt = (row: Json, segments: Segment[]) =>
  segments.reduce<Json>((held, segment) => (held as Record<Segment, Json>)[segment], row);
const declaredAt = (kind: Kind, row: Json, segments: Segment[]) => typeShape.declaredAt(SHAPES[kind], row, segments);
// The node's shape as the row's value there is read: a union as the form it fits.
const placedAt = (kind: Kind, row: Json, segments: Segment[]) => {
  const declared = declaredAt(kind, row, segments);
  return declared && typeShape.formed(declared, valueAt(row, segments));
};
// A field typed JsonValue holds anything JSON.parse gives, so nothing at or below it is refused.
const isJson = (kind: Kind, row: Json, segments: Segment[]) => declaredAt(kind, row, segments)?.kind === 'json';
// Keyed by name, as a Map or an open Record is: any key may be added or left out, and each value is checked.
const isKeyed = (kind: Kind, row: Json, segments: Segment[]) => placedAt(kind, row, segments)?.kind === 'keyed';
// Its declared keys are required and any other is JSON.
const isOpen = (kind: Kind, row: Json, segments: Segment[]) => {
  const placed = placedAt(kind, row, segments);
  return placed?.kind === 'object' && placed.others !== null;
};
// A union told apart by its keys: a change to its key set is refused at the union, not at the key.
const isKeySetUnion = (kind: Kind, row: Json, segments: Segment[]) => {
  const declared = declaredAt(kind, row, segments);
  return declared?.kind === 'union' && declared.by === 'keys';
};
// A string from a closed set: any other is refused.
const isClosedSet = (kind: Kind, row: Json, segments: Segment[]) => {
  const placed = placedAt(kind, row, segments);
  return placed?.kind === 'scalar' && placed.members !== null;
};

const pathOf = (segments: Segment[]) =>
  segments
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Every node of a row with its segments, parents before children. A node typed as any JSON is given, marked, and
// nothing below it.
function* nodes(
  kind: Kind,
  row: Json,
  value: Json = row,
  segments: Segment[] = [],
): Generator<{ segments: Segment[]; value: Json; json: boolean }> {
  if (segments.length && isJson(kind, row, segments)) return yield { segments, value, json: true };
  if (segments.length) yield { segments, value, json: false };
  if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* nodes(kind, row, item, [...segments, i]);
  else if (isObject(value))
    for (const [key, held] of Object.entries(value)) yield* nodes(kind, row, held, [...segments, key]);
}

function changed(
  row: Json,
  segments: Segment[],
  change: (parent: Json[] | { [key: string]: Json }, key: Segment) => void,
) {
  const copy = structuredClone(row);
  let parent = copy as Json[] | { [key: string]: Json };
  for (const segment of segments.slice(0, -1)) parent = (parent as Record<Segment, Json>)[segment] as typeof parent;
  change(parent, segments.at(-1)!);
  return copy;
}

const parse = (kind: 'ticket' | 'epic', row: Json) =>
  // eslint-disable-next-line id-length -- n is the records table's column
  recordJson.parseRow(COMMON_DIR, { kind, n: 8, json: JSON.stringify(row) });

const loads = (kind: 'ticket' | 'epic', row: Json, what: string) =>
  assert.doesNotThrow(() => parse(kind, row), `${what} loads`);

function refused(kind: 'ticket' | 'epic', row: Json, problem: RegExp, what: string) {
  const file = `${stateDatabase.filePath(COMMON_DIR)}#${kind}-8`;
  assert.throws(
    () => parse(kind, row),
    (err: Error) => {
      assert.ok(err instanceof recordJson.RecordCorruptError, `${what}: ${String(err)}`);
      assert.ok(err.message.startsWith(`corrupt record ${file}: `), err.message);
      assert.match(err.message, problem, what);
      return true;
    },
    `${what} is corrupt`,
  );
}

// A key a row may leave out: optional in its form, one an open object does not declare, or one whose removal leaves
// another form of a union told apart by its keys (a hold's decidedBy less its Visit, a Decision's payload less its
// decision).
function mayLeaveOut(kind: Kind, row: Json, segments: Segment[]) {
  const parent = segments.slice(0, -1);
  const key = String(segments.at(-1));
  const holder = valueAt(row, parent) as { [key: string]: Json };
  const declared = declaredAt(kind, row, parent);
  const placed = declared && typeShape.formed(declared, holder);
  if (placed?.kind === 'object') {
    const declared = typeShape.keyOf(placed, key);
    if (declared ? declared.optional : placed.others !== null) return true;
  }
  if (declared?.kind !== 'union' || declared.by !== 'keys') return false;
  const { [key]: _left, ...rest } = holder;
  return typeShape.formOf(declared, rest) !== undefined;
}

// The rows a full fixture gives: the Execution Record itself, then one row per variant at its path.
function executionRows(): { row: Json; under: string }[] {
  const rows = [{ row: FIXTURE.execution as Json, under: '' }];
  for (const [path, values] of Object.entries(FIXTURE.variants)) {
    for (const value of values)
      rows.push({
        row: changed(
          FIXTURE.execution,
          path.split('.'),
          (parent, key) => void ((parent as Record<Segment, Json>)[key] = value),
        ),
        under: path,
      });
  }
  return rows;
}

const unionOf = (kind: Kind, row: Json, segments: Segment[]) => {
  const parent = segments.slice(0, -1);
  return isKeySetUnion(kind, row, parent) ? pathOf(parent) : null;
};

const kinds = [
  { kind: 'ticket' as const, rows: executionRows },
  { kind: 'epic' as const, rows: () => [{ row: FIXTURE.epic as Json, under: '' }] },
];

test('every row of the full fixture loads, and saves back as the row it was read from', () => {
  for (const { kind, rows } of kinds)
    for (const { row, under } of rows()) {
      const loaded = parse(kind, row);
      assert.equal(loaded.commonDir, COMMON_DIR);
      const saved = 'execution' in loaded ? recordJson.toJson(loaded) : recordJson.epicJson(loaded);
      assert.deepEqual(JSON.parse(JSON.stringify(saved)), row, `the ${kind} row with ${under || 'no variant'}`);
    }
});

test('the full fixture holds an intent of every Effect and of an agent call', () => {
  const log = FIXTURE.execution.writeAheadLog as { effect: string | null; payload: Json }[];
  const intended = new Set(log.filter((entry) => entry.payload !== null).map((entry) => entry.effect));
  for (const effect of [...effects.all().map(({ name }) => name), 'call']) assert.ok(intended.has(effect), effect);
});

test('a field of the wrong type, at any depth, is a corrupt row naming its path', () => {
  let checked = 0;
  for (const { kind, rows } of kinds)
    for (const { row, under } of rows())
      for (const { segments, value, json } of nodes(kind, row)) {
        const path = pathOf(segments);
        if (json || path === 'schemaVersion' || !path.startsWith(under)) continue;
        const wrong = typeof value === 'boolean' ? 'x' : true;
        const broken = changed(row, segments, (parent, key) => void ((parent as Record<Segment, Json>)[key] = wrong));
        refused(kind, broken, new RegExp(`: its ${escaped(path)} is not `), `${path} = ${JSON.stringify(wrong)}`);
        checked++;
      }
  assert.ok(checked > 300, `${checked} fields checked`);
});

test('a field typed as any JSON loads whatever JSON it holds', () => {
  for (const { kind, rows } of kinds) {
    const [{ row }] = rows();
    const walk = function* (value: Json, segments: Segment[]): Generator<Segment[]> {
      if (segments.length && isJson(kind, row, segments)) return yield segments;
      if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* walk(item, [...segments, i]);
      else if (isObject(value)) for (const [key, held] of Object.entries(value)) yield* walk(held, [...segments, key]);
    };
    for (const segments of walk(row, []))
      loads(
        kind,
        changed(row, segments, (parent, key) => void ((parent as Record<Segment, Json>)[key] = true)),
        pathOf(segments),
      );
  }
});

test('a required key left out is a corrupt row naming it; an optional one left out still loads', () => {
  for (const { kind, rows } of kinds)
    for (const { row, under } of rows())
      for (const { segments } of nodes(kind, row)) {
        const path = pathOf(segments);
        if (typeof segments.at(-1) === 'number' || !path.startsWith(under)) continue;
        if (segments.length > 1 && isKeyed(kind, row, segments.slice(0, -1))) continue;
        const broken = changed(row, segments, (holder, key) => void delete (holder as Record<Segment, Json>)[key]);
        const union = unionOf(kind, row, segments);
        if (mayLeaveOut(kind, row, segments)) loads(kind, broken, `${path} left out`);
        // A cursor with no Recovery Number was written before Action ids, and says so (#111).
        else if (path === 'cursor.recovery') refused(kind, broken, /Recovery Number/, path);
        else if (path === 'schemaVersion') refused(kind, broken, /unknown schemaVersion/, path);
        else if (union) refused(kind, broken, new RegExp(`: its ${escaped(union)} is not `), `${path} left out`);
        else refused(kind, broken, new RegExp(`: its ${escaped(path)} is missing$`), `${path} left out`);
      }
});

test('a key the type does not declare, at any depth, is a corrupt row naming it', () => {
  for (const { kind, rows } of kinds)
    for (const { row, under } of rows()) {
      const objects = [{ segments: [] as Segment[], value: row, json: false }, ...nodes(kind, row)];
      for (const { segments, value, json } of objects) {
        const path = pathOf(segments);
        if (json || !isObject(value) || !path.startsWith(under)) continue;
        if (isKeyed(kind, row, segments) || isOpen(kind, row, segments)) continue;
        const broken = changed(
          row,
          [...segments, 'undeclared'],
          (holder, key) => void ((holder as Record<Segment, Json>)[key] = 1),
        );
        const named = pathOf([...segments, 'undeclared']);
        if (isKeySetUnion(kind, row, segments))
          refused(kind, broken, new RegExp(`: its ${escaped(path)} is not `), named);
        else refused(kind, broken, new RegExp(`: its ${escaped(named)} is not declared$`), named);
      }
    }
});

test('a string outside its closed set is a corrupt row naming it; any other string loads', () => {
  const [{ row }] = executionRows();
  let closed = 0;
  for (const { segments, value, json } of nodes('ticket', row)) {
    const path = pathOf(segments);
    if (json || typeof value !== 'string') continue;
    const broken = changed(
      row,
      segments,
      (parent, key) => void ((parent as Record<Segment, Json>)[key] = 'not-a-member'),
    );
    if (!isClosedSet('ticket', row, segments)) loads('ticket', broken, `${path} = 'not-a-member'`);
    else {
      refused('ticket', broken, new RegExp(`: its ${escaped(path)} is not one of `), path);
      closed++;
    }
  }
  assert.ok(closed >= 10, `${closed} closed sets checked`);
});

test('a decidedBy that mixes two forms, holds none, or names half a Visit is a corrupt row', () => {
  for (const decidedBy of [
    { hold: null, human: 'owner' },
    {},
    { hold: null, human: 'owner', vertex: 'green', visit: 1, action: 'a', recovery: 0 },
    // A hold or a human names the Visit it cut off with all four keys or none (#341).
    { hold: 'dirty-worktree', vertex: 'green', visit: 1 },
  ] as Json[]) {
    const broken = changed(
      FIXTURE.execution,
      ['terminalReason', 'decidedBy'],
      (parent, key) => void ((parent as Record<Segment, Json>)[key] = decidedBy),
    );
    refused('ticket', broken, /: its terminalReason\.decidedBy is not /, JSON.stringify(decidedBy));
  }
});

test('a payload that fits no write-ahead payload is a corrupt row naming it', () => {
  const broken = changed(
    FIXTURE.execution,
    ['writeAheadLog', 3, 'payload'],
    (parent, key) => void ((parent as Record<Segment, Json>)[key] = { branch: 'b' }),
  );
  refused('ticket', broken, /: its writeAheadLog\[3\]\.payload is not /, 'a push payload with no sha');
});
