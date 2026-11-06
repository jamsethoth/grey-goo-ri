import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as outcome from '../../lib/outcome.ts';
import type * as procedures from '../../lib/procedures.ts';
import type * as visit from '../../lib/visit.ts';

// A Claim as a case gives it: a valid one without its reason, an invalid one without its token, or none at all.
type GivenClaim = Partial<visit.ClaimSignal> | null;
interface GivenSignals {
  result?: visit.CallSignal;
  claim?: GivenClaim;
  checks?: outcome.TableCheck[];
  retries?: outcome.Signals['retries'];
  policy?: outcome.ResolutionPolicy;
}
// A case's decide input names only the Procedure tables it reads.
type GivenDecision = Omit<outcome.DecideInput, 'claim' | 'procedure'> & {
  claim: GivenClaim;
  procedure: Partial<procedures.Procedure>;
};
const decided = (input: GivenDecision) => outcome.decide(input as outcome.DecideInput);

const none = { transient: 0, rateLimited: 0, timeout: 0, parse: 0 };
const completed: visit.CallSignal = { status: 'completed', response: { claim: 'ok' }, failure: null };
const failed = (failureClass: string, retryAfterMs: number | null = null): visit.CallSignal => ({
  status: 'failed',
  response: null,
  failure: { failureClass, retryAfterMs },
});
const claim = (token: string) => ({ valid: true, token });
const check = (name: string, passed: boolean, integrity = false) => ({
  name,
  passed,
  integrity,
  output: passed ? '' : `${name} failed`,
});
const integrityOk = check('worktree-unchanged', true, true);

function resolve({
  result = completed,
  claim: claimSignal = null,
  checks = [integrityOk],
  retries = none,
  policy,
}: GivenSignals = {}) {
  return outcome.resolve(
    (policy
      ? { result, claim: claimSignal, checks, retries, policy }
      : { result, claim: claimSignal, checks, retries }) as outcome.Signals,
  );
}

interface Row {
  row: string;
  outcome: string;
  direction: visit.Direction;
}
function assertRow(resolution: visit.TableResolution, expected: Row) {
  assert.equal(resolution.row, expected.row);
  assert.equal(resolution.outcome, expected.outcome);
  assert.equal(resolution.direction, expected.direction);
}
// The fields a Procedure's tables decide, named so a failed comparison names the field.
const decisionOf = (resolution: visit.TableResolution) => ({
  outcome: resolution.outcome,
  direction: resolution.direction,
  rule: resolution.rule,
});

test('DEFAULT_RESOLUTION_POLICY holds the retry budgets by kind', () => {
  assert.deepEqual(outcome.DEFAULT_RESOLUTION_POLICY, { transient: 2, rateLimited: 2, timeout: 1, parse: 1 });
});

test('row integrity-violation: failed integrity check on a completed ok -> integrity-violation', () => {
  const resolution = resolve({
    claim: claim('ok'),
    checks: [check('worktree-unchanged', false, true), check('test', true)],
  });
  assertRow(resolution, { row: 'integrity-violation', outcome: 'integrity-violation', direction: 'stop' });
  assert.equal(resolution.check, 'worktree-unchanged');
});

test('row transient-retry: failed transient within budget -> transient-retry', () => {
  const resolution = resolve({ result: failed('transient', 1500) });
  assertRow(resolution, { row: 'transient-retry', outcome: 'transient-retry', direction: 'retry' });
  assert.equal(resolution.retryAfterMs, 1500);
  assert.equal(resolution.retryKind, 'transient', 'the budget the retry spends');
});

test('row transient-retry: failed rate-limited within budget -> transient-retry', () => {
  const resolution = resolve({ result: failed('rate-limited', 60000), retries: { ...none, rateLimited: 1 } });
  assertRow(resolution, { row: 'transient-retry', outcome: 'transient-retry', direction: 'retry' });
  assert.equal(resolution.retryAfterMs, 60000);
  assert.equal(resolution.retryKind, 'rateLimited');
});

