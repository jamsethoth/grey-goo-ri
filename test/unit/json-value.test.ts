import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as config from '../../lib/config.ts';
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
];

test('assertJson accepts exactly the values a save reads back unchanged, and names the path to any other', () => {
  for (const [name, value] of CORPUS) {
    const held = { list: ['first', { items: [value] }] };
    const refusal = (() => {
      try {
        jsonValue.assertJson(held, 'the row');
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    })();
    assert.equal(refusal === null, roundTrips(held), `${name}: ${refusal ?? 'accepted'}`);
    if (refusal !== null) assert.match(refusal, /^the row: list\[1\]\.items\[0\] is /, name);
  }
});

test('assertJson names the value itself when the whole value is not JSON', () => {
  assert.throws(() => jsonValue.assertJson(new Map(), 'the row'), /^Error: the row: the value is a Map/);
  assert.throws(() => jsonValue.assertJson(undefined, 'the row'), /^Error: the row: the value is undefined/);
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-json-value-');
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-json-value-');
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-json-value-');
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-json-value-');
  const log = events.eventLog(commonDir);
  const withMap = { ticket: 8, error: 'no label', change: { add: new Map([['a', 1]]), remove: [] } };
  const withSet = { ticket: 8, error: 'no label', change: { add: [], remove: new Set(['a']) } };
  const withUnknown = { ticket: 8, error: 'no label', change: loose };
  // @ts-expect-error a Map in an Event's field
  assert.throws(() => log('label_failed', withMap), /change\.add is a Map/);
  // @ts-expect-error a Set in an Event's field
  assert.throws(() => log('label_failed', withSet), /change\.remove is a Set/);
  assert.deepEqual(events.readEvents(commonDir), [], 'neither Event was appended');
  // @ts-expect-error an unknown as an Event's field
  log('label_failed', withUnknown);
  assert.deepEqual(
    events.readEvents(commonDir).map((event) => event.type),
    ['label_failed'],
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
