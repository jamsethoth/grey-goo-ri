import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import * as config from '../../lib/config.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as flow from '../../lib/flow.ts';
import * as jsonValue from '../../lib/json-value.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// What a save must not lose: the value read back from its JSON is the value.
function roundTrips(value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value);
  } catch {
    return false;
  }
}

class Point {
  across = 1;
}
class Rows extends Array<number> {}
// One value of every kind a save could be handed: each JSON kind, and each kind JSON.stringify changes or refuses.
const CORPUS: [string, unknown][] = [
  ['a string', 'text'],
  ['an empty string', ''],
  ['zero', 0],
  ['a negative fraction', -1.5],
  ['true', true],
  ['false', false],
  ['null', null],
  ['an empty list', []],
  ['a list', [1, 'a', null]],
  ['an empty object', {}],
  ['a nested object', { outer: { inner: [{}] } }],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['undefined', undefined],
  ['an empty Map', new Map()],
  ['a Map', new Map([['a', 1]])],
  ['a Set', new Set([1])],
  ['an Error', new Error('lost')],
  ['a Date', new Date(0)],
  ['a class instance', new Point()],
  ['a typed array', new Uint8Array(2)],
  ['a RegExp', /lost/],
  ['a String object', new String('boxed')],
  ['a function', () => 1],
  ['a symbol', Symbol('lost')],
  ['a bigint', 10n],
  ['a list with a hole', [, 1]],
  ['a list subclass', Rows.of(1, 2)],
  // Values that are not what they seem to a reader other than JSON.stringify, which reads a list by index and an
  // object by its own enumerable string keys.
  ['a list whose iterator gives other elements', withIterator([1, 2], [9])],
  ['a list whose iterator hides a Map', withIterator([new Map()], [])],
  ['a list with a property that is not an element', Object.assign([1], { note: 'lost' })],
  ['a list with a hidden element and a property', hiddenFirst(Object.assign([1], { note: 'lost' }))],
  ['a match, which is a list with properties', 'ab'.match(/a/)],
  ['an object with a symbol key', { kept: 1, [Symbol('lost')]: 2 }],
  ['an object with a property that is not enumerable', Object.defineProperty({ kept: 1 }, 'job', { value: () => 1 })],
  // Another realm's plain values have another realm's prototypes, so a load does not give them back as they were.
  ['a plain object from another realm', runInNewContext('({ kept: 1 })')],
  ['a list from another realm', runInNewContext('[1]')],
];

// A list whose own iterator gives `given`, whatever its indices hold.
function withIterator<Item>(list: Item[], given: Item[]): Item[] {
  return Object.defineProperty(list, Symbol.iterator, { value: () => given[Symbol.iterator]() });
}
// A list whose first element is not enumerable, so its keys do not count what JSON.stringify reads.
function hiddenFirst<Item>(list: Item[]): Item[] {
  return Object.defineProperty(list, '0', { enumerable: false });
}
// A built-in object given a plain object's prototype.
function madePlain(value: object): object {
  return Object.setPrototypeOf(value, Object.prototype) as object;
}

// The run-time check's one rule, held over every kind of value: a value is accepted exactly when a load gives it
// back, and what is then written is what JSON.stringify writes of it. Two values are outside the rule, each with a
// case of its own below: a Proxy, and -0. A built-in object given a plain prototype is outside this test's reach, not
// the rule's: it deceives the comparison here as it would the check, so its case below names what each is refused as.
test('checked accepts exactly the values a save reads back unchanged, and names the path to any other', () => {
  for (const [name, value] of CORPUS) {
    const held = { list: ['first', { items: [value] }] };
    const outcome = (() => {
      try {
        return { written: JSON.stringify(jsonValue.checked(held, 'the row')), refusal: null };
      } catch (err) {
        return { written: null, refusal: (err as Error).message };
      }
    })();
    assert.equal(outcome.refusal === null, roundTrips(held), `${name}: ${outcome.refusal ?? 'accepted'}`);
    if (outcome.refusal === null) assert.equal(outcome.written, JSON.stringify(held), name);
    else assert.match(outcome.refusal, /^the row: list\[1\]\.items\[0\]\S* (is|has) /, name);
  }
});

test('checked names the value itself when the whole value is not JSON', () => {
  assert.throws(() => jsonValue.checked(new Map(), 'the row'), /^Error: the row: the value is a Map/);
  assert.throws(() => jsonValue.checked(undefined, 'the row'), /^Error: the row: the value is undefined/);
});

