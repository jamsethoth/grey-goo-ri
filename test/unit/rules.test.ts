import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as checks from '../../lib/checks.ts';
import * as procedures from '../../lib/procedures.ts';
import * as rules from '../../lib/rules.ts';

// Every Rule Table of the example Flow (docs/research/user-defined-procedures-example-flow.md).
const flow: { tables: rules.RuleTable[] } = JSON.parse(
  readFileSync(new URL('../fixtures/rules-flow.json', import.meta.url), 'utf8'),
);
const [testsFailStopped, implementStopped, fixStopped, reviewPassed, reviewStopped] = flow.tables;

const states: rules.FieldSpec = { kind: 'enum', values: ['passed', 'failed', 'not-run'] };

// A ladder of `pass >= k` rows, from `pass >= rungs` down to `pass >= 1`, each also on `when`: each row is partly
// taken by every earlier row.
const ladder = (name: string, rungs: number, when = {}): rules.RuleTable => ({
  name,
  fields: { pass: { kind: 'integer', min: 1, max: rungs + 1 } },
  rows: Array.from({ length: rungs }, (_, i) => ({ when: { ...when, pass: { '>=': rungs - i } }, outcome: `o${i}` })),
});

// `booleans` booleans, all mentioned by row 0 (every one true); row i > 0 matches b(i) true, so it is partly taken by
// every earlier row.
function booleanTable(name: string, booleans: number, rowCount: number) {
  const fields: rules.FieldMap = {};
  const all: Record<string, rules.Condition> = {};
  for (let i = 0; i < booleans; i++) {
    fields[`response.b${i}`] = { kind: 'boolean' };
    all[`response.b${i}`] = true;
  }
  const rows: rules.RuleRow[] = [{ when: all, outcome: 'all' }];
  for (let i = 1; i < rowCount; i++) rows.push({ when: { [`response.b${i}`]: true }, outcome: `b${i}` });
  return { name, fields, rows };
}

// Five 10-value enums, all mentioned by row 0; row k matches one distinct (e0, e1) pair, so no two rows overlap.
function enumGrid(name: string, rowCount: number) {
  const fields: rules.FieldMap = {};
  for (let field = 0; field < 5; field++)
    fields[`response.e${field}`] = { kind: 'enum', values: Array.from({ length: 10 }, (_, value) => `v${value}`) };
  const rows: rules.RuleRow[] = [
    {
      when: { 'response.e0': 'v0', 'response.e1': 'v0', 'response.e2': 'v0', 'response.e3': 'v0', 'response.e4': 'v0' },
      outcome: 'o0',
    },
  ];
  for (let i = 1; i < rowCount; i++)
    rows.push({ when: { 'response.e0': `v${i % 10}`, 'response.e1': `v${Math.floor(i / 10)}` }, outcome: `o${i}` });
  return { name, fields, rows };
}

test('first match picks the earliest matching row', () => {
  const input = { claim: 'ok', check: { 'review-pass': 'passed', repeat: 'failed' }, response: { needsTest: true } };
  assert.equal(rules.evaluate(reviewPassed, input), 0);
  assert.equal(rules.evaluate(reviewPassed, { ...input, claim: 'changes' }), 1);
  assert.equal(
    rules.evaluate(reviewPassed, { ...input, claim: 'changes', check: { 'review-pass': 'passed', repeat: 'passed' } }),
    2,
  );
  assert.equal(
    rules.evaluate(reviewPassed, {
      claim: 'changes',
      check: { 'review-pass': 'failed', repeat: 'passed' },
      response: { needsTest: false },
    }),
    null,
  );
});

test('an absent input matches no condition on its fields', () => {
  const table: rules.RuleTable = {
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
  assert.equal((result.defaultExample as { inputs?: { prior?: { count?: number } } }).inputs?.prior?.count, undefined);
});

test('a row covered by earlier rows is an error', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.errors.map(({ row, code }) => ({ row, code })),
    [
      { row: 2, code: 'never-firing-row' },
      { row: 3, code: 'unreachable-row' },
    ],
  );
  assert.equal(result.defaultExample, null);
});

