import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as options from '../../lib/options.ts';

const PLAN_SPEC = { values: ['name', 'session'], bools: ['bg'] };
const EVAL_SPEC = { values: ['plan', 'runs', 'reset'], bools: [] };

test('parseOptions: boolean flags never swallow the next argument', () => {
  assert.deepEqual(
    options.parseOptions(['--bg', 'x', '--name=n', '--', '--not-a-flag'], { bools: ['bg'], values: ['name'] }),
    { _: ['x', '--not-a-flag'], bg: true, name: 'n' },
  );
  assert.deepEqual(
    options.parseOptions(['42', '--refresh', '--label', 'A'], { bools: ['refresh'], values: ['label'] }),
    {
      _: ['42'],
      refresh: true,
      label: 'A',
    },
  );
});

test('parseOptions: --finish needs a value', () => {
  const spec = { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] };
  assert.throws(
    () => options.parseOptions(['--finish'], spec),
    (err) => err instanceof options.UsageError && err.message === '--finish needs a value',
  );
  assert.deepEqual(options.parseOptions(['--finish', 'abc'], spec), { _: [], finish: 'abc' });
});

test('parseOptions: a boolean flag given a value is a usage error', () => {
  assert.throws(
    () => options.parseOptions(['--bg=yes'], PLAN_SPEC),
    (err) => err instanceof options.UsageError && err.message === '--bg does not take a value',
  );
  assert.throws(
    () => options.parseOptions(['--bogus'], PLAN_SPEC),
    (err) => err instanceof options.UsageError && err.message === 'unknown option --bogus',
  );
});

test('parseOptions: unknown flags are rejected', () => {
  assert.throws(() => options.parseOptions(['--bgg', 'x'], PLAN_SPEC), /unknown.*--bgg/i);
});

test('parseOptions: --flag=value is parsed, also for empty and = containing values', () => {
  assert.deepEqual(options.parseOptions(['--runs=3', 'a.json'], EVAL_SPEC), { _: ['a.json'], runs: '3' });
  assert.deepEqual(options.parseOptions(['--reset=a=b'], EVAL_SPEC), { _: [], reset: 'a=b' });
  assert.deepEqual(options.parseOptions(['--reset='], EVAL_SPEC), { _: [], reset: '' });
});

test('parseOptions: a value flag with no value is an error', () => {
  assert.throws(() => options.parseOptions(['--plan'], EVAL_SPEC), /--plan.*value/i);
  assert.throws(() => options.parseOptions(['--plan', '--runs', '2'], EVAL_SPEC), /--plan.*value/i);
});

test('parseOptions: -- ends option parsing', () => {
  assert.deepEqual(options.parseOptions(['--bg', '--', '--weird', '--bgg'], PLAN_SPEC), {
    _: ['--weird', '--bgg'],
    bg: true,
  });
});

test('parseOptions: inherited property names are not flags', () => {
  assert.throws(() => options.parseOptions(['--constructor', 'x'], PLAN_SPEC), /unknown/i);
  assert.throws(() => options.parseOptions(['--toString'], PLAN_SPEC), /unknown/i);
  assert.equal(Object.hasOwn(options.parseOptions(['--bg'], PLAN_SPEC), 'toString'), false);
});

test('parseOptions: malformed dashed tokens before -- are rejected', () => {
  assert.throws(() => options.parseOptions(['--b.g', 'x'], PLAN_SPEC), /unknown.*--b\.g/i);
  assert.deepEqual(options.parseOptions(['--', '--b.g'], PLAN_SPEC), { _: ['--b.g'] });
});

test('positiveInteger: rejects overflow and unsafe integers', () => {
  assert.equal(options.positiveInteger('42', 'epic'), 42);
  assert.throws(() => options.positiveInteger('9'.repeat(400), '--runs'), /--runs/);
  assert.throws(() => options.positiveInteger('9007199254740993', 'epic'), /epic/);
});

test('a UsageError is named for its class', () => {
  assert.equal(new options.UsageError('x').name, 'UsageError');
});
