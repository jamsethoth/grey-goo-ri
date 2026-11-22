import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as effects from '../../lib/effects/index.ts';
import * as recordJson from '../../lib/record-json.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
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

// An intent's payload is read by the reader of the effect it names (#384): the one form that effect saves, or label's
// own and a consumed Decision's. An unknown effect's keeps the whole union; an entry outside an intent holds none.
const FORMS_OF: Record<string, string[]> = {
  call: ['writeAhead.CallPayload'],
  label: ['label.Payload', 'approvalAction.Consumption'],
};
const formsOf = (effect: string) =>
  FORMS_OF[effect] ?? [`${effect.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}.Payload`];
const isKnownEffect = (effect: Json): effect is string =>
  effect === 'call' || (typeof effect === 'string' && effects.lookup(effect) !== undefined);
const entryOf = (row: Json, segments: Segment[]) =>
  segments.length === 3 && segments[0] === 'writeAheadLog' && segments[2] === 'payload'
    ? (valueAt(row, segments.slice(0, 2)) as { step: Json; effect: Json })
    : undefined;
const isPayloadOutsideIntent = (row: Json, segments: Segment[]) => {
  const entry = entryOf(row, segments);
  return entry !== undefined && entry.step !== 'intent';
};
const declaredAt = (kind: Kind, row: Json, segments: Segment[]) => {
  const declared = typeShape.declaredAt(SHAPES[kind], row, segments);
  const entry = entryOf(row, segments);
  if (declared?.kind !== 'union' || entry?.step !== 'intent' || !isKnownEffect(entry.effect)) return declared;
  const names = formsOf(entry.effect);
  const forms = declared.forms.filter(({ name }) => names.includes(name));
  assert.equal(forms.length, names.length, `${entry.effect}'s payload forms ${names.join(', ')} are declared`);
  return forms.length === 1 ? { ...forms[0].shape, nullable: false } : { ...declared, forms, nullable: false };
};
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
function executionRows(fixture = FIXTURE): { row: Json; under: string }[] {
  const rows = [{ row: fixture.execution as Json, under: '' }];
  for (const [path, values] of Object.entries(fixture.variants)) {
    for (const value of values)
      rows.push({
        row: changed(
          fixture.execution,
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

// The full fixture as version 2 wrote it, every row and variant, so none holds a field version 3 added: a reader
// accepts the version before its own, and a field new in its version is optional when absent (#422, decision 8).
const VERSION_2 = JSON.parse(
  readFileSync(new URL('../fixtures/record-rows-version-2.json', import.meta.url), 'utf8'),
) as Fixture;

test('a record saved at the previous schema version still reads', () => {
  assert.equal(recordJson.RECORD_SCHEMA_VERSION, 3, 'version 2 is the one before');
  for (const { row, under } of executionRows(VERSION_2))
    loads('ticket', row, `the version 2 row with ${under || 'no variant'}`);
  loads('epic', VERSION_2.epic, 'the version 2 Epic Record');
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
        else if (path === 'schemaVersion') refused(kind, broken, /: unknown schemaVersion undefined$/, path);
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

// The whole refusal each change gives, by the type of the node it changes: the messages parseRow gave before #402.
// A union told apart by its keys names itself by what its reader calls it.
const UNION_NAMES: Record<string, string> = {
  'record.DecidedByAction': 'one form of decidedBy',
  'approvalAction.Consumption': 'a label payload',
  'integrity.UntrackedLink': 'a link or base64 bytes',
};
// Any other scalar, a closed set or a string-or-number among them, is read as a string first.
const SCALAR_REFUSALS: Record<string, string> = { number: 'is not a number', boolean: 'is not true or false' };
const wrongTypeRefusal = (shape: typeShape.Shape) =>
  shape.kind === 'scalar'
    ? (SCALAR_REFUSALS[shape.type] ?? 'is not a string')
    : `is not ${shape.kind === 'list' ? 'a list' : 'an object'}`;
const unionRefusal = (kind: Kind, row: Json, segments: Segment[]) => {
  const declared = declaredAt(kind, row, segments);
  const name = declared?.kind === 'union' && declared.forms.find((form) => Object.hasOwn(UNION_NAMES, form.name));
  assert.ok(name, `${pathOf(segments)} is a union with a name`);
  return `${pathOf(segments)} is not ${UNION_NAMES[name.name]}`;
};
// Each closed set as its refusal lists it: in the reader's order, which the record types do not keep.
const CLOSED_SETS = [
  ['ticket', 'epic'],
  ['advance', 'retry', 'stop'],
  [
    'cleanup-unconfirmed',
    'integrity-violation',
    'transient-retry',
    'transient-exhausted',
    'run-stop',
    'timeout-retry',
    'timeout-exhausted',
    'unknown-failure',
    'parse-retry',
    'parse-exhausted',
    'handed-off',
    'handoff-exhausted',
    'claimed',
    'recover',
  ],
  ['completed', 'failed', 'timed-out', 'killed'],
  ['fixed', 'stopped', 'passed', 'failed'],
  ['hold', 'abandon', 'fault'],
  ['intent', 'evidence', 'complete'],
  ['job', 'none', 'group'],
  ['parse', 'timeout', 'transient', 'rateLimited', 'handoff'],
  ['passed', 'failed'],
  ['reported', 'priced'],
  ['transient', 'rate-limited', 'auth', 'quota', 'budget', 'permission', 'rejected', 'invalid', 'unknown'],
];
// The listing of the closed set whose members are `values`, which a new set must be given here.
function listing(values: string[], path: string) {
  const key = [...values].sort().join(',');
  const found = CLOSED_SETS.find((members) => [...members].sort().join(',') === key);
  assert.ok(found, `${path}'s closed set ${key} is listed in CLOSED_SETS`);
  return found.join(', ');
}
// The closed set a string is refused against: its own, or, for the key that tells a union's forms apart, every form's
// value of it. A Resolution's form for the Transition Table takes more than one row, and a row outside every own form
// is refused against that set.
function closedSet(kind: Kind, row: Json, segments: Segment[], own: string[]) {
  const union = declaredAt(kind, row, segments.slice(0, -1));
  if (union?.kind !== 'union' || union.by !== 'tag') return own;
  const tags = union.forms.map(({ shape }) => {
    const tag = shape.kind === 'object' ? typeShape.keyOf(shape, String(segments.at(-1)))?.shape : undefined;
    return tag?.kind === 'scalar' && tag.members ? tag.members : [];
  });
  return tags.find((values) => values.length > 1) ?? tags.flat();
}

const refusedExactly = (kind: Kind, row: Json, problem: string, what: string) =>
  refused(kind, row, new RegExp(`: its ${escaped(problem)}$`), what);

// Each refusal of one node, whole: its value of the wrong type, a string outside its closed set, and the key left out.
function refusesWhole(kind: Kind, row: Json, segments: Segment[], value: Json) {
  const path = pathOf(segments);
  const set = (held: Json) =>
    changed(row, segments, (parent, key) => void ((parent as Record<Segment, Json>)[key] = held));
  const wrong = set(typeof value === 'boolean' ? 'x' : true);
  const wrongRefusal = isPayloadOutsideIntent(row, segments)
    ? 'is not null outside an intent'
    : wrongTypeRefusal(declaredAt(kind, row, segments)!);
  refusedExactly(kind, wrong, `${path} ${wrongRefusal}`, path);
  const placed = placedAt(kind, row, segments);
  if (placed?.kind === 'scalar' && placed.members && typeof value === 'string') {
    const closed = listing(closedSet(kind, row, segments, placed.members), path);
    refusedExactly(kind, set('not-a-member'), `${path} is not one of ${closed}`, path);
  }
  const keyedParent = segments.length > 1 && isKeyed(kind, row, segments.slice(0, -1));
  if (typeof segments.at(-1) === 'number' || keyedParent || path === 'cursor.recovery') return;
  if (mayLeaveOut(kind, row, segments)) return;
  const left = changed(row, segments, (holder, key) => void delete (holder as Record<Segment, Json>)[key]);
  const union = unionOf(kind, row, segments);
  refusedExactly(kind, left, union ? unionRefusal(kind, row, segments.slice(0, -1)) : `${path} is missing`, path);
}

test('the reader refuses what it refused before, with the same message', () => {
  let checked = 0;
  for (const { kind, rows } of kinds)
    for (const { row, under } of rows())
      for (const { segments, value, json } of nodes(kind, row)) {
        const path = pathOf(segments);
        if (json || path === 'schemaVersion' || !path.startsWith(under)) continue;
        refusesWhole(kind, row, segments, value);
        checked++;
      }
  assert.ok(checked > 300, `${checked} fields checked`);
});

// A Resolution with neither its row nor its outcome names its row: the tag is read before any form.
test('a row with two faults names the one its reader reads first', () => {
  const broken = changed(FIXTURE.execution, ['visitState', 'settled', 'resolution'], (parent, key) => {
    const resolution = (parent as Record<Segment, Json>)[key] as { [key: string]: Json };
    delete resolution.row;
    delete resolution.outcome;
  });
  refused('ticket', broken, /: its visitState\.settled\.resolution\.row is missing$/, 'no row and no outcome');
});

test('a decidedBy that mixes two forms, holds none, or names half a Visit is a corrupt row', () => {
  for (const decidedBy of [
    { hold: null, label: 'gg:state:needs-human' },
    {},
    { hold: null, label: 'gg:state:needs-human', vertex: 'green', visit: 1, action: 'a', recovery: 0 },
    // A hold or an abandonment names the Visit it cut off with all four keys or none (#341).
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

test("a payload missing a key its effect's form requires is a corrupt row naming the key", () => {
  const broken = changed(
    FIXTURE.execution,
    ['writeAheadLog', 3, 'payload'],
    (parent, key) => void ((parent as Record<Segment, Json>)[key] = { branch: 'b' }),
  );
  refused('ticket', broken, /: its writeAheadLog\[3\]\.payload\.sha is missing$/, 'a push payload with no sha');
});

// The fixture's write-ahead log, which holds an intent of every Effect and of an agent call.
type Entry = { step: Json; effect: Json; payload: Json };
const LOG = FIXTURE.execution.writeAheadLog as Entry[];
const INTENTS = LOG.flatMap((entry, index) =>
  entry.step === 'intent' ? [{ index, effect: String(entry.effect), payload: entry.payload }] : [],
);
// The fixture's row with its entry at `index` holding `payload`, and naming `effect` when one is given.
const withPayload = (index: number, payload: Json, effect?: string) =>
  changed(FIXTURE.execution, ['writeAheadLog', index], (log, key) => {
    const entry = (log as Record<Segment, Entry>)[key];
    entry.payload = payload;
    if (effect !== undefined) entry.effect = effect;
  });
// What parseRow makes of a row: `loads`, or the reason it gives for refusing it.
function outcomeOf(row: Json) {
  try {
    parse('ticket', row);
    return 'loads';
  } catch (err) {
    if (!(err instanceof recordJson.RecordCorruptError)) throw err;
    return err.reason;
  }
}

test("an intent holding another effect's payload is a corrupt row naming its payload", () => {
  assert.deepEqual(
    [...new Set(INTENTS.map(({ effect }) => effect))].sort(),
    [...effects.all().map(({ name }) => name), 'call'].sort(),
    'an intent of every Effect and of an agent call',
  );
  const accepted = INTENTS.flatMap(({ index, effect }) =>
    INTENTS.filter((other) => other.effect !== effect).flatMap((other) => {
      const reason = outcomeOf(withPayload(index, other.payload));
      const named =
        reason.startsWith(`its writeAheadLog[${index}].payload `) ||
        reason.startsWith(`its writeAheadLog[${index}].payload.`);
      return named ? [] : [`${effect} holding ${other.effect}'s payload: ${reason}`];
    }),
  );
  assert.deepEqual(accepted, []);
});

test('an intent with no payload is a corrupt row naming its payload', () => {
  assert.deepEqual(
    INTENTS.map(({ index, effect }) => `${effect}: ${outcomeOf(withPayload(index, null))}`),
    INTENTS.map(({ index, effect }) => `${effect}: its writeAheadLog[${index}].payload is not an object`),
  );
});

test('an evidence or complete entry holding a payload is a corrupt row naming it', () => {
  const others = LOG.flatMap((entry, index) => (entry.step === 'intent' ? [] : [{ index, step: entry.step }]));
  assert.deepEqual([...new Set(others.map(({ step }) => step))].sort(), ['complete', 'evidence']);
  // The commit intent's payload, which fits the effect the fixture's evidence entry names.
  const [{ payload }] = INTENTS.filter(({ effect }) => effect === 'commit');
  assert.deepEqual(
    others.map(({ index, step }) => `${String(step)}: ${outcomeOf(withPayload(index, payload))}`),
    others.map(
      ({ index, step }) => `${String(step)}: its writeAheadLog[${index}].payload is not null outside an intent`,
    ),
  );
});

// record.md: an intent whose effect names no Effect gg can find loads, and Reconciliation holds its Ticket.
test('an intent naming an effect gg does not know still loads, holding any form of payload', () => {
  for (const { index, effect, payload } of INTENTS)
    loads('ticket', withPayload(index, payload, 'teleport'), `an unknown effect holding ${effect}'s payload`);
});

test('an intent naming an effect gg does not know, with no payload, is a corrupt row naming its payload', () => {
  const [{ index }] = INTENTS;
  assert.equal(outcomeOf(withPayload(index, null, 'teleport')), `its writeAheadLog[${index}].payload is not an object`);
});

test('RecordCorruptError builds from each argument form it takes, the base three-argument one included', () => {
  const base = ['rows#ticket-7', 'its flow is not a string', '{}'] as const;
  const forms: [string, () => recordJson.RecordCorruptError, number, string | undefined][] = [
    ['(file, reason, raw), as before #439', () => new recordJson.RecordCorruptError(...base), 0, undefined],
    ['with the record number', () => new recordJson.RecordCorruptError(...base, { recordNumber: 7 }), 7, undefined],
    [
      'with the record number and field',
      () => new recordJson.RecordCorruptError(...base, { recordNumber: 7, field: 'flow' }),
      7,
      'flow',
    ],
  ];
  for (const [form, build, recordNumber, field] of forms) {
    let err: recordJson.RecordCorruptError | undefined;
    assert.doesNotThrow(() => (err = build()), form);
    assert.deepEqual(
      [err?.message, err?.file, err?.reason, err?.raw, err?.recordNumber, err?.field],
      ['corrupt record rows#ticket-7: its flow is not a string', ...base, recordNumber, field],
      form,
    );
  }
});