test('a built-in object given a plain prototype is refused as what it is inside', () => {
  const madePlainValues: [string, object][] = [
    ['Map', new Map([['first', 1]])],
    ['Set', new Set([1])],
    ['Date', new Date(0)],
    ['NumberObject', new Number(5)],
    ['StringObject', new String('boxed')],
    ['RegExp', /lost/],
    ['NativeError', new Error('lost')],
    ['ArrayBufferView', new Uint8Array(2)],
  ];
  for (const [name, value] of madePlainValues) {
    const refused = new RegExp(`^Error: the row: held is an? ${name}, which JSON cannot hold`);
    assert.throws(() => jsonValue.checked({ held: madePlain(value) }, 'the row'), refused, name);
  }
});

test('a Proxy is refused whatever it shows, since it may answer each question differently', () => {
  const plainLooking = new Proxy({ kept: 1 }, {});
  assert.throws(() => jsonValue.checked({ held: plainLooking }, 'the row'), /^Error: the row: held is a Proxy/);
  const hiding = new Proxy(new Map([['first', 1]]), { getPrototypeOf: () => Object.prototype });
  assert.throws(() => jsonValue.checked({ held: hiding }, 'the row'), /^Error: the row: held is a Proxy/);
  // One that throws when asked anything is still refused by its path.
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(() => jsonValue.checked({ held: revoked.proxy }, 'the row'), /^Error: the row: held is a Proxy/);
  const throwing = new Proxy({}, { getPrototypeOf: () => assert.fail('the Proxy was asked its prototype') });
  assert.throws(() => jsonValue.checked({ held: throwing }, 'the row'), /^Error: the row: held is a Proxy/);
});

test('a class instance whose constructor throws is still refused by its path', () => {
  class Guarded {}
  const guarded = new Guarded();
  Object.defineProperty(guarded, 'constructor', { get: () => assert.fail('no name') });
  assert.throws(() => jsonValue.checked({ held: guarded }, 'the row'), /^Error: the row: held is a class instance/);
});

test('-0 is saved as 0, the same number to every comparison but Object.is', () => {
  assert.equal(jsonValue.text({ count: -0 }, 'the row'), '{"count":0}');
});

test('a toJSON every object inherits fails the save, since it would run on the copy', () => {
  const prototype = Object.prototype as { toJSON?: unknown };
  const refused = /^Error: the row: every object inherits a toJSON/;
  // The toJSON is gone again before anything else runs: the coverage stage runs every unit file in this process.
  const saving = (save: () => unknown): void => {
    try {
      assert.throws(save, refused);
    } finally {
      delete prototype.toJSON;
    }
  };
  saving(() => {
    prototype.toJSON = () => 'swapped';
    return jsonValue.checked({ kept: 1 }, 'the row');
  });
  assert.deepEqual(jsonValue.checked({ kept: 1 }, 'the row'), { kept: 1 });
  // One a getter adds while the value is copied, after any check made before the copy.
  const adding = {
    get kept() {
      prototype.toJSON = () => 'swapped';
      return 1;
    },
  };
  saving(() => jsonValue.text(adding, 'the row'));
  // One that is a getter, which would run while the copy is written. It is found without being run.
  let ran = 0;
  saving(() => {
    Object.defineProperty(prototype, 'toJSON', { get: () => void ran++, configurable: true });
    return jsonValue.text({ kept: 1 }, 'the row');
  });
  assert.equal(ran, 0);
});

test('what is checked is what is written: each property is read once, and no toJSON runs', () => {
  let reads = 0;
  // A number by its type, so only the run-time check stands between its second answer and the row.
  const later: unknown = new Map([['first', 1]]);
  const changing = {
    get counts() {
      return (++reads === 1 ? 0 : later) as number;
    },
  };
  assert.equal(jsonValue.text(changing, 'the row'), '{"counts":0}');
  assert.equal(reads, 1);
  const hidden = { kept: 1 };
  Object.defineProperty(hidden, 'toJSON', { value: () => ({ swapped: new Map() }) });
  assert.equal(jsonValue.text(hidden, 'the row'), '{"kept":1}');
  const shown = { kept: 1, toJSON: () => ({ swapped: 1 }) };
  // @ts-expect-error a toJSON is a function
  assert.throws(() => jsonValue.text(shown, 'the row'), /^Error: the row: toJSON is a function/);
});

test('a value that holds itself is refused by its path, and one held twice is not', () => {
  const inner: Record<string, unknown> = { name: 'inner' };
  const cyclic = { outer: { inner } };
  inner.back = cyclic.outer;
  assert.throws(() => jsonValue.checked(cyclic, 'the row'), /^Error: the row: outer\.inner\.back holds itself/);
  const shared = { name: 'shared' };
  assert.equal(
    jsonValue.text({ first: shared, second: shared }, 'the row'),
    JSON.stringify({ first: shared, second: shared }),
  );
});