test('a row on a field the table does not declare is one error for the table', () => {
  const result = rules.analyse({ name: 'fix.failed', fields: {}, rows: [{ when: { pass: 1 }, outcome: 'one' }] });
  assert.deepEqual(
    result.errors.map(({ row, code }) => ({ row, code })),
    [{ row: null, code: 'undeclared-rule-field' }],
  );
});

test("a partial overlap is a warning naming both rows' conditions and an example input", () => {
  const table: rules.RuleTable = {
    name: 'review.passed',
    fields: { claim: { kind: 'enum', values: ['ok', 'changes'] }, 'response.needsTest': { kind: 'boolean' } },
    rows: [
      { when: { claim: 'ok' }, outcome: 'ok' },
      { when: { 'response.needsTest': true }, outcome: 'retest' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    {
      rows: [1, 1],
      earlier: [[0, 0]],
      more: 0,
      from: null,
      fields: ['claim', 'response.needsTest'],
      example: { claim: 'ok', response: { needsTest: true } },
      table: 'review.passed',
      conditions: [
        { row: 1, when: { 'response.needsTest': true } },
        { row: 0, when: { claim: 'ok' } },
      ],
      code: 'overlapping-rows',
      message:
        'rule table review.passed: row 2 (response.needsTest = true) is partly taken by ' +
        'row 1 (claim = ok), for example {"claim":"ok","response":{"needsTest":true}}',
    },
  ]);
  assert.deepEqual(result.defaultExample, { claim: 'changes', response: { needsTest: false } });
});

test('a run of rows taken the same way is one warning', () => {
  const table: rules.RuleTable = {
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
  const [warning] = result.warnings;
  assert.deepEqual(
    { rows: warning.rows, earlier: warning.earlier, from: warning.from, fields: warning.fields },
    { rows: [1, 3], earlier: [[0, 0]], from: 0, fields: ['pass'] },
  );
  assert.match(
    warning.message,
    new RegExp(
      String.raw`^rule table fix\.failed: rows 2-4 are each partly taken by every earlier firing row, ` +
        String.raw`all on pass, for example \{"pass":\d\}$`,
    ),
  );
  assert.equal(rules.evaluate(table, warning.example), 0);
  assert.equal(rules.evaluate({ ...table, rows: [table.rows[1]] }, warning.example), 0);
  assert.equal(result.defaultExample, null);
});

/* eslint-disable id-length -- the tables' fields n, x and y are the names the expected messages quote */
test('rows taken by the same earlier rows are one warning', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, from }) => ({ rows, earlier, from })),
    [{ rows: [1, 2], earlier: [[0, 0]], from: null }],
  );
  assert.match(result.warnings[0].message, /: rows 2-3 are each partly taken by row 1, all on x, y, for example/);
});

test('a run names only the earlier rows that fire', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.errors.map(({ row }) => row),
    [1],
  );
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, from }) => ({ rows, earlier, from })),
    [{ rows: [2, 3], earlier: [[0, 0]], from: 0 }],
  );
  assert.match(
    result.warnings[0].message,
    /: rows 3-4 are each partly taken by every earlier firing row, all on n, for example/,
  );
});

test('a ladder after an unrelated row is one warning', () => {
  // Row 1 takes no part of the ladder, so the ladder's rows are each taken by every earlier firing row from row 2.
  const table: rules.RuleTable = {
    name: 'fix.failed',
    fields: { mode: { kind: 'boolean' }, pass: { kind: 'integer', min: 1, max: 1_001 } },
    rows: [{ when: { mode: false }, outcome: 'off' }, ...ladder('', 1_000, { mode: true }).rows],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, from }) => ({ rows, earlier, from })),
    [{ rows: [2, 1_000], earlier: [[1, 1]], from: 1 }],
  );
  assert.match(
    result.warnings[0].message,
    /: rows 3-1001 are each partly taken by every earlier firing row from row 2, all on mode, pass, for example/,
  );
});