test('row transient-exhausted: failed transient at budget -> harness-transient', () => {
  assertRow(resolve({ result: failed('transient'), retries: { ...none, transient: 2 } }), {
    row: 'transient-exhausted',
    outcome: 'harness-transient',
    direction: 'stop',
  });
  assertRow(resolve({ result: failed('rate-limited'), retries: { ...none, rateLimited: 2 } }), {
    row: 'transient-exhausted',
    outcome: 'harness-transient',
    direction: 'stop',
  });
});

for (const failureClass of ['auth', 'quota', 'budget']) {
  test(`row run-stop: failed ${failureClass} -> run-stop`, () => {
    const resolution = resolve({ result: failed(failureClass) });
    assertRow(resolution, { row: 'run-stop', outcome: 'run-stop', direction: 'stop' });
    assert.equal(resolution.failureClass, failureClass);
  });
}

for (const status of ['timed-out', 'killed'] as const) {
  test(`row timeout-retry: ${status} within budget -> timeout-retry`, () => {
    const resolution = resolve({ result: { status, response: { claim: 'ok' }, failure: null }, claim: claim('ok') });
    assertRow(resolution, { row: 'timeout-retry', outcome: 'timeout-retry', direction: 'retry' });
    assert.equal(resolution.retryKind, 'timeout');
  });
}

test('row timeout-exhausted: timed-out at budget -> harness-timeout', () => {
  const resolution = resolve({
    result: { status: 'timed-out', response: null, failure: null },
    retries: { ...none, timeout: 1 },
  });
  assertRow(resolution, { row: 'timeout-exhausted', outcome: 'harness-timeout', direction: 'stop' });
});

test('row unknown-failure: failed unknown -> needs-human', () => {
  assertRow(resolve({ result: failed('unknown') }), {
    row: 'unknown-failure',
    outcome: 'needs-human',
    direction: 'stop',
  });
});

test('row parse-retry: completed, invalid claim within budget -> parse-retry', () => {
  const resolution = resolve({ claim: { valid: false, reason: 'more than one token' } });
  assertRow(resolution, { row: 'parse-retry', outcome: 'parse-retry', direction: 'retry' });
  assert.equal(resolution.retryKind, 'parse');
});

test('row parse-exhausted: completed, invalid claim at budget -> harness-unparsed', () => {
  const resolution = resolve({ claim: { valid: false, reason: 'field missing' }, retries: { ...none, parse: 1 } });
  assertRow(resolution, { row: 'parse-exhausted', outcome: 'harness-unparsed', direction: 'stop' });
});

// The claim rows are gone (#115): any valid Claim, stop tokens included, hands over to the Procedure's tables (decide).
for (const token of ['ok', 'blocked', 'changes']) {
  test(`row claimed: completed, valid ${token} -> ${token}, handed to the tables`, () => {
    const resolution = resolve({ claim: claim(token), checks: [integrityOk, check('test', false)] });
    assertRow(resolution, { row: 'claimed', outcome: token, direction: 'advance' });
    assert.deepEqual(resolution.rule, { table: 'fixed', row: 'claimed' });
    assert.equal(resolution.retryKind, null, 'a Check spends no Attempt budget');
  });
}

test('integrity beats a timed-out result', () => {
  const resolution = resolve({
    result: { status: 'timed-out', response: null, failure: null },
    claim: null,
    checks: [check('worktree-unchanged', false, true)],
  });
  assertRow(resolution, { row: 'integrity-violation', outcome: 'integrity-violation', direction: 'stop' });
});

test('a stop token beats passing checks', () => {
  const resolution = decided({
    result: completed,
    claim: claim('blocked'),
    checks: [integrityOk, check('test', true)],
    retries: none,
    token: { stop: true },
    procedure: {},
    scope: {},
  });
  assert.deepEqual(decisionOf(resolution), {
    outcome: 'blocked',
    direction: 'stop',
    rule: { table: 'stopped', row: null },
  });
});

test('a completed result with response null and no claim is a parse retry, then parse-exhausted at budget', () => {
  const result: visit.CallSignal = { status: 'completed', response: null, failure: null };
  assertRow(resolve({ result, claim: null }), { row: 'parse-retry', outcome: 'parse-retry', direction: 'retry' });
  assertRow(resolve({ result, claim: null, retries: { ...none, parse: 1 } }), {
    row: 'parse-exhausted',
    outcome: 'harness-unparsed',
    direction: 'stop',
  });
});

