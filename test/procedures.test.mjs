import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../lib/procedures.mjs';

const pairs = (actions) => actions.map((a) => [a.phase, a.ordinal]);

test('tdd describes its actions, checks, lineage and outcome map in order', () => {
  const tdd = procedures.PROCEDURES.tdd;
  assert.deepEqual(tdd.options, { stillGreen: 1, testFix: 1, resumeGreen: false, requireTestPass: true });
  assert.deepEqual(tdd.checks, ['red', 'immutability', 'green']);
  assert.deepEqual(tdd.briefs, { red: 'redBrief', green: 'greenBrief', 'still-green': 'stillGreenBrief', 'test-fix': 'testFixBrief' });
  assert.deepEqual(tdd.claims, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(tdd.outcomes, ['ok', 'blocked', 'misscoped', 'red-failed', 'gate-failed(test)']);
  assert.equal(tdd.checkOutcome.red, 'red-failed');
  assert.equal(tdd.checkOutcome.test, 'gate-failed(test)');
  assert.deepEqual(tdd.commitKinds, { red: 'test', green: 'feat' });

  const d = procedures.describe('tdd');
  assert.deepEqual(pairs(d.actions.filter((a) => !a.when)), [
    ['red', 1], ['red', 2], ['red', 3],
    ['green', 1], ['green', 2], ['green', 3], ['green', 4], ['green', 5],
  ]);
  assert.deepEqual(pairs(d.actions.filter((a) => a.when)), [['still-green', 1], ['still-green', 2], ['test-fix', 1], ['test-fix', 2]]);
  assert.deepEqual(d.checks, [
    { name: 'red', relaxed: false }, { name: 'immutability', relaxed: false }, { name: 'green', relaxed: false },
  ]);
  // Session Lineage: the Phase each Phase resumes, or null for a fresh session.
  assert.deepEqual(d.lineage, { red: null, 'still-green': 'red', green: null, 'test-fix': 'green' });
  assert.equal(procedures.describe('tdd', { resumeGreen: true }).lineage.green, 'red');
});

test('requireTestPass false relaxes the green check in describe', () => {
  const d = procedures.describe('tdd', { requireTestPass: false });
  assert.deepEqual(d.checks, [
    { name: 'red', relaxed: false }, { name: 'immutability', relaxed: false }, { name: 'green', relaxed: true },
  ]);
});