test('a warning names at most ten earlier rows and counts the rest', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, more }) => ({ rows, earlier, more })),
    [{ rows: [12, 12], earlier: [[0, 9]], more: 2 }],
  );
  assert.match(
    result.warnings[0].message,
    new RegExp(
      String.raw`: row 13 \(n >= 0\) is partly taken by row 1 \(n = 0\), row 2 \(n = 1\), .*, ` +
        String.raw`row 10 \(n = 9\), and 2 more rows, for example`,
    ),
  );
  assert.doesNotMatch(result.warnings[0].message, /row 11 \(/);
  // The conditions the sentence quotes, the row's own and its ten named takers', and no more.
  assert.deepEqual(
    result.warnings[0].conditions.map(({ row }) => row),
    [12, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(result.warnings[0].conditions[0].when, { n: { '>=': 0 } });
});

test('rows that share their first ten earlier rows but not the rest are separate warnings', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, more }) => ({ rows, earlier, more })),
    [
      { rows: [12, 12], earlier: [[0, 9]], more: 2 },
      { rows: [13, 13], earlier: [[0, 9]], more: 1 },
    ],
  );
  assert.match(result.warnings[1].message, /, row 10 \(n = 9\), and 1 more row, for example/);
});

/* eslint-enable id-length */

test("analysis leaves the fields' value lists unchanged", () => {
  const values = Object.freeze(['ok', 'changes']);
  const table: rules.RuleTable = {
    name: 'fix.passed',
    // Frozen, so analysis would throw if it changed the list.
    fields: { 'inputs.prior.verdict': { kind: 'enum', values: values as string[], absent: true } },
    rows: [{ when: { 'inputs.prior.verdict': 'changes' }, outcome: 'changes' }],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(values, ['ok', 'changes']);
});

test("integer intervals are cut at the table's constants", () => {
  const fields: rules.FieldMap = { 'response.count': { kind: 'integer' } };

  // Testing only the boundary values 0 and 10 would wrongly call row 3 never-firing; 1 reaches it.
  const ranges: rules.RuleTable = {
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
  assert.deepEqual(
    result.warnings.map(({ rows, earlier }) => ({ rows, earlier })),
    [{ rows: [2, 2], earlier: [[0, 1]] }],
  );
  assert.match(
    result.warnings[0].message,
    new RegExp(
      String.raw`row 3 \(response\.count >= 0 and response\.count <= 10\) ` +
        String.raw`is partly taken by row 1 \(response\.count = 0\), ` +
        String.raw`row 2 \(response\.count = 10\)`,
    ),
  );
  assert.equal(rules.evaluate(ranges, { response: { count: 1 } }), 2);
  assert.notEqual(result.defaultExample, null);
  assert.equal(rules.evaluate(ranges, result.defaultExample), null);

  const covered: rules.RuleTable = {
    name: 'plan.failed',
    fields,
    rows: [
      { when: { 'response.count': { '<': 5 } }, outcome: 'low' },
      { when: { 'response.count': { '>': 4 } }, outcome: 'high' },
      { when: { 'response.count': { '=': 7 } }, outcome: 'never' },
    ],
  };
  const second = rules.analyse(covered);
  assert.deepEqual(
    second.errors.map(({ row }) => row),
    [2],
  );
  assert.equal(second.defaultExample, null);

  // The field's own bounds cut too: within 0 to 10, the ranges table leaves nothing to the default.
  const bounded = rules.analyse({ ...ranges, fields: { 'response.count': { kind: 'integer', min: 0, max: 10 } } });
  assert.deepEqual(bounded.errors, []);
  assert.equal(bounded.defaultExample, null);
});

/* eslint-disable id-length -- the field n, as the tables above name it */
test('integer intervals stay exact beyond the safe integers', () => {
  const table: rules.RuleTable = {
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

/* eslint-enable id-length */

test('a witness for a __proto__ path is an own property and leaves prototypes alone', () => {
  const table: rules.RuleTable = {
    name: 'review.passed',
    fields: { 'response.__proto__.rulesProbe': { kind: 'boolean' } },
    rows: [{ when: { 'response.__proto__.rulesProbe': true }, outcome: 'ok' }],
  };
  const result = rules.analyse(table);
  assert.equal(Object.hasOwn(Object.prototype, 'rulesProbe'), false);
  assert.deepEqual(result.errors, []);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
  const witness = result.defaultExample as { response: object };
  assert.ok(Object.hasOwn(witness.response, '__proto__'));
  assert.equal(Object.getPrototypeOf(witness.response), Object.prototype);
});

test("the example Flow's tables have no unreachable or never-firing row", () => {
  assert.deepEqual(rules.analyse(testsFailStopped).errors, []);
  assert.deepEqual(rules.analyse(implementStopped).errors, []);
  assert.deepEqual(rules.analyse(fixStopped).errors, []);
  assert.deepEqual(rules.analyse(reviewPassed).errors, []);
  assert.deepEqual(rules.analyse(reviewStopped).errors, []);
});

test('the example review table reports three overlaps in two row warnings', () => {
  const result = rules.analyse(reviewPassed);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map(({ rows, earlier }) => ({ rows, earlier })),
    [
      { rows: [1, 1], earlier: [[0, 0]] },
      { rows: [2, 2], earlier: [[0, 1]] },
    ],
  );
  assert.match(
    result.warnings[0].message,
    new RegExp(
      String.raw`row 2 \(check\.repeat = failed\) ` +
        String.raw`is partly taken by row 1 \(claim = ok and check\.review-pass = passed\), ` +
        String.raw`for example`,
    ),
  );
  assert.match(
    result.warnings[1].message,
    new RegExp(
      String.raw`row 3 \(response\.needsTest = true\) ` +
        String.raw`is partly taken by row 1 \(claim = ok and check\.review-pass = passed\), ` +
        String.raw`row 2 \(check\.repeat = failed\), for example`,
    ),
  );
  assert.equal(rules.evaluate(reviewPassed, result.warnings[1].example), 0);
  assert.equal(rules.evaluate({ ...reviewPassed, rows: [reviewPassed.rows[2]] }, result.warnings[1].example), 0);
  assert.equal(rules.evaluate(reviewPassed, result.defaultExample), null);
});

// The heap is not measured: it moves with garbage collection (docs/testing.md rule 1). What analysis holds per pair of
// rows is bounded by the work limit, whose cases follow; these two pin that a heavy table's result keeps one entry per
// row, or one warning per run, and never a list per pair.
test('rows that never fire are one error each, naming no earlier row', () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ when: {}, outcome: `o${i}` }));
  const result = rules.analyse({ name: 'heavy.passed', fields: {}, rows });
  assert.equal(result.errors.length, 9_999);
  assert.deepEqual(result.errors.at(-1), {
    row: 9_999,
    code: 'never-firing-row',
    message: 'rule table heavy.passed: row 10000 (o9999) never fires: earlier rows match every input it matches',
    params: { table: 'heavy.passed', row: 9_999, outcome: 'o9999' },
  });
  assert.deepEqual(result.warnings, []);
});

