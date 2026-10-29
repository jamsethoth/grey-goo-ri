import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as outcome from '../../lib/outcome.mjs';

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
  assert.equal(r.retryKind, 'transient', 'the budget the retry spends');
});

test('row transient-retry: failed rate-limited within budget -> transient-retry', () => {
  const r = resolve({ result: failed('rate-limited', 60000), retries: { ...none, rateLimited: 1 } });
  assertRow(r, 'transient-retry', 'transient-retry', 'retry');
  assert.equal(r.retryAfterMs, 60000);
  assert.equal(r.retryKind, 'rateLimited');
});

test('row transient-exhausted: failed transient at budget -> harness-transient', () => {
  assertRow(resolve({ result: failed('transient'), retries: { ...none, transient: 2 } }), 'transient-exhausted', 'harness-transient', 'stop');
  assertRow(resolve({ result: failed('rate-limited'), retries: { ...none, rateLimited: 2 } }), 'transient-exhausted', 'harness-transient', 'stop');
});

for (const cls of ['auth', 'quota', 'budget']) {
  test(`row run-stop: failed ${cls} -> run-stop`, () => {
    const r = resolve({ result: failed(cls) });
    assertRow(r, 'run-stop', 'run-stop', 'stop');
    assert.equal(r.failureClass, cls);
  });
}

for (const status of ['timed-out', 'killed']) {
  test(`row timeout-retry: ${status} within budget -> timeout-retry`, () => {
    const r = resolve({ result: { status, response: { claim: 'ok' }, failure: null }, claim: claim('ok') });
    assertRow(r, 'timeout-retry', 'timeout-retry', 'retry');
    assert.equal(r.retryKind, 'timeout');
  });
}

test('row timeout-exhausted: timed-out at budget -> harness-timeout', () => {
  const r = resolve({ result: { status: 'timed-out', response: null, failure: null }, retries: { ...none, timeout: 1 } });
  assertRow(r, 'timeout-exhausted', 'harness-timeout', 'stop');
});

test('row unknown-failure: failed unknown -> needs-human', () => {
  assertRow(resolve({ result: failed('unknown') }), 'unknown-failure', 'needs-human', 'stop');
});

test('row parse-retry: completed, invalid claim within budget -> parse-retry', () => {
  const r = resolve({ claim: { valid: false, reason: 'more than one token' } });
  assertRow(r, 'parse-retry', 'parse-retry', 'retry');
  assert.equal(r.retryKind, 'parse');
});