test('an undefined property is not given, so text drops it as JSON.stringify does', () => {
  const value = { kept: 1, absent: undefined, inner: { absent: undefined } };
  assert.equal(jsonValue.text(value, 'the row'), '{"kept":1,"inner":{}}');
});

test('an object with no prototype is a plain object', () => {
  const noPrototype: Record<string, number> = Object.assign(Object.create(null), { one: 1 });
  assert.equal(jsonValue.text({ inner: noPrototype }, 'the row'), '{"inner":{"one":1}}');
});

test("text writes JSON.stringify's bytes, at the indent it is given", () => {
  interface Row {
    name: string;
    counts: Record<string, number>;
    list: (string | null)[];
    optional?: number;
  }
  const row: Row = { name: 'é "quoted"\n', counts: { toString: 2, first: 1 }, list: ['a', null] };
  assert.equal(jsonValue.text(row, 'the row'), JSON.stringify(row));
  assert.equal(jsonValue.text(row, 'the row', 2), JSON.stringify(row, null, 2));
  const parsed: jsonValue.JsonValue = JSON.parse(JSON.stringify(row));
  assert.equal(jsonValue.text(parsed, 'the row'), JSON.stringify(row));
});

test('tsc refuses text a Map, a Set, a function or an unknown, at any depth and as one alternative', () => {
  const lost = /^Error: the row: /;
  const withMap = { inner: { counts: new Map([['a', 1]]) } };
  const withSet = { inner: [{ seen: new Set(['a']) }] };
  const withFunction = { inner: { run: () => 1 } };
  const maybeMap: { inner: { counts: Map<string, number> | null } } = withMap;
  const loose: unknown = { one: 1 };
  const withUnknown: { inner: { value: unknown } } = { inner: { value: 1 } };
  const anything: any = { one: 1 };
  const withAny: { inner: { value: any } } = { inner: { value: 1 } };
  const listOfAny: any[] = [1];
  // @ts-expect-error a Map nested in the value
  assert.throws(() => jsonValue.text(withMap, 'the row'), lost);
  // @ts-expect-error a Set nested in a list
  assert.throws(() => jsonValue.text(withSet, 'the row'), lost);
  // @ts-expect-error a function
  assert.throws(() => jsonValue.text(withFunction, 'the row'), lost);
  // @ts-expect-error a Map as one alternative of a field
  assert.throws(() => jsonValue.text(maybeMap, 'the row'), lost);
  // @ts-expect-error a Map itself
  assert.throws(() => jsonValue.text(new Map(), 'the row'), lost);
  // An unknown or an any that holds JSON is saved at run time: only its type is refused.
  // @ts-expect-error an unknown
  assert.equal(jsonValue.text(loose, 'the row'), '{"one":1}');
  // @ts-expect-error an unknown nested in the value
  assert.equal(jsonValue.text(withUnknown, 'the row'), '{"inner":{"value":1}}');
  // @ts-expect-error an any
  assert.equal(jsonValue.text(anything, 'the row'), '{"one":1}');
  // @ts-expect-error an any nested in the value
  assert.equal(jsonValue.text(withAny, 'the row'), '{"inner":{"value":1}}');
  // @ts-expect-error a list of any
  assert.equal(jsonValue.text(listOfAny, 'the row'), '[1]');
});

