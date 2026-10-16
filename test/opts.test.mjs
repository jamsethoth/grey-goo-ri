import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as opts from '../lib/opts.mjs';

const PLAN_SPEC = { values: ['name', 'session'], bools: ['bg'] };
const EVAL_SPEC = { values: ['plan', 'runs', 'reset'], bools: [] };

test('parseOpts: boolean flags never swallow the next argument', () => {
  assert.deepEqual(opts.parseOpts(['--bg', 'x', '--name=n', '--', '--not-a-flag'], { bools: ['bg'], values: ['name'] }), { _: ['x', '--not-a-flag'], bg: true, name: 'n' });
  assert.deepEqual(opts.parseOpts(['42', '--refresh', '--label', 'A'], { bools: ['refresh'], values: ['label'] }), { _: ['42'], refresh: true, label: 'A' });
});

test('parseOpts: --finish needs a value', () => {
  const spec = { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] };
  assert.throws(() => opts.parseOpts(['--finish'], spec), (e) => e instanceof opts.UsageError && e.message === '--finish needs a value');
  assert.deepEqual(opts.parseOpts(['--finish', 'abc'], spec), { _: [], finish: 'abc' });
});

test('parseOpts: a boolean flag given a value is a usage error', () => {
  assert.throws(() => opts.parseOpts(['--bg=yes'], PLAN_SPEC), (e) => e instanceof opts.UsageError && e.message === '--bg does not take a value');
  assert.throws(() => opts.parseOpts(['--bogus'], PLAN_SPEC), (e) => e instanceof opts.UsageError && e.message === 'unknown option --bogus');
});

test('parseOpts: unknown flags are rejected', () => {
  assert.throws(() => opts.parseOpts(['--bgg', 'x'], PLAN_SPEC), /unknown.*--bgg/i);
});

test('parseOpts: --flag=value is parsed, also for empty and = containing values', () => {
  assert.deepEqual(opts.parseOpts(['--runs=3', 'a.json'], EVAL_SPEC), { _: ['a.json'], runs: '3' });
  assert.deepEqual(opts.parseOpts(['--reset=a=b'], EVAL_SPEC), { _: [], reset: 'a=b' });
  assert.throws(() => opts.parseOpts(['--bg=yes'], PLAN_SPEC), /--bg/);
});

test('parseOpts: a value flag with no value is an error', () => {
  assert.throws(() => opts.parseOpts(['--plan'], EVAL_SPEC), /--plan.*value/i);
  assert.throws(() => opts.parseOpts(['--plan', '--runs', '2'], EVAL_SPEC), /--plan.*value/i);
});

test('parseOpts: -- ends option parsing', () => {
  assert.deepEqual(opts.parseOpts(['--bg', '--', '--weird', '--bgg'], PLAN_SPEC), { _: ['--weird', '--bgg'], bg: true });
});

test('parseOpts: inherited property names are not flags', () => {
  assert.throws(() => opts.parseOpts(['--constructor', 'x'], PLAN_SPEC), /unknown/i);
  assert.throws(() => opts.parseOpts(['--toString'], PLAN_SPEC), /unknown/i);
  assert.equal(Object.hasOwn(opts.parseOpts(['--bg'], PLAN_SPEC), 'toString'), false);
});

test('parseOpts: malformed dashed tokens before -- are rejected', () => {
  assert.throws(() => opts.parseOpts(['--b.g', 'x'], PLAN_SPEC), /unknown.*--b\.g/i);
  assert.deepEqual(opts.parseOpts(['--', '--b.g'], PLAN_SPEC), { _: ['--b.g'] });
});

test('positiveInt: rejects overflow and unsafe integers', () => {
  assert.equal(opts.positiveInt('42', 'epic'), 42);
  assert.throws(() => opts.positiveInt('9'.repeat(400), '--runs'), /--runs/);
  assert.throws(() => opts.positiveInt('9007199254740993', 'epic'), /epic/);
});