test('a policy overrides the retry budgets', () => {
  const policy = { ...outcome.DEFAULT_RESOLUTION_POLICY, transient: 0 };
  assertRow(resolve({ result: failed('transient'), policy }), {
    row: 'transient-exhausted',
    outcome: 'harness-transient',
    direction: 'stop',
  });
});

for (const [status, failure] of [
  ['failed', { failureClass: 'transient', retryAfterMs: null }],
  ['timed-out', null],
  ['killed', null],
] as [visit.CallSignal['status'], visit.HarnessFailure | null][]) {
  test(`a ${status} result with a valid ok claim does not advance`, () => {
    assert.notEqual(
      resolve({ result: { status, response: { claim: 'ok' }, failure }, claim: claim('ok') }).direction,
      'advance',
    );
  });
}

test('advance needs completed, a valid claim and no integrity violation', () => {
  assert.equal(resolve({ claim: claim('ok') }).direction, 'advance');
  assert.notEqual(resolve({ claim: { valid: false, reason: 'malformed' } }).direction, 'advance');
  assert.notEqual(resolve({ claim: null }).direction, 'advance');
  assert.notEqual(
    resolve({ claim: claim('ok'), checks: [check('worktree-unchanged', false, true)] }).direction,
    'advance',
  );
});

test('resolve is pure: it does not mutate its inputs', () => {
  const input: GivenSignals = {
    result: failed('transient', 10),
    claim: null,
    checks: [integrityOk],
    retries: { ...none },
  };
  const copy = structuredClone(input);
  outcome.resolve(input as outcome.Signals);
  assert.deepEqual(input, copy);
});

// #115: the Visit's Outcome (Q3d). A Procedure's tables pick among the legitimate Outcomes only after gg's fixed rows.
const ordered = {
  procedure: {
    stopped: [{ when: { 'response.reason': 'misscoped' }, outcome: 'misscoped' }],
    passed: [{ when: { pass: 2 }, outcome: 'recovered' }],
    failed: [{ when: { 'check.lint': 'failed' }, outcome: 'lint-failed' }],
    otherwise: 'changes',
  },
  tokens: { ok: { requires: ['test', 'lint'] }, blocked: { stop: true } } as Record<string, procedures.ClaimToken>,
};
const decideOrdered = (token: string, checks: outcome.TableCheck[], scope: object, extra = {}) =>
  decided({
    result: completed,
    claim: claim(token),
    checks: [integrityOk, ...checks],
    retries: none,
    token: ordered.tokens[token],
    procedure: ordered.procedure,
    scope: { pass: 1, check: {}, response: {}, ...scope },
    ...extra,
  });

test('the decision order is fixed rows, stopped, passed or failed, otherwise', () => {
  const passing = [check('test', true), check('lint', true)];

  // gg's fixed rows come first, whatever the Claim and its tables say.
  const violated = decideOrdered('blocked', [check('worktree-unchanged', false, true)], {
    response: { reason: 'misscoped' },
  });
  assert.deepEqual(
    { outcome: violated.outcome, rule: violated.rule },
    { outcome: 'integrity-violation', rule: { table: 'fixed', row: 'integrity-violation' } },
  );
  // A stop token goes to the stopped table, else stays the token; passing Checks never override it, nor does otherwise.
  const misscoped = decideOrdered('blocked', passing, { response: { reason: 'misscoped' } });
  assert.deepEqual(decisionOf(misscoped), {
    outcome: 'misscoped',
    direction: 'stop',
    rule: { table: 'stopped', row: 0 },
  });
  const blocked = decideOrdered('blocked', passing, { response: { reason: 'none' } });
  assert.deepEqual(decisionOf(blocked), {
    outcome: 'blocked',
    direction: 'stop',
    rule: { table: 'stopped', row: null },
  });
  // Every required Check passed: the passed table, then otherwise.
  const recovered = decideOrdered('ok', passing, { pass: 2 });
  assert.deepEqual(decisionOf(recovered), {
    outcome: 'recovered',
    direction: 'advance',
    rule: { table: 'passed', row: 0 },
  });
  const otherwise = decideOrdered('ok', passing, {});
  assert.deepEqual(decisionOf(otherwise), {
    outcome: 'changes',
    direction: 'advance',
    rule: { table: 'passed', row: 'otherwise' },
  });
  // A required Check failed: recovery while it is left, then the failed table, then otherwise.
  const failing = [check('test', true), check('lint', false)];
  const recover = decideOrdered('ok', failing, { check: { lint: 'failed' } }, { recoverable: true });
  assert.deepEqual(decisionOf(recover), {
    outcome: 'recover',
    direction: 'retry',
    rule: { table: 'fixed', row: 'recover' },
  });
  const lintFailed = decideOrdered('ok', failing, { check: { lint: 'failed' } });
  assert.deepEqual(decisionOf(lintFailed), {
    outcome: 'lint-failed',
    direction: 'stop',
    rule: { table: 'failed', row: 0 },
  });
  const failedOtherwise = decideOrdered('ok', failing, { check: { lint: 'passed' } });
  assert.deepEqual(decisionOf(failedOtherwise), {
    outcome: 'changes',
    direction: 'stop',
    rule: { table: 'failed', row: 'otherwise' },
  });
});

