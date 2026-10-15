import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as outcome from '../lib/outcome.mjs';

const none = { transient: 0, rateLimited: 0, timeout: 0, parse: 0 };
const completed = { status: 'completed', response: { claim: 'ok' }, failure: null };
const failed = (cls, retryAfterMs = null) => ({ status: 'failed', response: null, failure: { class: cls, retryAfterMs } });
const claim = token => ({ valid: true, claim: token });
const check = (name, passed, integrity = false) => ({ name, passed, integrity, output: passed ? '' : `${name} failed` });
const integrityOk = check('worktree-unchanged', true, true);

function resolve({ result = completed, claim: c = null, checks = [integrityOk], retries = none, policy } = {}) {
  return outcome.resolve(policy ? { result, claim: c, checks, retries, policy } : { result, claim: c, checks, retries });
}

function assertRow(r, row, out, direction) {
  assert.equal(r.row, row);
  assert.equal(r.outcome, out);
  assert.equal(r.direction, direction);
}

test('DEFAULT_POLICY holds the retry budgets by kind', () => {
  assert.deepEqual(outcome.DEFAULT_POLICY, { transient: 2, rateLimited: 2, timeout: 1, parse: 1 });
});

test('row integrity-violation: failed integrity check on a completed ok -> integrity-violation', () => {
  const r = resolve({ claim: claim('ok'), checks: [check('worktree-unchanged', false, true), check('test', true)] });
  assertRow(r, 'integrity-violation', 'integrity-violation', 'stop');
  assert.equal(r.check, 'worktree-unchanged');
});

test('row transient-retry: failed transient within budget -> transient-retry', () => {
  const r = resolve({ result: failed('transient', 1500) });
  assertRow(r, 'transient-retry', 'transient-retry', 'retry');
  assert.equal(r.retryAfterMs, 1500);
});

test('row transient-retry: failed rate-limited within budget -> transient-retry', () => {
  const r = resolve({ result: failed('rate-limited', 60000), retries: { ...none, rateLimited: 1 } });
  assertRow(r, 'transient-retry', 'transient-retry', 'retry');
  assert.equal(r.retryAfterMs, 60000);
});

test('row transient-exhausted: failed transient at budget -> needs-human', () => {
  assertRow(resolve({ result: failed('transient'), retries: { ...none, transient: 2 } }), 'transient-exhausted', 'needs-human', 'stop');
  assertRow(resolve({ result: failed('rate-limited'), retries: { ...none, rateLimited: 2 } }), 'transient-exhausted', 'needs-human', 'stop');
});

test('row run-stop: failed auth, quota or budget -> run-stop', () => {
  for (const cls of ['auth', 'quota', 'budget']) {
    const r = resolve({ result: failed(cls) });
    assertRow(r, 'run-stop', 'run-stop', 'stop');
    assert.equal(r.failureClass, cls);
  }
});

test('row timeout-retry: timed-out or killed within budget -> timeout-retry', () => {
  for (const status of ['timed-out', 'killed']) {
    assertRow(resolve({ result: { status, response: { claim: 'ok' }, failure: null }, claim: claim('ok') }), 'timeout-retry', 'timeout-retry', 'retry');
  }
});

test('row timeout-exhausted: timed-out at budget -> needs-human', () => {
  const r = resolve({ result: { status: 'timed-out', response: null, failure: null }, retries: { ...none, timeout: 1 } });
  assertRow(r, 'timeout-exhausted', 'needs-human', 'stop');
});

test('row unknown-failure: failed unknown -> needs-human', () => {
  assertRow(resolve({ result: failed('unknown') }), 'unknown-failure', 'needs-human', 'stop');
});

test('row parse-retry: completed, invalid claim within budget -> parse-retry', () => {
  const r = resolve({ claim: { valid: false, reason: 'more than one token' } });
  assertRow(r, 'parse-retry', 'parse-retry', 'retry');
});

test('row parse-exhausted: completed, invalid claim at budget -> needs-human', () => {
  const r = resolve({ claim: { valid: false, reason: 'field missing' }, retries: { ...none, parse: 1 } });
  assertRow(r, 'parse-exhausted', 'needs-human', 'stop');
});

test('row blocked: completed, valid blocked -> blocked', () => {
  assertRow(resolve({ claim: claim('blocked') }), 'blocked', 'blocked', 'stop');
});

test('row misscoped: completed, valid misscoped -> misscoped', () => {
  assertRow(resolve({ claim: claim('misscoped') }), 'misscoped', 'misscoped', 'stop');
});

test('row check-failed: completed, valid ok, declared check fails -> check-failed', () => {
  const r = resolve({ claim: claim('ok'), checks: [integrityOk, check('red', true), check('test', false), check('lint', false)] });
  assertRow(r, 'check-failed', 'check-failed', 'retry');
  assert.equal(r.check, 'test');
});

test('row check-exhausted: a failing check with the procedure\'s recovery exhausted -> its failure outcome, stop', () => {
  const r = outcome.resolve({ result: completed, claim: claim('ok'), checks: [integrityOk, check('red', false)], retries: none,
    exhausted: true, failureOutcomes: { red: 'red-failed' } });
  assertRow(r, 'check-exhausted', 'red-failed', 'stop');
  assert.equal(r.check, 'red');
  const unmapped = outcome.resolve({ result: completed, claim: claim('ok'), checks: [check('lint', false)], retries: none, exhausted: true });
  assertRow(unmapped, 'check-exhausted', 'needs-human', 'stop');
});