test('row parse-exhausted: completed, invalid claim at budget -> harness-unparsed', () => {
  const r = resolve({ claim: { valid: false, reason: 'field missing' }, retries: { ...none, parse: 1 } });
  assertRow(r, 'parse-exhausted', 'harness-unparsed', 'stop');
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
  assert.equal(r.retryKind, null, 'a recovery Phase spends no Attempt budget');
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

test('a routed check failing on a claim ok advances by its mapped Outcome through check-failed', () => {
  const r = outcome.resolve({ result: completed, claim: claim('ok'), checks: [integrityOk, check('review-pass', false)], retries: none,
    routes: { 'review-pass': 'changes' } });
  assertRow(r, 'check-failed', 'changes', 'advance');
  assert.equal(r.check, 'review-pass');
});

test('a changes claim with a failing routed check keeps the claim-route row', () => {
  const r = outcome.resolve({ result: completed, claim: claim('changes'), checks: [integrityOk, check('review-pass', false)], retries: none,
    routes: { 'review-pass': 'changes' } });
  assertRow(r, 'claim-route', 'changes', 'advance');
});

test('row claim-route: completed, valid changes, every check passing -> changes', () => {
  assertRow(resolve({ claim: claim('changes'), checks: [integrityOk, check('review-pass', true)] }), 'claim-route', 'changes', 'advance');
});

test('row ok: completed, valid ok, every check passing -> ok', () => {
  assertRow(resolve({ claim: claim('ok'), checks: [integrityOk, check('test', true)] }), 'ok', 'ok', 'advance');
});

test('integrity beats a timed-out result', () => {
  const r = resolve({ result: { status: 'timed-out', response: null, failure: null }, claim: null, checks: [check('worktree-unchanged', false, true)] });
  assertRow(r, 'integrity-violation', 'integrity-violation', 'stop');
});

test('blocked beats passing checks', () => {
  const r = resolve({ claim: claim('blocked'), checks: [integrityOk, check('test', true), check('lint', true)] });
  assertRow(r, 'blocked', 'blocked', 'stop');
});

test('a non-ok non-stop claim routes by its token', () => {
  assertRow(resolve({ claim: claim('repeat') }), 'claim-route', 'repeat', 'advance');
});

test('a completed result with response null and no claim is a parse retry, then parse-exhausted at budget', () => {
  const result = { status: 'completed', response: null, failure: null };
  assertRow(resolve({ result, claim: null }), 'parse-retry', 'parse-retry', 'retry');
  assertRow(resolve({ result, claim: null, retries: { ...none, parse: 1 } }), 'parse-exhausted', 'harness-unparsed', 'stop');
});

test('a policy overrides the retry budgets', () => {
  const policy = { ...outcome.DEFAULT_POLICY, transient: 0 };
  assertRow(resolve({ result: failed('transient'), policy }), 'transient-exhausted', 'harness-transient', 'stop');
});

for (const [status, failure] of [['failed', { class: 'transient', retryAfterMs: null }], ['timed-out', null], ['killed', null]]) {
  test(`a ${status} result with a valid ok claim does not advance`, () => {
    assert.notEqual(resolve({ result: { status, response: { claim: 'ok' }, failure }, claim: claim('ok') }).direction, 'advance');
  });
}

test('advance needs completed, valid ok and every check passing', () => {
  assert.equal(resolve({ claim: claim('ok') }).direction, 'advance');
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

// #66: GitHub and git failures of a remote Action, classified as gh and git report them.
const http = (status, message, headers = {}) =>
  Object.assign(new Error(`gh: ${message} (HTTP ${status})\ngh api repos/{owner}/{repo}/issues/7/comments`), { code: 1, http: { status, headers } });
const NOW = 1_790_000_000_000;

for (const [name, err, cls, retryable] of [
  ['a 502', http(502, 'Bad Gateway'), 'transient', true],
  ['a 500 from a gh verb', new Error('HTTP 500: Internal Server Error (https://api.github.com/graphql)'), 'transient', true],
  ['a reset connection', new Error('Post "https://api.github.com/graphql": read tcp 10.0.0.2:5000->140.82.112.6:443: read: connection reset by peer'), 'transient', true],
  ['an unresolved host on push', new Error("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"), 'transient', true],
  ['a secondary rate limit', http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '7' }), 'rate-limited', true],
  ['a primary rate limit', http(403, 'API rate limit exceeded for user ID 1.', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 30_000) / 1000) }), 'rate-limited', true],
  ['a rate limit a gh verb reports', new Error('HTTP 403: You have exceeded a secondary rate limit. (https://api.github.com/graphql)'), 'rate-limited', true],
  ['a 429', http(429, 'Too Many Requests'), 'rate-limited', true],
  ['a bare 403', http(403, 'Resource not accessible by integration'), 'auth', false],
  ['a 401', http(401, 'Bad credentials'), 'auth', false],
  ['a validation failure', http(422, 'Validation Failed'), 'invalid', false],
  ['a non-fast-forward push', new Error(" ! [rejected]        abc123 -> ticket/1-x (non-fast-forward)\nerror: failed to push some refs to 'origin'"), 'rejected', false],
  ['an unknown failure', new Error('gh comment down'), 'unknown', false],
  // exec.run appends the command to the message; a PR title there is not the response's status.
  ['a status only in the appended command', Object.assign(new Error("GraphQL: Head sha can't be blank (createPullRequest)\ngh pr create --draft --title Handle HTTP 502 errors --body-file -"),
    { code: 1, stdout: '', stderr: "GraphQL: Head sha can't be blank (createPullRequest)\n" }), 'unknown', false],
  // git's http.c reports an HTTP failure of a push or fetch in its own words.
  ['a git 503', Object.assign(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503\ngit push origin x"),
    { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503\n" }), 'transient', true],
  ['a git 429', Object.assign(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429\ngit push origin x"),
    { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429\n" }), 'rate-limited', true],
  ['a git 403', Object.assign(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\ngit push origin x"),
    { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n" }), 'auth', false],
  ['a git 404', Object.assign(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404\ngit push origin x"),
    { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404\n" }), 'invalid', false],
  ['a status gh printed', Object.assign(new Error('gh: Bad Gateway (HTTP 502)\ngh api repos/{owner}/{repo}/issues/7/comments'),
    { code: 1, stdout: '', stderr: 'gh: Bad Gateway (HTTP 502)\n' }), 'transient', true],
]) {
  test(`a remote failure is classified: ${name} is ${retryable ? 'a retryable' : 'a final'} ${cls}`, () => {
    const f = outcome.classifyRemoteFailure(err);
    assert.equal(f.class, cls);
    assert.equal(f.retryable, retryable);
  });
}

const delay = (err, n) => outcome.remoteRetryDelay(outcome.classifyRemoteFailure(err), n, NOW);

test('a remote failure backs off by its Retry-After first', () => {
  assert.equal(delay(http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '7' }), 1), 7_000);
});

test('a rate limit with no requests remaining backs off until the reset time', () => {
  const err = http(403, 'API rate limit exceeded for user ID 1.', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 30_000) / 1000) });
  assert.equal(delay(err, 1), 30_000);
});

test('a rate limit with an invalid Retry-After backs off 60 s', () => {
  assert.equal(delay(http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': 'soon' }), 1), 60_000);
});

test('a transient remote failure backs off at least 60 s, growing exponentially', () => {
  assert.equal(delay(http(502, 'Bad Gateway'), 1), 60_000);
  assert.equal(delay(http(502, 'Bad Gateway'), 2), 120_000);
});
