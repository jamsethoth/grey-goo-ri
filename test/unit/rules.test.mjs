import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => import('../../lib/rules.mjs');

// Every Rule Table of the example Flow (docs/research/user-defined-procedures-example-flow.md).
const flow = JSON.parse(readFileSync(new URL('../fixtures/rules-flow.json', import.meta.url), 'utf8'));
const [testsFailStopped, implementStopped, fixStopped, reviewPassed, reviewStopped] = flow.tables;

const states = { kind: 'enum', values: ['passed', 'failed', 'not-run'] };

// A ladder of `pass >= k` rows, from `pass >= n` down to `pass >= 1`, each also on `when`: each row is partly taken by
// every earlier row.
const ladder = (name, n, when = {}) => ({
  name,
  fields: { pass: { kind: 'integer', min: 1, max: n + 1 } },
  rows: Array.from({ length: n }, (_, k) => ({ when: { ...when, pass: { '>=': n - k } }, outcome: `o${k}` })),
});

// n booleans, all mentioned by row 0 (every one true); row k > 0 matches b(k) true, so it is partly taken by every
// earlier row.
function booleanTable(name, n, rowCount) {
  const fields = {};
  const all = {};
  for (let i = 0; i < n; i++) {
    fields[`response.b${i}`] = { kind: 'boolean' };
    all[`response.b${i}`] = true;
  }
  const rows = [{ when: all, outcome: 'all' }];
  for (let k = 1; k < rowCount; k++) rows.push({ when: { [`response.b${k}`]: true }, outcome: `b${k}` });
  return { name, fields, rows };
}

// Five 10-value enums, all mentioned by row 0; row k matches one distinct (e0, e1) pair, so no two rows overlap.
function enumGrid(name, rowCount) {
  const fields = {};
  for (let f = 0; f < 5; f++) fields[`response.e${f}`] = { kind: 'enum', values: Array.from({ length: 10 }, (_, v) => `v${v}`) };
  const rows = [{ when: { 'response.e0': 'v0', 'response.e1': 'v0', 'response.e2': 'v0', 'response.e3': 'v0', 'response.e4': 'v0' }, outcome: 'o0' }];
  for (let k = 1; k < rowCount; k++) rows.push({ when: { 'response.e0': `v${k % 10}`, 'response.e1': `v${Math.floor(k / 10)}` }, outcome: `o${k}` });
  return { name, fields, rows };
}

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
      'inputs.prior.verdict': { kind: 'enum', values: ['ok', 'changes'], absent: true },
      'inputs.prior.count': { kind: 'integer', min: 0, absent: true },
    },
    rows: [
      { when: { 'inputs.prior.verdict': 'ok' }, outcome: 'ok' },
      { when: { 'inputs.prior.count': { '>=': 0 } }, outcome: 'counted' },
    ],
  };
  assert.equal(rules.evaluate(table, { inputs: {} }), null);
  assert.equal(rules.evaluate(table, { inputs: { prior: { count: 3 } } }), 1);

  // `absent` is in the analysed domain: a present count always matches row 2, so only an absent one falls through.
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
  assert.equal(result.defaultExample.inputs?.prior?.count, undefined);
});

