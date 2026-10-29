import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../../lib/procedures.mjs';

// An Action after the recovery passes has no Recovery Number of its own: it carries the Visit's.
const pairs = (actions) => actions.map((a) => [a.id, a.recovery ?? null]);

test('tests-fail describes its actions, Checks, lineage and outcomes in order', () => {
  const p = procedures.PROCEDURES['tests-fail'];
  assert.deepEqual(p.options, { stillGreen: 1 });
  assert.deepEqual(p.requires, ['red-check']);
  assert.equal(p.tests, 'write');
  assert.deepEqual(p.briefs, { red: 'red.md', 'still-green': 'still-green.md' });
  assert.deepEqual(p.claims, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.commitKinds, { red: 'test' });
  assert.deepEqual(p.actions[1], { id: 'red-check', phase: 'red', recovery: 0, kind: 'check', check: 'tests-fail', command: 'test', names: 'response.tests' });
  assert.deepEqual(p.actions[2].when, { recover: 'red-check' });

  const d = procedures.describe('tests-fail');
  assert.deepEqual(pairs(d.actions.filter((a) => !a.when)), [['red', 0], ['red-check', 0], ['commit', null]]);
  assert.deepEqual(pairs(d.actions.filter((a) => a.when)), [['red', 1], ['red-check', 1]]);
  assert.deepEqual(d.requires, ['red-check']);
  // Session Lineage: the Phase each Phase resumes, or null for a fresh session.
  assert.deepEqual(d.lineage, { red: null, 'still-green': 'red' });
});

test('implement describes its actions, Checks, lineage and outcomes in order', () => {
  const p = procedures.PROCEDURES.implement;
  assert.deepEqual(p.options, { testFix: 1, requireTestPass: true });
  assert.deepEqual(p.requires, ['test']);
  assert.deepEqual(p.briefs, { green: 'green.md', 'test-fix': 'test-fix.md' });
  assert.deepEqual(p.claims, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.commitKinds, { green: 'feat' });
  assert.deepEqual(p.actions[1], { id: 'test', phase: 'green', recovery: 0, kind: 'check', check: 'command', command: 'test' });
  assert.deepEqual(p.actions[2].when, { recover: 'test' });

  const d = procedures.describe('implement');
  assert.deepEqual(pairs(d.actions.filter((a) => !a.when)), [['green', 0], ['test', 0], ['commit', null], ['push', null], ['pr', null]]);
  assert.deepEqual(pairs(d.actions.filter((a) => a.when)), [['green', 1], ['test', 1]]);
  assert.deepEqual(d.requires, ['test']);
  // green starts fresh: no Session crosses Vertices, so there is no option to resume red's (R2c).
  assert.deepEqual(d.lineage, { green: null, 'test-fix': 'green' });
  assert.deepEqual(procedures.describe('implement', { resumeGreen: true }).lineage, { green: null, 'test-fix': 'green' });
});

test('review describes its actions, Checks, lineage, outcomes and passed table', () => {
  const { review } = procedures.PROCEDURES;
  assert.ok(review, 'PROCEDURES.review exists');

  // One read-only call, review-pass and repeat as Checks, the PR comment, the PR body re-render.
  assert.deepEqual(pairs(review.actions), [['review', null], ['review-pass', null], ['repeat', null], ['comment', null], ['pr', null]]);
  assert.deepEqual(pairs(review.actions.filter((a) => a.kind === 'call')), [['review', null]]);
  assert.ok(review.actions.every((a) => !a.when), 'every review Action runs');
  assert.deepEqual(review.actions[1], { id: 'review-pass', phase: 'review', kind: 'check', check: 'response', 'all-of': [
    { field: 'dodMet', is: true }, { field: 'tddEvidenceOk', is: true }, { none: 'findings', where: { severity: ['blocker', 'major'] } },
  ] });
  assert.deepEqual(review.actions[2], { id: 'repeat', phase: 'review', kind: 'check', check: 'repeat', list: 'response.findings', fields: ['file', 'severity', 'issue'] });
  // No Claim requires a Check (P5a): the passed table's first row is the only way to ok.
  assert.deepEqual(review.requires, []);
  assert.deepEqual(review.passed, [{ when: { claim: 'ok', 'check.review-pass': 'passed' }, outcome: 'ok' }]);
  assert.equal(review.otherwise, 'changes');
  assert.equal(review.access, 'read-only');
  assert.deepEqual(review.claims, ['ok', 'changes', 'misscoped']);
  assert.deepEqual(review.outcomes, ['ok', 'changes', 'repeat', 'misscoped']);
  assert.deepEqual(review.briefs, { review: 'review.md' });
  const r = procedures.describe('review');
  assert.deepEqual(r.requires, []);
  assert.deepEqual(r.lineage, { review: null });
});

test('fix describes its actions, Checks, lineage and outcomes', () => {
  const { fix } = procedures.PROCEDURES;
  assert.ok(fix, 'PROCEDURES.fix exists');

  // A fresh fix call, the test command Check with one test-fix that resumes fix, commit kind fix, push, PR upsert.
  assert.deepEqual(fix.actions.filter((a) => !a.when).map((a) => [a.id, a.recovery ?? null, a.kind]), [
    ['fix', 0, 'call'], ['test', 0, 'check'], ['commit', null, 'commit'], ['push', null, 'push'], ['pr', null, 'pr-upsert'],
  ]);
  assert.equal(fix.actions.find((a) => a.id === 'test' && a.recovery === 0).check, 'command');
  assert.deepEqual(pairs(fix.actions.filter((a) => a.when)), [['fix', 1], ['test', 1]]);
  assert.deepEqual(fix.claims, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(fix.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(fix.commitKinds, { fix: 'fix' });
  assert.deepEqual(fix.briefs, { fix: 'fix.md', 'test-fix': 'test-fix.md' });
  const f = procedures.describe('fix');
  assert.deepEqual(f.lineage, { fix: null, 'test-fix': 'fix' });
  assert.deepEqual(f.requires, ['test']);
});

test('requireTestPass false relaxes the test Check in describe', () => {
  assert.deepEqual(procedures.describe('implement', { requireTestPass: false }).requires, []);
});

test('zero recovery counts drop their conditional actions from describe', () => {
  const phases = (name, o) => [...new Set(procedures.describe(name, o).actions.map((a) => a.phase))];
  assert.deepEqual(phases('tests-fail', { stillGreen: 0 }), ['red']);
  assert.deepEqual(phases('implement', { testFix: 0 }), ['green']);
  assert.deepEqual(phases('tests-fail', {}), ['red', 'still-green']);
  assert.deepEqual(phases('implement', {}), ['green', 'test-fix']);
});

test('an Action id names one Action of its Procedure in each recovery pass', () => {
  for (const [name, p] of Object.entries(procedures.PROCEDURES)) {
    const keys = p.actions.map((a) => `${a.id}/${a.recovery ?? 'after'}`);
    assert.equal(new Set(keys).size, keys.length, `${name}: ${keys}`);
    assert.ok(p.actions.every((a) => /^[^:\s]+$/.test(a.id)), `${name}: no ':' or whitespace in an Action id`);
    // A recovery pass repeats only the first pass's Actions, so each of its ids resumes one already run.
    const first = new Set(p.actions.filter((a) => a.recovery === 0).map((a) => a.id));
    assert.ok(p.actions.filter((a) => a.recovery > 0).every((a) => first.has(a.id)), name);
  }
});