test('with no row and no otherwise the Outcome is the token, or failed when a required Check failed', () => {
  const decide = (checks: outcome.TableCheck[]) =>
    decided({
      result: completed,
      claim: claim('ok'),
      checks: [integrityOk, ...checks],
      retries: none,
      token: { requires: ['test'] },
      procedure: {},
      scope: { pass: 1, check: {} },
    });
  const allPassed = decide([check('test', true)]);
  assert.deepEqual(decisionOf(allPassed), {
    outcome: 'ok',
    direction: 'advance',
    rule: { table: 'passed', row: null },
  });
  const oneFailed = decide([check('test', false)]);
  assert.deepEqual(decisionOf(oneFailed), {
    outcome: 'failed',
    direction: 'stop',
    rule: { table: 'failed', row: null },
  });
});

test('a passing Integrity Assertion does not count as the required Check it shares a name with', () => {
  const resolution = decided({
    result: completed,
    claim: claim('ok'),
    checks: [check('lint', true, true)],
    retries: none,
    token: { requires: ['lint'] },
    procedure: {},
    scope: { pass: 1, check: {} },
  });
  assert.deepEqual(decisionOf(resolution), {
    outcome: 'failed',
    direction: 'stop',
    rule: { table: 'failed', row: null },
  });
});

// The key order reaches persisted JSON (the Visit's settled resolution, the Action Event's rule and signals), and
// deepEqual ignores it.
test("the Resolution's keys keep their order from resolve and from decide", () => {
  const keys = ['outcome', 'direction', 'row', 'rule', 'check', 'retryAfterMs', 'retryKind', 'failureClass'];
  assert.deepEqual(Object.keys(resolve({ claim: claim('ok') })), keys);
  const decide = (checks: outcome.TableCheck[], extra = {}) =>
    decided({
      result: completed,
      claim: claim('ok'),
      checks: [integrityOk, ...checks],
      retries: none,
      token: { requires: ['test'] },
      procedure: { passed: [{ when: { pass: 1 }, outcome: 'changes' }] },
      scope: { pass: 1, check: {} },
      ...extra,
    });
  const fromTable = decide([check('test', true)]);
  assert.deepEqual(fromTable.rule, { table: 'passed', row: 0 });
  assert.deepEqual(Object.keys(fromTable), keys);
  const recover = decide([check('test', false)], { recoverable: true });
  assert.equal(recover.row, 'recover');
  assert.deepEqual(Object.keys(recover), keys);
});

// #66: GitHub and git failures of a remote Action, classified as gh and git report them.
const http = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`gh: ${message} (HTTP ${status})\ngh api repos/{owner}/{repo}/issues/7/comments`), {
    code: 1,
    http: { status, headers },
  });
const NOW = 1_790_000_000_000;