test('a row covered by earlier rows is an error', async () => {
  const rules = await load();
  const table = {
    name: 'implement.failed',
    fields: { 'check.test': states, 'response.flaky': { kind: 'boolean' } },
    rows: [
      { when: { 'response.flaky': true }, outcome: 'retry' },
      { when: { 'response.flaky': false }, outcome: 'failed' },
      { when: { 'check.test': 'failed' }, outcome: 'never' },
      { when: { 'check.test': 'skipped' }, outcome: 'nothing' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, [
    { row: 2, message: 'rule table implement.failed: row 3 (never) never fires: earlier rows match every input it matches' },
    { row: 3, message: 'rule table implement.failed: row 4 (nothing) is unreachable: it matches no input' },
  ]);
  assert.equal(result.defaultExample, null);
});

test("a partial overlap is a warning naming both rows' conditions and an example input", async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    fields: { claim: { kind: 'enum', values: ['ok', 'changes'] }, 'response.needsTest': { kind: 'boolean' } },
    rows: [
      { when: { claim: 'ok' }, outcome: 'ok' },
      { when: { 'response.needsTest': true }, outcome: 'retest' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [{
    rows: [1, 1],
    earlier: [[0, 0]],
    more: 0,
    from: null,
    fields: ['claim', 'response.needsTest'],
    example: { claim: 'ok', response: { needsTest: true } },
    message: 'rule table review.passed: row 2 (response.needsTest = true) is partly taken by ' +
      'row 1 (claim = ok), for example {"claim":"ok","response":{"needsTest":true}}',
  }]);
  assert.deepEqual(result.defaultExample, { claim: 'changes', response: { needsTest: false } });
});

test('a run of rows taken the same way is one warning', async () => {
  const rules = await load();
  const table = {
    name: 'fix.failed',
    fields: { pass: { kind: 'integer', min: 1, max: 5 } },
    rows: [
      { when: { pass: { '>=': 4 } }, outcome: 'four' },
      { when: { pass: { '>=': 3 } }, outcome: 'three' },
      { when: { pass: { '>=': 2 } }, outcome: 'two' },
      { when: { pass: { '>=': 1 } }, outcome: 'one' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  const [w] = result.warnings;
  assert.deepEqual([w.rows, w.earlier, w.from, w.fields], [[1, 3], [[0, 0]], 0, ['pass']]);
  assert.match(w.message, /^rule table fix\.failed: rows 2-4 are each partly taken by every earlier firing row, all on pass, for example \{"pass":\d\}$/);
  assert.equal(rules.evaluate(table, w.example), 0);
  assert.equal(rules.evaluate({ ...table, rows: [table.rows[1]] }, w.example), 0);
  assert.equal(result.defaultExample, null);
});

test('rows taken by the same earlier rows are one warning', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    fields: { x: { kind: 'boolean' }, y: { kind: 'boolean' } },
    rows: [
      { when: { x: true }, outcome: 'x' },
      { when: { y: true }, outcome: 'y' },
      { when: { y: false }, outcome: 'not-y' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.from]), [[[1, 2], [[0, 0]], null]]);
  assert.match(result.warnings[0].message, /: rows 2-3 are each partly taken by row 1, all on x, y, for example/);
});

test('a run names only the earlier rows that fire', async () => {
  const rules = await load();
  const table = {
    name: 'fix.failed',
    fields: { n: { kind: 'integer' } },
    rows: [
      { when: { n: { '>=': 4 } }, outcome: 'four' },
      { when: { n: { '>=': 4 } }, outcome: 'again' },
      { when: { n: { '>=': 3 } }, outcome: 'three' },
      { when: { n: { '>=': 2 } }, outcome: 'two' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors.map(e => e.row), [1]);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.from]), [[[2, 3], [[0, 0]], 0]]);
  assert.match(result.warnings[0].message, /: rows 3-4 are each partly taken by every earlier firing row, all on n, for example/);
});

test('a ladder after an unrelated row is one warning', async () => {
  const rules = await load();
  // Row 1 takes no part of the ladder, so the ladder's rows are each taken by every earlier firing row from row 2.
  const table = {
    name: 'fix.failed',
    fields: { mode: { kind: 'boolean' }, pass: { kind: 'integer', min: 1, max: 1_001 } },
    rows: [{ when: { mode: false }, outcome: 'off' }, ...ladder('', 1_000, { mode: true }).rows],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.from]), [[[2, 1_000], [[1, 1]], 1]]);
  assert.match(result.warnings[0].message, /: rows 3-1001 are each partly taken by every earlier firing row from row 2, all on mode, pass, for example/);
});