// The typed gate's one rule, held over every place a type can hold another: `text` takes a value of a type exactly
// when the type is assignable to its checked form.
type Accepts<Value> = [Value] extends [jsonValue.JsonChecked<Value>] ? true : false;
interface Holder<Held> {
  held: Held;
}
// Whole, in a property, an optional one, a list, a readonly list, a tuple, a keyed object, an interface and two deep;
// then as one alternative beside null, a plain object and the whole of JsonValue, alone and inside each of those.
type Places<Held> = [
  Held,
  { held: Held },
  { held?: Held },
  Held[],
  readonly Held[],
  [string, Held],
  Record<string, Held>,
  Holder<Held>,
  { outer: { inner: Holder<Held>[] } },
  Held | null,
  Held | { plain: string },
  Held | jsonValue.JsonValue,
  { held: Held | jsonValue.JsonValue },
  (Held | jsonValue.JsonValue)[],
  Record<string, Held | jsonValue.JsonValue>,
  Holder<Held | jsonValue.JsonValue | undefined>,
];
type AcceptsEach<Tuple> = { [Index in keyof Tuple]: Accepts<Tuple[Index]> };
type Each<Answer, Tuple = Places<0>> = { [Index in keyof Tuple]: Answer };
// tsc fails the line of any kind the gate answers otherwise for, at any of the places.
type Holds<Answers extends Wanted, Wanted> = Answers;
interface Plain {
  name: string;
  count?: number;
  inner: { list: (string | null)[] };
}
type GateAnswers = [
  Holds<AcceptsEach<Places<Map<string, number>>>, Each<false>>,
  Holds<AcceptsEach<Places<Set<string>>>, Each<false>>,
  Holds<AcceptsEach<Places<() => void>>, Each<false>>,
  Holds<AcceptsEach<Places<new () => object>>, Each<false>>,
  Holds<AcceptsEach<Places<typeof Point>>, Each<false>>,
  Holds<AcceptsEach<Places<symbol>>, Each<false>>,
  Holds<AcceptsEach<Places<bigint>>, Each<false>>,
  Holds<AcceptsEach<Places<unknown>>, Each<false>>,
  Holds<AcceptsEach<Places<any>>, Each<false>>,
  Holds<AcceptsEach<Places<{ counts: Map<string, number> }>>, Each<false>>,
  Holds<AcceptsEach<Places<{ hidden: any }>>, Each<false>>,
  Holds<AcceptsEach<Places<{ hidden?: any }>>, Each<false>>,
  Holds<AcceptsEach<Places<string>>, Each<true>>,
  Holds<AcceptsEach<Places<number | null>>, Each<true>>,
  Holds<AcceptsEach<Places<Plain>>, Each<true>>,
  Holds<AcceptsEach<Places<jsonValue.JsonValue>>, Each<true>>,
];

test('the typed gate refuses what JSON cannot hold at every place a type can hold it, and takes JSON there', () => {
  // The table above is the case: it is checked by tsc, which the check stage runs.
  const answers: GateAnswers | null = null;
  assert.equal(answers, null);
});

// Each save path below takes a Map, a Set and an unknown in turn. tsc refuses each where the comment says, and the
// Map and the Set are refused again at run time by the path to them, with nothing written.

const startOf = (commonDir: string): record.ExecutionStart => ({
  commonDir,
  repository: 'o/r',
  ticket: 8,
  flow: { name: 'default', entry: 'implement' },
  configHash: 'abc123',
  run: 'run-1',
  worktree: join(commonDir, 'wt'),
  branch: 'ticket/8',
  base: 'main',
});
const outputOf = <Value>(value: Value) => ({ vertex: 'implement', visit: 1, action: 'agent', value });
const loose: unknown = 'parsed';

test('the Execution Record row refuses a Map, a Set and an unknown', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-json-value-');
  const withMap = record.createExecutionRecord(startOf(commonDir));
  // @ts-expect-error an Action's output holds no Map
  withMap.outputs.push(outputOf({ counts: new Map([['a', 1]]) }));
  assert.throws(() => record.save(withMap), /outputs\[0\]\.value\.counts is a Map/);
  const withSet = record.createExecutionRecord(startOf(commonDir));
  // @ts-expect-error an Action's output holds no Set
  withSet.outputs.push(outputOf({ seen: new Set(['a']) }));
  assert.throws(() => record.save(withSet), /outputs\[0\]\.value\.seen is a Set/);
  assert.equal(record.load(commonDir, 'ticket', 8), null, 'neither row was written');
  const withUnknown = record.createExecutionRecord(startOf(commonDir));
  // @ts-expect-error an Action's output holds no unknown
  withUnknown.outputs.push(outputOf({ parsed: loose }));
  record.save(withUnknown);
  assert.deepEqual(record.load(commonDir, 'ticket', 8)?.outputs, [outputOf({ parsed: 'parsed' })]);
});

test('the Epic Record row refuses a Map, a Set and an unknown', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-json-value-');
  const epicRecord = record.createEpicRecord({ commonDir, epic: 1 });
  // @ts-expect-error a plan Decision holds no Map
  epicRecord.planDecision = { counts: new Map([['a', 1]]) };
  assert.throws(() => record.save(epicRecord), /planDecision\.counts is a Map/);
  // @ts-expect-error a plan Decision holds no Set
  epicRecord.planDecision = [new Set(['a'])];
  assert.throws(() => record.save(epicRecord), /planDecision\[0\] is a Set/);
  assert.equal(record.load(commonDir, 'epic', 1), null, 'neither row was written');
  // @ts-expect-error a plan Decision is not an unknown
  epicRecord.planDecision = loose;
  record.save(epicRecord);
  assert.equal(record.load(commonDir, 'epic', 1)?.planDecision, 'parsed');
});