for (const [name, err, failureClass, retryable] of [
  ['a 502', http(502, 'Bad Gateway'), 'transient', true],
  [
    'a 500 from a gh verb',
    new Error('HTTP 500: Internal Server Error (https://api.github.com/graphql)'),
    'transient',
    true,
  ],
  [
    'a reset connection',
    new Error(
      'Post "https://api.github.com/graphql": read tcp 10.0.0.2:5000->140.82.112.6:443: read: connection reset by peer',
    ),
    'transient',
    true,
  ],
  [
    'an unresolved host on push',
    new Error("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"),
    'transient',
    true,
  ],
  [
    'a secondary rate limit',
    http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '7' }),
    'rate-limited',
    true,
  ],
  [
    'a primary rate limit',
    http(403, 'API rate limit exceeded for user ID 1.', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String((NOW + 30_000) / 1000),
    }),
    'rate-limited',
    true,
  ],
  [
    'a rate limit a gh verb reports',
    new Error('HTTP 403: You have exceeded a secondary rate limit. (https://api.github.com/graphql)'),
    'rate-limited',
    true,
  ],
  ['a 429', http(429, 'Too Many Requests'), 'rate-limited', true],
  ['a bare 403', http(403, 'Resource not accessible by integration'), 'permission', false],
  ['a 401', http(401, 'Bad credentials'), 'auth', false],
  ['a validation failure', http(422, 'Validation Failed'), 'invalid', false],
  [
    'a non-fast-forward push',
    new Error(
      " ! [rejected]        abc123 -> ticket/1-x (non-fast-forward)\nerror: failed to push some refs to 'origin'",
    ),
    'rejected',
    false,
  ],
  ['an unknown failure', new Error('gh comment down'), 'unknown', false],
  // exec.run appends the command to the message; a PR title there is not the response's status.
  [
    'a status only in the appended command',
    Object.assign(
      new Error(
        "GraphQL: Head sha can't be blank (createPullRequest)\n" +
          'gh pr create --draft --title Handle HTTP 502 errors --body-file -',
      ),
      { code: 1, stdout: '', stderr: "GraphQL: Head sha can't be blank (createPullRequest)\n" },
    ),
    'unknown',
    false,
  ],
  // git's http.c reports an HTTP failure of a push or fetch in its own words.
  [
    'a git 503',
    Object.assign(
      new Error(
        "fatal: unable to access 'https://github.com/o/r.git/': " +
          'The requested URL returned error: 503\ngit push origin x',
      ),
      {
        code: 128,
        stdout: '',
        stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503\n",
      },
    ),
    'transient',
    true,
  ],
  [
    'a git 429',
    Object.assign(
      new Error(
        "fatal: unable to access 'https://github.com/o/r.git/': " +
          'The requested URL returned error: 429\ngit push origin x',
      ),
      {
        code: 128,
        stdout: '',
        stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429\n",
      },
    ),
    'rate-limited',
    true,
  ],
  [
    'a git 403',
    Object.assign(
      new Error(
        "fatal: unable to access 'https://github.com/o/r.git/': " +
          'The requested URL returned error: 403\ngit push origin x',
      ),
      {
        code: 128,
        stdout: '',
        stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n",
      },
    ),
    'permission',
    false,
  ],
  [
    'a git 404',
    Object.assign(
      new Error(
        "fatal: unable to access 'https://github.com/o/r.git/': " +
          'The requested URL returned error: 404\ngit push origin x',
      ),
      {
        code: 128,
        stdout: '',
        stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404\n",
      },
    ),
    'invalid',
    false,
  ],
  [
    'a status gh printed',
    Object.assign(new Error('gh: Bad Gateway (HTTP 502)\ngh api repos/{owner}/{repo}/issues/7/comments'), {
      code: 1,
      stdout: '',
      stderr: 'gh: Bad Gateway (HTTP 502)\n',
    }),
    'transient',
    true,
  ],
] as [string, outcome.RemoteError, string, boolean][]) {
  test(`a remote failure is classified: ${name} is ${retryable ? 'a retryable' : 'a final'} ${failureClass}`, () => {
    const failure = outcome.classifyRemoteFailure(err);
    assert.equal(failure.failureClass, failureClass);
    assert.equal(failure.retryable, retryable);
  });
}

const delay = (err: outcome.RemoteError, retry: number) =>
  outcome.remoteRetryDelay(outcome.classifyRemoteFailure(err), retry, NOW);

test('a remote failure backs off by its Retry-After first', () => {
  assert.equal(delay(http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '7' }), 1), 7_000);
});