test('a warning names at most ten earlier rows and counts the rest', async () => {
  const rules = await load();
  const table = {
    name: 'plan.passed',
    fields: { n: { kind: 'integer' } },
    rows: [
      { when: { n: { '=': 0 } }, outcome: 'o0' },
      { when: { n: { '=': 1 } }, outcome: 'o1' },
      { when: { n: { '=': 2 } }, outcome: 'o2' },
      { when: { n: { '=': 3 } }, outcome: 'o3' },
      { when: { n: { '=': 4 } }, outcome: 'o4' },
      { when: { n: { '=': 5 } }, outcome: 'o5' },
      { when: { n: { '=': 6 } }, outcome: 'o6' },
      { when: { n: { '=': 7 } }, outcome: 'o7' },
      { when: { n: { '=': 8 } }, outcome: 'o8' },
      { when: { n: { '=': 9 } }, outcome: 'o9' },
      { when: { n: { '=': 10 } }, outcome: 'o10' },
      { when: { n: { '=': 11 } }, outcome: 'o11' },
      { when: { n: { '>=': 0 } }, outcome: 'rest' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.more]), [[[12, 12], [[0, 9]], 2]]);
  assert.match(result.warnings[0].message, /: row 13 \(n >= 0\) is partly taken by row 1 \(n = 0\), row 2 \(n = 1\), .*, row 10 \(n = 9\), and 2 more rows, for example/);
  assert.doesNotMatch(result.warnings[0].message, /row 11 \(/);
});

test('rows that share their first ten earlier rows but not the rest are separate warnings', async () => {
  const rules = await load();
  const table = {
    name: 'plan.passed',
    fields: { n: { kind: 'integer' } },
    rows: [
      { when: { n: { '=': 0 } }, outcome: 'o0' },
      { when: { n: { '=': 1 } }, outcome: 'o1' },
      { when: { n: { '=': 2 } }, outcome: 'o2' },
      { when: { n: { '=': 3 } }, outcome: 'o3' },
      { when: { n: { '=': 4 } }, outcome: 'o4' },
      { when: { n: { '=': 5 } }, outcome: 'o5' },
      { when: { n: { '=': 6 } }, outcome: 'o6' },
      { when: { n: { '=': 7 } }, outcome: 'o7' },
      { when: { n: { '=': 8 } }, outcome: 'o8' },
      { when: { n: { '=': 9 } }, outcome: 'o9' },
      { when: { n: { '=': 10 } }, outcome: 'o10' },
      { when: { n: { '=': 11 } }, outcome: 'o11' },
      { when: { n: { '>=': 0 } }, outcome: 'rest' },
      { when: { n: { '<=': 10 } }, outcome: 'low' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  // Row 13 is taken by rows 1-12 and row 14 by rows 1-11: the same first ten, different sets.
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.more]), [[[12, 12], [[0, 9]], 2], [[13, 13], [[0, 9]], 1]]);
  assert.match(result.warnings[1].message, /, row 10 \(n = 9\), and 1 more row, for example/);
});

test("analysis leaves the fields' value lists unchanged", async () => {
  const rules = await load();
  const values = Object.freeze(['ok', 'changes']);
  const table = {
    name: 'fix.passed',
    fields: { 'inputs.prior.verdict': { kind: 'enum', values, absent: true } },
    rows: [{ when: { 'inputs.prior.verdict': 'changes' }, outcome: 'changes' }],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(values, ['ok', 'changes']);
});

test("integer intervals are cut at the table's constants", async () => {
  const rules = await load();
  const fields = { 'response.count': { kind: 'integer' } };

  // Testing only the boundary values 0 and 10 would wrongly call row 3 never-firing; 1 reaches it.
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
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier]), [[[2, 2], [[0, 1]]]]);
  assert.match(result.warnings[0].message, /row 3 \(response\.count >= 0 and response\.count <= 10\) is partly taken by row 1 \(response\.count = 0\), row 2 \(response\.count = 10\)/);
  assert.equal(rules.evaluate(ranges, { response: { count: 1 } }), 2);
  assert.notEqual(result.defaultExample, null);
  assert.equal(rules.evaluate(ranges, result.defaultExample), null);

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

  // The field's own bounds cut too: within 0 to 10, the ranges table leaves nothing to the default.
  const bounded = rules.analyse({ ...ranges, fields: { 'response.count': { kind: 'integer', min: 0, max: 10 } } });
  assert.deepEqual(bounded.errors, []);
  assert.equal(bounded.defaultExample, null);
});