test('the Pinned Configuration refuses a Map, a Set and an unknown', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-json-value-');
  const withMap = { flow: { procedures: new Map([['a', 1]]) } };
  const withSet = { flow: { outcomes: [new Set(['a'])] } };
  const withUnknown = { flow: loose };
  const pin = stateDatabase.savePinnedConfiguration;
  // @ts-expect-error a Map nested in the Pinned Configuration
  assert.throws(() => pin(commonDir, 'hash-1', withMap), /flow\.procedures is a Map/);
  // @ts-expect-error a Set nested in the Pinned Configuration
  assert.throws(() => pin(commonDir, 'hash-1', withSet), /flow\.outcomes\[0\] is a Set/);
  assert.equal(stateDatabase.loadPinnedConfiguration(commonDir, 'hash-1'), null, 'neither row was written');
  // @ts-expect-error an unknown nested in the Pinned Configuration
  pin(commonDir, 'hash-1', withUnknown);
  assert.deepEqual(stateDatabase.loadPinnedConfiguration(commonDir, 'hash-1'), { flow: 'parsed' });
});

test('the Event append refuses a Map, a Set and an unknown', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-json-value-');
  const log = events.eventLog(commonDir);
  const withMap = { ticket: 8, error: 'no label', change: { add: new Map([['a', 1]]), remove: [] } };
  const withSet = { ticket: 8, error: 'no label', change: { add: [], remove: new Set(['a']) } };
  const withUnknown = { ticket: 8, error: 'no label', change: loose };
  // @ts-expect-error a Map in an Event's field
  assert.throws(() => log('label_failed', withMap), /change\.add is a Map/);
  // @ts-expect-error a Set in an Event's field
  assert.throws(() => log('label_failed', withSet), /change\.remove is a Set/);
  assert.deepEqual(eventRead.readEvents(commonDir), [], 'neither Event was appended');
  // @ts-expect-error an unknown as an Event's field
  log('label_failed', withUnknown);
  // Every field of an Event's input is optional, which a record of unknown values also fits: as the fields of one
  // Event, and as the fields every Event of a log is given.
  const untyped: Record<string, unknown> = { ticket: 8, error: 'no label', change: { add: ['gg:ready'] } };
  // @ts-expect-error a record of unknown values
  log('label_failed', untyped);
  const untypedBase: Record<string, unknown> = { run: new Map([['a', 1]]) };
  // @ts-expect-error a record of unknown values
  const withBase = events.eventLog(commonDir, untypedBase);
  assert.throws(() => withBase('run_start'), /^Error: the run_start Event: run is a Map/);
  // @ts-expect-error a key no Event declares
  assert.throws(() => events.eventLog(commonDir, { owner: 'me' })('run_start', { run: 'run-1' }), /\bowner\b/);
  // @ts-expect-error a key the Event does not declare, which fails when the Event is built
  assert.throws(() => log('label_failed', { ticket: 8, error: 'no label', change: {}, owner: 'me' }), /\bowner\b/);
  assert.deepEqual(
    eventRead.readEvents(commonDir).map((event) => event.type),
    ['label_failed', 'label_failed'],
  );
});

test("the run directory's flow.json refuses a Map, a Set and an unknown", (t) => {
  const runDir = join(tempDirectory.tempDirectory(t, 'gg-json-value-'), 'run');
  const resolved = <Routes>(routes: Routes) => ({
    name: 'default',
    actionCap: 1,
    procedures: {},
    ticket: { entry: null, routes, vertices: {} },
  });
  const withMap = resolved({ pass: new Map([['a', 1]]) });
  const withSet = resolved([new Set(['a'])]);
  const withUnknown = resolved(loose);
  // @ts-expect-error a Map in the Resolved Flow's JSON
  assert.throws(() => flow.writeResolved(runDir, withMap, 'hash'), /ticket\.routes\.pass is a Map/);
  // @ts-expect-error a Set in the Resolved Flow's JSON
  assert.throws(() => flow.writeResolved(runDir, withSet, 'hash'), /ticket\.routes\[0\] is a Set/);
  assert.ok(!existsSync(join(runDir, 'flow.json')), 'neither flow.json was written');
  // @ts-expect-error an unknown in the Resolved Flow's JSON
  flow.writeResolved(runDir, withUnknown, 'hash');
  assert.ok(existsSync(join(runDir, 'flow.json')));
});

test('the Config Hash refuses what a save refuses, by its path', () => {
  assert.throws(() => config.hashOf({ flow: { seen: new Set(['a']) } }), /flow\.seen is a Set/);
});
