import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as effects from '../../lib/effects/index.ts';
import * as recordJson from '../../lib/record-json.ts';
import * as stateDatabase from '../../lib/state-database.ts';

// parseRow checks the whole row (#357): each case below walks every node of a full row, so a field the read leaves
// unchecked fails here by its path. The pattern lists are the row's type as these cases see it.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Segment = string | number;
interface Fixture {
  execution: { [key: string]: Json };
  variants: Record<string, Json[]>;
  epic: { [key: string]: Json };
}

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/record-rows.json', import.meta.url), 'utf8')) as Fixture;
const COMMON_DIR = 'C:/repo/.git';

// A field typed JsonValue holds anything JSON.parse gives, so nothing at or below it is refused.
const JSON_VALUE = [
  /^terminalStop\.response$/,
  /^visitState\.(call\.)?response$/,
  /^visitState\.call\.signal\.response$/,
  /^configurationSnapshot\.(outcomes|route|routes)$/,
  /^configurationSnapshot\.commands\.[^.]+$/,
  /^configurationSnapshot\.inputs\.[^.]+\.value$/,
  /^configurationSnapshot\.agent\.(?!(harness|model|effort|persona)$)[^.]+$/,
  /^visitState\.call\.harnessResult\.(sessionInit|permissionDenials|commandsRun)$/,
  /^outputs\[\d+\]\.value\.response$/,
  /^outputs\[\d+\]\.value\.evidence\.(?!(command|output)$)[^.]+$/,
  /^writeAheadLog\[\d+\]\.evidence\.[^.]+$/,
  /^planDecision$/,
];
// Keyed by name, as a Map or an open Record is: any key may be added or left out, and each value is checked.
const KEYED = [
  /^(visits|traversals|retries|sessions)$/,
  /^sessions\.[^.]+\.cumulativeUsage$/,
  /\.usage\.(cumulative|delta)$/,
  /^visitState\.(runs|checks)$/,
  /^configurationSnapshot\.(inputs|commands)$/,
  /[Bb]aseline\.(idle|untracked|tests)$/,
  /\.(untracked|left)\.files$/,
  /^writeAheadLog\[\d+\]\.evidence$/,
];
// Its declared keys are required and any other is JSON.
const OPEN = [/^configurationSnapshot\.agent$/, /^outputs\[\d+\]\.value\.evidence$/];
// A union told apart by its keys: a change to its key set is refused at the union, not at the key.
const KEY_SET_UNION = [
  /^writeAheadLog\[\d+\]\.payload$/,
  /\.decidedBy$/,
  /[Bb]aseline\.(untracked|tests)\.[^.]+$/,
  /\.files\.[^.]+$/,
];
// Keys a row may leave out. A payload's are by its effect, below.
const OPTIONAL = [
  /\.actionRef\.(procedure|attempt)$/,
  /^retries\.[^.]+\.(parse|timeout|transient|rateLimited|remote)$/,
  /^outputs\[\d+\]\.value\.[^.]+$/,
  /^outputs\[\d+\]\.value\.decision\.actor$/,
  /\.cleanup\.(reason|containment)$/,
  /\.harnessResult\.(exitCode|exitSignal|finalEventSubtype|sessionInit|permissionDenials|commandsRun|cleanup)$/,
  /\.resolution\.(sessionId|reason|surfaces|attempt|signal|output)$/,
  /\.failure\.(retryAfterMs|message)$/,
  /^configurationSnapshot\.agent\.(?!(harness|model|effort|persona)$)[^.]+$/,
  /^outputs\[\d+\]\.value\.evidence\.(?!(command|output)$)[^.]+$/,
];
// A consumed Decision's payload less its decision is a label payload, so the row still loads.
const PAYLOAD_OPTIONAL: Record<string, string[]> = {
  'pr-upsert': ['base'],
  reset: [
    'untracked',
    'left',
    'untracked.within',
    'untracked.pathspecs',
    'untracked.within.paths',
    'untracked.within.globs',
    'untracked.within.exclude',
    'left.index',
    'left.files',
  ],
  label: ['decision', 'decision.actor'],
};
// Strings from a closed set: any other is refused.
const LITERAL = [
  /\.rule\.table$/,
  /\.direction$/,
  /\.resolution\.row$/,
  /\.retryKind$/,
  /\.(checks\.[^.]+|signal)\.state$/,
  /\.(harnessResult|signal)\.status$/,
  /^writeAheadLog\[\d+\]\.step$/,
  /^admissionStop\.kind$/,
  /\.containment\.kind$/,
  /\.remote\.failureClass$/,
];