test('integer intervals stay exact beyond the safe integers', async () => {
  const rules = await load();
  const table = {
    name: 'plan.passed',
    fields: { n: { kind: 'integer' } },
    rows: [
      { when: { n: { '>': 2 ** 54 } }, outcome: 'above' },
      { when: { n: { '<': -(2 ** 54) } }, outcome: 'below' },
    ],
  };
  assert.equal(rules.evaluate(table, { n: 2 ** 54 + 4 }), 0);
  assert.equal(rules.evaluate(table, { n: -(2 ** 54) - 4 }), 1);
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.notEqual(result.defaultExample, null);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
});

test('a witness for a __proto__ path is an own property and leaves prototypes alone', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    fields: { 'response.__proto__.rulesProbe': { kind: 'boolean' } },
    rows: [{ when: { 'response.__proto__.rulesProbe': true }, outcome: 'ok' }],
  };
  const result = rules.analyse(table);
  assert.equal(Object.hasOwn(Object.prototype, 'rulesProbe'), false);
  assert.deepEqual(result.errors, []);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
  assert.ok(Object.hasOwn(result.defaultExample.response, '__proto__'));
  assert.equal(Object.getPrototypeOf(result.defaultExample.response), Object.prototype);
});

test("the example Flow's tables have no unreachable or never-firing row", async () => {
  const rules = await load();
  assert.deepEqual(rules.analyse(testsFailStopped).errors, []);
  assert.deepEqual(rules.analyse(implementStopped).errors, []);
  assert.deepEqual(rules.analyse(fixStopped).errors, []);
  assert.deepEqual(rules.analyse(reviewPassed).errors, []);
  assert.deepEqual(rules.analyse(reviewStopped).errors, []);
});

test('the example review table reports three overlaps in two row warnings', async () => {
  const rules = await load();
  const result = rules.analyse(reviewPassed);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier]), [[[1, 1], [[0, 0]]], [[2, 2], [[0, 1]]]]);
  assert.match(result.warnings[0].message, /row 2 \(check\.repeat = failed\) is partly taken by row 1 \(claim = ok and check\.review-pass = passed\), for example/);
  assert.match(result.warnings[1].message, /row 3 \(response\.needsTest = true\) is partly taken by row 1 \(claim = ok and check\.review-pass = passed\), row 2 \(check\.repeat = failed\), for example/);
  assert.equal(rules.evaluate(reviewPassed, result.warnings[1].example), 0);
  assert.equal(rules.evaluate({ ...reviewPassed, rows: [reviewPassed.rows[2]] }, result.warnings[1].example), 0);
  assert.equal(rules.evaluate(reviewPassed, result.defaultExample), null);
});

test('rows that never fire do not cost memory per pair', async () => {
  const rules = await load();
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ when: {}, outcome: `o${i}` }));
  const before = process.memoryUsage().heapUsed;
  const result = rules.analyse({ name: 'heavy.passed', fields: {}, rows });
  const grown = process.memoryUsage().heapUsed - before;
  assert.equal(result.errors.length, 9_999);
  assert.deepEqual(result.warnings, []);
  assert.ok(grown < 32 * 2 ** 20, `the heap grew by ${grown} bytes`);
});