test('a long run of overlapping rows is one warning naming only its first taker', () => {
  const result = rules.analyse(ladder('fix.failed', 3_000));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    {
      rows: [1, 2_999],
      earlier: [[0, 0]],
      more: 0,
      from: 0,
      fields: ['pass'],
      example: { pass: 3_000 },
      table: 'fix.failed',
      conditions: [],
      code: 'overlapping-rows',
      message:
        'rule table fix.failed: rows 2-3000 are each partly taken by every earlier firing row, all on pass, ' +
        'for example {"pass":3000}',
    },
  ]);
});

test('a table just under the work limit is analysed', () => {
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 2**20 points times 9 rows is 9,437,184 row checks.
  const result = rules.analyse(booleanTable('wide.passed', 20, 9));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map(({ rows, from }) => ({ rows, from })),
    [{ rows: [1, 8], from: 0 }],
  );
});

test('a table exactly at the work limit is analysed', () => {
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 10**5 points times 100 rows is exactly 10,000,000 row checks.
  const result = rules.analyse(enumGrid('grid.passed', 100));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a table just over it (many booleans) is an error naming the table', () => {
  assert.equal(rules.WORK_LIMIT, 10_000_000);
  // 2**20 points times 10 rows is 10,485,760 row checks.
  const result = rules.analyse(booleanTable('wide.failed', 20, 10));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.equal(result.errors[0].code, 'rule-table-too-large');
  assert.deepEqual(result.errors[0].params, {
    table: 'wide.failed',
    work: 10_485_760,
    limit: 10_000_000,
    largest: [
      ['response.b0', 2],
      ['response.b1', 2],
      ['response.b2', 2],
    ],
  });
  assert.match(result.errors[0].message, /^rule table wide\.failed needs /);
  assert.deepEqual(result.warnings, []);
});