test('exhausted recovery never overrides a stop claim or a passing check', () => {
  const blocked = outcome.resolve({ result: completed, claim: claim('blocked'), checks: [check('red', false)], retries: none, exhausted: true });
  assertRow(blocked, 'blocked', 'blocked', 'stop');
  assertRow(outcome.resolve({ result: completed, claim: claim('ok'), checks: [check('red', true)], retries: none, exhausted: true }), 'ok', 'ok', 'advance');
});

test('row claim-route: completed, valid changes, every check passing -> changes', () => {
  assertRow(resolve({ claim: claim('changes'), checks: [integrityOk, check('review-pass', true)] }), 'claim-route', 'changes', 'advance');
});

test('row ok: completed, valid ok, every check passing -> ok', () => {
  assertRow(resolve({ claim: claim('ok'), checks: [integrityOk, check('test', true)] }), 'ok', 'ok', 'advance');
});

test('every row fires under a unique name', () => {
  const rows = [
    resolve({ checks: [check('worktree-unchanged', false, true)] }),
    resolve({ result: failed('transient') }),
    resolve({ result: failed('transient'), retries: { ...none, transient: 2 } }),
    resolve({ result: failed('auth') }),
    resolve({ result: { status: 'killed', response: null, failure: null } }),
    resolve({ result: { status: 'killed', response: null, failure: null }, retries: { ...none, timeout: 1 } }),
    resolve({ result: failed('unknown') }),
    resolve({ claim: { valid: false, reason: 'malformed' } }),
    resolve({ claim: { valid: false, reason: 'malformed' }, retries: { ...none, parse: 1 } }),
    resolve({ claim: claim('blocked') }),
    resolve({ claim: claim('misscoped') }),
    outcome.resolve({ result: completed, claim: claim('ok'), checks: [check('test', false)], retries: none, exhausted: true }),
    resolve({ claim: claim('ok'), checks: [check('test', false)] }),
    resolve({ claim: claim('changes') }),
    resolve({ claim: claim('ok') }),
  ].map(r => r.row);
  assert.deepEqual(rows, ['integrity-violation', 'transient-retry', 'transient-exhausted', 'run-stop', 'timeout-retry',
    'timeout-exhausted', 'unknown-failure', 'parse-retry', 'parse-exhausted', 'blocked', 'misscoped', 'check-exhausted',
    'check-failed', 'claim-route', 'ok']);
});

test('integrity beats a timed-out result', () => {
  const r = resolve({ result: { status: 'timed-out', response: null, failure: null }, claim: null, checks: [check('worktree-unchanged', false, true)] });
  assertRow(r, 'integrity-violation', 'integrity-violation', 'stop');
});

test('blocked beats passing checks', () => {
  const r = resolve({ claim: claim('blocked'), checks: [integrityOk, check('test', true), check('lint', true)] });
  assertRow(r, 'blocked', 'blocked', 'stop');
});

test('ok with a failing declared check is a retry naming the check', () => {
  const r = resolve({ claim: claim('ok'), checks: [integrityOk, check('lint', false)] });
  assertRow(r, 'check-failed', 'check-failed', 'retry');
  assert.equal(r.check, 'lint');
});

test('a non-ok non-stop claim routes by its token', () => {
  assertRow(resolve({ claim: claim('changes'), checks: [integrityOk, check('test', true)] }), 'claim-route', 'changes', 'advance');
  assertRow(resolve({ claim: claim('repeat') }), 'claim-route', 'repeat', 'advance');
});

test('a completed result with response null and no claim is a parse retry, then parse-exhausted at budget', () => {
  const result = { status: 'completed', response: null, failure: null };
  assertRow(resolve({ result, claim: null }), 'parse-retry', 'parse-retry', 'retry');
  assertRow(resolve({ result, claim: null, retries: { ...none, parse: 1 } }), 'parse-exhausted', 'needs-human', 'stop');
});

test('a policy overrides the retry budgets', () => {
  const policy = { ...outcome.DEFAULT_POLICY, transient: 0 };
  assertRow(resolve({ result: failed('transient'), policy }), 'transient-exhausted', 'needs-human', 'stop');
});

test('advance needs completed, valid ok and every check passing', () => {
  assert.equal(resolve({ claim: claim('ok') }).direction, 'advance');
  for (const status of ['failed', 'timed-out', 'killed']) {
    const result = { status, response: { claim: 'ok' }, failure: status === 'failed' ? { class: 'transient', retryAfterMs: null } : null };
    assert.notEqual(resolve({ result, claim: claim('ok') }).direction, 'advance', status);
  }
  assert.notEqual(resolve({ claim: { valid: false, reason: 'malformed' } }).direction, 'advance');
  assert.notEqual(resolve({ claim: null }).direction, 'advance');
  assert.notEqual(resolve({ claim: claim('ok'), checks: [integrityOk, check('test', false)] }).direction, 'advance');
  assert.notEqual(resolve({ claim: claim('ok'), checks: [check('worktree-unchanged', false, true)] }).direction, 'advance');
});

test('resolve is pure: it does not mutate its inputs', () => {
  const input = { result: failed('transient', 10), claim: null, checks: [integrityOk], retries: { ...none } };
  const copy = structuredClone(input);
  outcome.resolve(input);
  assert.deepEqual(input, copy);
});