test('a long run of overlapping rows is one warning and costs no memory per pair', async () => {
  const rules = await load();
  const table = ladder('fix.failed', 3_000);
  const before = process.memoryUsage().heapUsed;
  const result = rules.analyse(table);
  const grown = process.memoryUsage().heapUsed - before;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.from]), [[[1, 2_999], 0]]);
  assert.ok(grown < 32 * 2 ** 20, `the heap grew by ${grown} bytes`);
});

test('a table just under the work limit is analysed', async () => {
  const rules = await load();
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 2**20 points times 9 rows is 9,437,184 row checks.
  const result = rules.analyse(booleanTable('wide.passed', 20, 9));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.from]), [[[1, 8], 0]]);
});

test('a table exactly at the work limit is analysed', async () => {
  const rules = await load();
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 10**5 points times 100 rows is exactly 10,000,000 row checks.
  const result = rules.analyse(enumGrid('grid.passed', 100));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a table just over it (many booleans) is an error naming the table', async () => {
  const rules = await load();
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 2**20 points times 10 rows is 10,485,760 row checks.
  const result = rules.analyse(booleanTable('wide.failed', 20, 10));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.match(result.errors[0].message, /^rule table wide\.failed needs 10485760 row checks, above the limit of 10000000; its largest fields: response\.b0 \(2 values\)/);
  assert.deepEqual(result.warnings, []);
});

// Two Claim tokens' boxes (J16): each box is a whole field map, and the table's domain is their union.
const tokenBoxes = (fields, ...tokens) => tokens.map(token => ({ ...fields, claim: { kind: 'enum', values: [token] } }));

test('a row taken in one box and free in another is partly taken', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    boxes: tokenBoxes({}, 'a', 'b'),
    rows: [
      { when: { claim: 'a' }, outcome: 'x' },
      { when: {}, outcome: 'z' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.example]), [[[1, 1], [[0, 0]], { claim: 'a' }]]);
  assert.equal(result.warnings[0].message,
    'rule table review.passed: row 2 (no conditions) is partly taken by row 1 (claim = a), for example {"claim":"a"}');
  assert.equal(result.defaultExample, null);
  assert.deepEqual(result.falls, []);
});

test('a row taken in two boxes by different rows gets one warning naming both', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    boxes: tokenBoxes({ 'response.flag': { kind: 'boolean' } }, 'a', 'b', 'c'),
    rows: [
      { when: { claim: 'a', 'response.flag': true }, outcome: 'x' },
      { when: { claim: 'b', 'response.flag': true }, outcome: 'y' },
      { when: { 'response.flag': true }, outcome: 'z' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => [w.rows, w.earlier, w.more]), [[[2, 2], [[0, 1]], 0]]);
  assert.match(result.warnings[0].message, /^rule table review\.passed: row 3 \(response\.flag = true\) is partly taken by row 1 \(claim = a and response\.flag = true\), row 2 \(claim = b and response\.flag = true\), for example /);
  // Every box has a false flag that no row matches.
  assert.deepEqual(result.falls, [0, 1, 2]);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
});

test('the work limit counts every box', async () => {
  const rules = await load();
  // Each box is 2**20 points times 5 rows, 5,242,880 row checks; the two together are 10,485,760.
  const { fields, rows } = booleanTable('wide.passed', 20, 5);
  const result = rules.analyse({ name: 'wide.passed', boxes: tokenBoxes(fields, 'a', 'b'), rows });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.match(result.errors[0].message, /^rule table wide\.passed needs 10485760 row checks, above the limit of 10000000; /);
  assert.deepEqual(result.warnings, []);
});

test('only the boxes with an input no row matches fall', async () => {
  const rules = await load();
  const table = {
    name: 'review.passed',
    boxes: tokenBoxes({ 'response.flag': { kind: 'boolean' } }, 'a', 'b', 'c'),
    rows: [
      { when: { claim: 'a' }, outcome: 'x' },
      { when: { claim: 'b', 'response.flag': true }, outcome: 'y' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.falls, [1, 2]);
  assert.deepEqual(result.defaultExample, { claim: 'b', response: { flag: false } });
});
