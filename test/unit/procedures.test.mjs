import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../../lib/procedures.mjs';

const ids = (actions) => actions.map((a) => a.id);
const STOPS = { blocked: { stop: true }, misscoped: { stop: true } };
const RECOVER = { max: 1, brief: 'recover.md' };

test('tests-fail describes its actions, Checks, Claim tokens, recovery and outcomes in order', () => {
  const p = procedures.PROCEDURES['tests-fail'];
  assert.deepEqual(ids(p.actions), ['red', 'red-check', 'commit']);
  assert.deepEqual(p.claims, { ok: { requires: ['red-check'] }, ...STOPS });
  assert.deepEqual(p.recover, RECOVER);
  assert.equal(p.tests, 'write');
  assert.deepEqual(p.briefs, { red: 'red.md' });
  assert.deepEqual(p.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.commitKinds, { red: 'test' });
  assert.deepEqual(p.actions[1], { id: 'red-check', phase: 'red', kind: 'check', check: 'tests-fail', command: 'test', names: 'response.tests',
    recoverBrief: 'still-green.md' });
  assert.deepEqual(procedures.describe('tests-fail'), { actions: p.actions, claims: p.claims });
});

test('implement describes its actions, Checks, Claim tokens, recovery and outcomes in order', () => {
  const p = procedures.PROCEDURES.implement;
  assert.deepEqual(ids(p.actions), ['green', 'test', 'commit', 'push', 'pr']);
  assert.deepEqual(p.claims, { ok: { requires: ['test'] }, ...STOPS });
  assert.deepEqual(p.recover, RECOVER);
  assert.deepEqual(p.briefs, { green: 'green.md' });
  assert.deepEqual(p.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(p.commitKinds, { green: 'feat' });
  assert.deepEqual(p.actions[1], { id: 'test', phase: 'green', kind: 'check', check: 'command', command: 'test', recoverBrief: 'test-fix.md' });
});

test('review describes its actions, Checks, Claim tokens, outcomes and passed table', () => {
  const { review } = procedures.PROCEDURES;
  // One read-only call, review-pass and repeat as Checks, the PR comment, the PR body re-render.
  assert.deepEqual(ids(review.actions), ['review', 'review-pass', 'repeat', 'comment', 'pr']);
  assert.deepEqual(review.actions[1], { id: 'review-pass', phase: 'review', kind: 'check', check: 'response', 'all-of': [
    { field: 'dodMet', is: true }, { field: 'tddEvidenceOk', is: true }, { none: 'findings', where: { severity: ['blocker', 'major'] } },
  ] });
  assert.deepEqual(review.actions[2], { id: 'repeat', phase: 'review', kind: 'check', check: 'repeat', list: 'response.findings', fields: ['file', 'severity', 'issue'] });
  // No Claim token requires a Check (P5a): the passed table's first row is the only way to ok, and nothing recovers.
  assert.deepEqual(review.claims, { ok: { requires: [] }, changes: { requires: [] }, misscoped: { stop: true } });
  assert.equal(review.recover, undefined);
  assert.deepEqual(review.passed, [{ when: { claim: 'ok', 'check.review-pass': 'passed' }, outcome: 'ok' }]);
  assert.equal(review.otherwise, 'changes');
  assert.equal(review.access, 'read-only');
  assert.deepEqual(review.outcomes, ['ok', 'changes', 'repeat', 'misscoped']);
  assert.deepEqual(review.briefs, { review: 'review.md' });
});

test('fix describes its actions, Checks, Claim tokens, recovery and outcomes', () => {
  const { fix } = procedures.PROCEDURES;
  // A fresh fix call, the test command Check, commit kind fix, push, PR upsert.
  assert.deepEqual(fix.actions.map((a) => [a.id, a.kind]), [['fix', 'call'], ['test', 'check'], ['commit', 'commit'], ['push', 'push'], ['pr', 'pr-upsert']]);
  assert.equal(fix.actions[1].check, 'command');
  assert.deepEqual(fix.claims, { ok: { requires: ['test'] }, ...STOPS });
  assert.deepEqual(fix.recover, RECOVER);
  assert.deepEqual(fix.outcomes, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(fix.commitKinds, { fix: 'fix' });
  assert.deepEqual(fix.briefs, { fix: 'fix.md' });
});

test('a Procedure with no agent Action has the implicit Claim ok requiring every Check', () => {
  assert.deepEqual(procedures.describe('publish').claims, { ok: { requires: ['test'] } });
});

test('an Action id names one Action of its Procedure', () => {
  for (const [name, p] of Object.entries(procedures.PROCEDURES)) {
    const keys = ids(p.actions);
    assert.equal(new Set(keys).size, keys.length, `${name}: ${keys}`);
    assert.ok(p.actions.every((a) => /^[^:\s]+$/.test(a.id)), `${name}: no ':' or whitespace in an Action id`);
  }
});
