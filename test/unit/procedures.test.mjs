import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../../lib/procedures.mjs';

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

test('review describes its actions, checks, lineage and outcome map', () => {
  const { review } = procedures.PROCEDURES;
  assert.ok(review, 'PROCEDURES.review exists');

  // One read-only call, the Findings Hash, the PR comment, the PR body re-render.
  assert.deepEqual(pairs(review.actions), [['review', 1], ['review', 2], ['review', 3], ['review', 4]]);
  assert.deepEqual(pairs(review.actions.filter((a) => a.kind === 'call')), [['review', 1]]);
  assert.ok(review.actions.every((a) => !a.when), 'every review Action runs');
  assert.deepEqual(review.checks, ['review-pass']);
  assert.equal(review.access, 'read-only');
  assert.deepEqual(review.claims, ['ok', 'changes', 'misscoped']);
  assert.deepEqual(review.outcomes, ['ok', 'changes', 'repeat', 'misscoped']);
  assert.deepEqual(review.checkOutcome, { 'review-pass': 'changes' });
  assert.deepEqual(review.briefs, { review: 'reviewBrief' });
  const r = procedures.describe('review');
  assert.deepEqual(r.checks, [{ name: 'review-pass', relaxed: false }]);
  assert.deepEqual(r.lineage, { review: null });
});

test('fix describes its actions, checks, lineage and outcome map', () => {
  const { fix } = procedures.PROCEDURES;
  assert.ok(fix, 'PROCEDURES.fix exists');

  // A fresh fix call, the Green Check with one test-fix that resumes fix, commit kind fix, push, PR upsert.
  assert.deepEqual(fix.actions.filter((a) => !a.when).map((a) => [a.phase, a.ordinal, a.kind]), [
    ['fix', 1, 'call'], ['fix', 2, 'check'], ['fix', 3, 'commit'], ['fix', 4, 'push'], ['fix', 5, 'pr-upsert'],
  ]);
  assert.equal(fix.actions.find((a) => a.phase === 'fix' && a.ordinal === 2).check, 'green');
  assert.deepEqual(pairs(fix.actions.filter((a) => a.when)), [['test-fix', 1], ['test-fix', 2]]);
  assert.deepEqual(fix.claims, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(fix.outcomes, ['ok', 'blocked', 'misscoped', 'gate-failed(test)']);
  assert.equal(fix.checkOutcome.test, 'gate-failed(test)');
  assert.deepEqual(fix.commitKinds, { fix: 'fix' });
  assert.deepEqual(fix.briefs, { fix: 'fixBrief', 'test-fix': 'testFixBrief' });
  const f = procedures.describe('fix');
  assert.deepEqual(f.lineage, { fix: null, 'test-fix': 'fix' });
  assert.ok(f.checks.some((c) => c.name === 'green' && c.relaxed === false), JSON.stringify(f.checks));
  assert.ok(f.checks.some((c) => c.name === 'immutability'), JSON.stringify(f.checks));
});

test('requireTestPass false relaxes the green check in describe', () => {
  const d = procedures.describe('tdd', { requireTestPass: false });
  assert.deepEqual(d.checks, [
    { name: 'red', relaxed: false }, { name: 'immutability', relaxed: false }, { name: 'green', relaxed: true },
  ]);
});

test('zero recovery counts drop their conditional actions from describe', () => {
  const phases = (o) => [...new Set(procedures.describe('tdd', o).actions.map((a) => a.phase))];
  assert.deepEqual(phases({ stillGreen: 0 }), ['red', 'green', 'test-fix']);
  assert.deepEqual(phases({ testFix: 0 }), ['red', 'still-green', 'green']);
  assert.deepEqual(phases({ stillGreen: 0, testFix: 0 }), ['red', 'green']);
});