// Two Claim tokens' boxes (J16): each box is a whole field map, and the table's domain is their union.
const tokenBoxes = (fields: rules.FieldMap, ...tokens: string[]): rules.FieldMap[] =>
  tokens.map((token) => ({ ...fields, claim: { kind: 'enum', values: [token] } }));

test('a row taken in one box and free in another is partly taken', () => {
  const table: rules.RuleTable = {
    name: 'review.passed',
    boxes: tokenBoxes({}, 'a', 'b'),
    rows: [
      { when: { claim: 'a' }, outcome: 'x' },
      { when: {}, outcome: 'z' },
    ],
  };
  const result = rules.analyse(table);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, example }) => ({ rows, earlier, example })),
    [{ rows: [1, 1], earlier: [[0, 0]], example: { claim: 'a' } }],
  );
  assert.equal(
    result.warnings[0].message,
    'rule table review.passed: row 2 (no conditions) is partly taken by row 1 (claim = a), for example {"claim":"a"}',
  );
  assert.equal(result.defaultExample, null);
  assert.deepEqual(result.falls, []);
});

test('a row taken in two boxes by different rows gets one warning naming both', () => {
  const table: rules.RuleTable = {
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
  assert.deepEqual(
    result.warnings.map(({ rows, earlier, more }) => ({ rows, earlier, more })),
    [{ rows: [2, 2], earlier: [[0, 1]], more: 0 }],
  );
  assert.match(
    result.warnings[0].message,
    new RegExp(
      String.raw`^rule table review\.passed: row 3 \(response\.flag = true\) ` +
        String.raw`is partly taken by row 1 \(claim = a and response\.flag = true\), ` +
        String.raw`row 2 \(claim = b and response\.flag = true\), for example `,
    ),
  );
  // Every box has a false flag that no row matches.
  assert.deepEqual(result.falls, [0, 1, 2]);
  assert.equal(rules.evaluate(table, result.defaultExample), null);
});

test('the work limit counts every box', () => {
  // Each box is 2**20 points times 5 rows, 5,242,880 row checks; the two together are 10,485,760.
  const { fields, rows } = booleanTable('wide.passed', 20, 5);
  const result = rules.analyse({ name: 'wide.passed', boxes: tokenBoxes(fields, 'a', 'b'), rows });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.equal(result.errors[0].code, 'rule-table-too-large');
  assert.deepEqual(
    result.errors[0].params && 'work' in result.errors[0].params && result.errors[0].params.work,
    10_485_760,
  );
  assert.deepEqual(result.warnings, []);
});

test('only the boxes with an input no row matches fall', () => {
  const table: rules.RuleTable = {
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

// The validator accepts an operator by its name in the one table, so each one it accepts must also run (#198).
test('every operator the validator accepts evaluates in a rule and in a count Check', () => {
  assert.deepEqual(procedures.OPERATORS, Object.keys(procedures.COMPARISONS));
  for (const operator of procedures.OPERATORS) {
    const table = { name: 'count', rows: [{ when: { 'response.n': { [operator]: 1 } }, outcome: 'hit' }] };
    for (const count of [0, 1, 2]) {
      const expected = procedures.COMPARISONS[operator](count, 1);
      // eslint-disable-next-line id-length -- the response field the rule reads
      assert.equal(rules.evaluate(table, { response: { n: count } }) === 0, expected, `rule ${count} ${operator} 1`);
      const findings = Array.from({ length: count }, () => ({ severity: 'minor' }));
      assert.equal(
        checks.responseCheck({ findings }, { count: 'findings', [operator]: 1 }).passed,
        expected,
        `count ${count} ${operator} 1`,
      );
    }
  }
});