const matches = (patterns: RegExp[], path: string) => patterns.some((pattern) => pattern.test(path));
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
function* nodes(value: Json, segments: Segment[] = []): Generator<{ segments: Segment[]; value: Json; json: boolean }> {
  if (segments.length && matches(JSON_VALUE, pathOf(segments))) return yield { segments, value, json: true };
  if (segments.length) yield { segments, value, json: false };
  if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* nodes(item, [...segments, i]);
  else if (isObject(value)) for (const [key, held] of Object.entries(value)) yield* nodes(held, [...segments, key]);
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

// The effect of the write-ahead entry a payload path is in, and the path under that payload.
function payloadKey(row: Json, path: string): { effect: string; key: string } | null {
  const found = /^writeAheadLog\[(\d+)\]\.payload\.(.+)$/.exec(path);
  if (!found || !isObject(row)) return null;
  const log = row.writeAheadLog as { effect: string }[];
  return { effect: log[Number(found[1])].effect, key: found[2] };
}

const unionOf = (segments: Segment[]) => {
  const parent = segments.slice(0, -1);
  return matches(KEY_SET_UNION, pathOf(parent)) ? pathOf(parent) : null;
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
      for (const { segments, value, json } of nodes(row)) {
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
      if (segments.length && matches(JSON_VALUE, pathOf(segments))) return yield segments;
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
      for (const { segments } of nodes(row)) {
        const path = pathOf(segments);
        const parent = pathOf(segments.slice(0, -1));
        if (typeof segments.at(-1) === 'number' || !path.startsWith(under)) continue;
        if (segments.length > 1 && matches(KEYED, parent)) continue;
        const broken = changed(row, segments, (holder, key) => void delete (holder as Record<Segment, Json>)[key]);
        const inPayload = payloadKey(row, path);
        const union = unionOf(segments);
        if (matches(OPTIONAL, path) || (inPayload && PAYLOAD_OPTIONAL[inPayload.effect]?.includes(inPayload.key)))
          loads(kind, broken, `${path} left out`);
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
      const objects = [{ segments: [] as Segment[], value: row, json: false }, ...nodes(row)];
      for (const { segments, value, json } of objects) {
        const path = pathOf(segments);
        if (json || !isObject(value) || !path.startsWith(under) || matches(KEYED, path) || matches(OPEN, path))
          continue;
        const broken = changed(
          row,
          [...segments, 'undeclared'],
          (holder, key) => void ((holder as Record<Segment, Json>)[key] = 1),
        );
        const named = pathOf([...segments, 'undeclared']);
        if (matches(KEY_SET_UNION, path)) refused(kind, broken, new RegExp(`: its ${escaped(path)} is not `), named);
        else refused(kind, broken, new RegExp(`: its ${escaped(named)} is not declared$`), named);
      }
    }
});

test('a string outside its closed set is a corrupt row naming it; any other string loads', () => {
  const [{ row }] = executionRows();
  let closed = 0;
  for (const { segments, value, json } of nodes(row)) {
    const path = pathOf(segments);
    if (json || typeof value !== 'string') continue;
    const broken = changed(
      row,
      segments,
      (parent, key) => void ((parent as Record<Segment, Json>)[key] = 'not-a-member'),
    );
    if (!matches(LITERAL, path)) loads('ticket', broken, `${path} = 'not-a-member'`);
    else {
      refused('ticket', broken, new RegExp(`: its ${escaped(path)} is not one of `), path);
      closed++;
    }
  }
  assert.ok(closed >= 10, `${closed} closed sets checked`);
});

test('a decidedBy that mixes two forms, or holds none, is a corrupt row', () => {
  for (const decidedBy of [
    { hold: null, human: 'owner' },
    {},
    { human: 'owner', vertex: 'green', visit: 1, action: 'a', recovery: 0 },
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
