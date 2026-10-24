import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../lib/rules.mjs');

const states = { enum: ['passed', 'failed', 'not-run'] };

// The example Flow's review `passed` table (docs/research/user-defined-procedures-example-flow.md).
const reviewPassed = {
  name: 'review.passed',
  fields: {
    claim: { enum: ['ok', 'changes'] },
    'check.review-pass': states,
    'check.repeat': states,
    'response.needsTest': { type: 'boolean' },
  },
  rows: [
    { when: { claim: 'ok', 'check.review-pass': 'passed' }, outcome: 'ok' },
    { when: { 'check.repeat': 'failed' }, outcome: 'repeat' },
    { when: { 'response.needsTest': true }, outcome: 'retest' },
  ],
};

const only = (table, i) => ({ ...table, rows: [table.rows[i]] });

test('first match picks the earliest matching row', async () => {
  const rules = await load();
  const input = { claim: 'ok', check: { 'review-pass': 'passed', repeat: 'failed' }, response: { needsTest: true } };
  assert.equal(rules.evaluate(reviewPassed, input), 0);
  assert.equal(rules.evaluate(reviewPassed, { ...input, claim: 'changes' }), 1);
  assert.equal(rules.evaluate(reviewPassed, { ...input, claim: 'changes', check: { 'review-pass': 'passed', repeat: 'passed' } }), 2);
  assert.equal(rules.evaluate(reviewPassed, { claim: 'changes', check: { 'review-pass': 'failed', repeat: 'passed' }, response: { needsTest: false } }), null);
});

test('an absent input matches no condition on its fields', async () => {
  const rules = await load();
  const table = {
    name: 'fix.passed',
    fields: {
      'inputs.prior.verdict': { enum: ['ok', 'changes'], optional: true },
      'inputs.prior.count': { type: 'integer', minimum: 0, optional: true },
    },
    rows: [
      { when: { 'inputs.prior.verdict': 'ok' }, outcome: 'ok' },
      { when: { 'inputs.prior.count': { '>=': 0 } }, outcome: 'counted' },
      { when: {}, outcome: 'fallback' },
    ],
  };
  assert.equal(rules.evaluate(table, { inputs: {} }), 2);
  assert.equal(rules.evaluate(table, { inputs: { prior: { count: 3 } } }), 1);

  // `absent` is part of the analysed domain: a present count always matches row 1, so only an absent one falls through.
  const twoRows = { ...table, rows: table.rows.slice(0, 2) };
  const result = rules.analyse(twoRows);
  assert.deepEqual(result.errors, []);
  assert.equal(rules.evaluate(twoRows, result.defaultExample), null);
  assert.equal(result.defaultExample.inputs?.prior?.count, undefined);
});

test('a row covered by earlier rows is an error', async () => {
  const rules = await load();
  const table = {
    name: 'implement.failed',
    fields: { 'check.test': states, 'response.flaky': { type: 'boolean' } },
    rows: [
      { when: { 'response.flaky': true }, outcome: 'retry' },
      { when: { 'response.flaky': false }, outcome: 'failed' },
      { when: { 'check.test': 'failed' }, outcome: 'never' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors.map(e => e.row), [2]);
  assert.match(result.errors[0].message, /implement\.failed/);
  assert.equal(result.defaultExample, null);
});

test('a partial overlap is a warning with an example input', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    fields: { claim: { enum: ['ok', 'changes'] }, 'response.needsTest': { type: 'boolean' } },
    rows: [
      { when: { claim: 'ok' }, outcome: 'ok' },
      { when: { 'response.needsTest': true }, outcome: 'retest' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  const [w] = result.warnings;
  assert.equal(w.row, 1);
  assert.equal(w.earlier, 0);
  assert.equal(rules.evaluate(table, w.example), 0);
  assert.equal(rules.evaluate(only(table, 1), w.example), 0);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
});

test("integer intervals are cut at the table's constants", async () => {
  const rules = await load();
  const fields = { 'response.count': { type: 'integer' } };

  // Testing only the boundary values 0 and 10 would wrongly call row 2 never-firing; 1 reaches it.
  const ranges = {
    name: 'plan.passed',
    fields,
    rows: [
      { when: { 'response.count': { '=': 0 } }, outcome: 'empty' },
      { when: { 'response.count': { '=': 10 } }, outcome: 'full' },
      { when: { 'response.count': { '>=': 0, '<=': 10 } }, outcome: 'some' },
    ],
  };
  const result = rules.analyse(ranges);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.earlier, w.row]), [[0, 2], [1, 2]]);
  assert.equal(rules.evaluate(ranges, { response: { count: 1 } }), 2);
  const fallen = result.defaultExample.response.count;
  assert.ok(Number.isInteger(fallen) && (fallen < 0 || fallen > 10), `default example ${fallen}`);

  const covered = {
    name: 'plan.failed',
    fields,
    rows: [
      { when: { 'response.count': { '<': 5 } }, outcome: 'low' },
      { when: { 'response.count': { '>': 4 } }, outcome: 'high' },
      { when: { 'response.count': { '=': 7 } }, outcome: 'never' },
    ],
  };
  const second = rules.analyse(covered);
  assert.deepEqual(second.errors.map(e => e.row), [2]);
  assert.equal(second.defaultExample, null);
});

test('the example review table warns three times', async () => {
  const rules = await load();
  const result = rules.analyse(reviewPassed);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.earlier, w.row]), [[0, 1], [0, 2], [1, 2]]);
  for (const w of result.warnings) {
    assert.equal(rules.evaluate(only(reviewPassed, w.earlier), w.example), 0);
    assert.equal(rules.evaluate(only(reviewPassed, w.row), w.example), 0);
  }
  assert.equal(rules.evaluate(reviewPassed, result.defaultExample), null);
});

// n booleans, all mentioned by row 0; row k > 0 matches b(k) false, so every row is reachable.
function booleanTable(name, n, rowCount) {
  const fields = {};
  const all = {};
  for (let i = 0; i < n; i++) {
    fields[`response.b${i}`] = { type: 'boolean' };
    all[`response.b${i}`] = true;
  }
  const rows = [{ when: all, outcome: 'all' }];
  for (let k = 1; k < rowCount; k++) rows.push({ when: { [`response.b${k}`]: false }, outcome: `not-${k}` });
  return { name, fields, rows };
}

function limitShape(limit) {
  const n = Math.floor(Math.log2(limit)) - 3;
  const under = Math.floor(limit / 2 ** n);
  return { n, under, over: under + 1 };
}

test('a table just under the work limit is analysed', async () => {
  const rules = await load();
  assert.ok(Number.isInteger(rules.WORK_LIMIT) && rules.WORK_LIMIT > 0, 'WORK_LIMIT is exported');
  const { n, under } = limitShape(rules.WORK_LIMIT);
  assert.ok(2 ** n * under <= rules.WORK_LIMIT);
  const result = rules.analyse(booleanTable('wide.passed', n, under));
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, (under - 1) * (under - 2) / 2);
});

test('a table just over it (many booleans) is an error naming the table', async () => {
  const rules = await load();
  assert.ok(Number.isInteger(rules.WORK_LIMIT) && rules.WORK_LIMIT > 0, 'WORK_LIMIT is exported');
  const { n, over } = limitShape(rules.WORK_LIMIT);
  assert.ok(2 ** n * over > rules.WORK_LIMIT);
  const result = rules.analyse(booleanTable('wide.failed', n, over));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.match(result.errors[0].message, /wide\.failed/);
  assert.match(result.errors[0].message, /response\.b\d+/);
  assert.deepEqual(result.warnings, []);
});