test('a rate limit with no requests remaining backs off until the reset time', () => {
  const err = http(403, 'API rate limit exceeded for user ID 1.', {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String((NOW + 30_000) / 1000),
  });
  assert.equal(delay(err, 1), 30_000);
});

test('a rate limit with an invalid Retry-After backs off 60 s', () => {
  assert.equal(delay(http(403, 'You have exceeded a secondary rate limit.', { 'retry-after': 'soon' }), 1), 60_000);
});

test('a transient remote failure backs off at least 60 s, growing exponentially', () => {
  assert.equal(delay(http(502, 'Bad Gateway'), 1), 60_000);
  assert.equal(delay(http(502, 'Bad Gateway'), 2), 120_000);
});

test('a 401 is auth and a 403 that is not a rate limit is permission', () => {
  const unauthorized = outcome.classifyRemoteFailure(http(401, 'Bad credentials'));
  assert.equal(unauthorized.failureClass, 'auth');
  assert.equal(unauthorized.retryable, false);
  const forbidden = outcome.classifyRemoteFailure(http(403, 'Resource not accessible by integration'));
  assert.equal(forbidden.failureClass, 'permission');
  assert.equal(forbidden.retryable, false);
  const limited = outcome.classifyRemoteFailure(http(403, 'You have exceeded a secondary rate limit.'));
  assert.equal(limited.failureClass, 'rate-limited', 'a 403 rate limit stays a rate limit');
});

// git's credential failures carry no HTTP status, only git's own words.
const gitFailure = (stderr: string) =>
  Object.assign(new Error(`${stderr}\ngit push origin x`), { code: 128, stdout: '', stderr: `${stderr}\n` });

test("git's credential failure is auth", () => {
  for (const stderr of [
    'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
      "fatal: Authentication failed for 'https://github.com/o/r.git/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ]) {
    const failure = outcome.classifyRemoteFailure(gitFailure(stderr));
    assert.equal(failure.failureClass, 'auth', stderr);
    assert.equal(failure.retryable, false, stderr);
  }
});

test('a push rejection whose output also carries a rate-limit message is rejected', () => {
  const failure = outcome.classifyRemoteFailure(
    gitFailure(
      'remote: API rate limit exceeded for user ID 1.\nTo https://github.com/o/r.git\n' +
        ' ! [rejected]        x -> x (fetch first)\nerror: failed to push some refs',
    ),
  );
  assert.equal(failure.failureClass, 'rejected');
  const rateLimitOnStdout = Object.assign(new Error('git push origin x'), {
    code: 1,
    stdout: 'remote: API rate limit exceeded for user ID 1.\n',
    stderr:
      'To https://github.com/o/r.git\n ! [rejected]        x -> x (fetch first)\nerror: failed to push some refs\n',
  });
  assert.equal(outcome.classifyRemoteFailure(rateLimitOnStdout).failureClass, 'rejected', 'the rate limit on stdout');
});

// One table decides each class's retry and reach, whichever source reports it (#240).
test('every class in the table has a reach, and the Harness rows follow it', () => {
  assert.deepEqual(outcome.FAILURE_CLASSES, {
    transient: { reach: 'retry', budget: 'transient' },
    'rate-limited': { reach: 'retry', budget: 'rateLimited' },
    auth: { reach: 'run', budget: null },
    quota: { reach: 'run', budget: null },
    budget: { reach: 'run', budget: null },
    permission: { reach: 'ticket', budget: null },
    rejected: { reach: 'ticket', budget: null },
    invalid: { reach: 'ticket', budget: null },
    unknown: { reach: 'ticket', budget: null },
  });
  const rowOf = { retry: 'transient-retry', run: 'run-stop', ticket: 'unknown-failure' };
  for (const [failureClass, { reach, budget }] of Object.entries(outcome.FAILURE_CLASSES)) {
    const resolution = resolve({ result: failed(failureClass), policy: outcome.DEFAULT_RESOLUTION_POLICY });
    assert.equal(resolution.row, rowOf[reach], failureClass);
    assert.equal(resolution.retryKind, budget, failureClass);
    assert.equal(resolution.failureClass, failureClass);
  }
});
