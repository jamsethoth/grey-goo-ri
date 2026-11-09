import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as effects from '../../lib/effects.ts';
import type * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as record from '../../lib/record.ts';
import * as backoffRunStop from '../support/backoff-run-stop.ts';
import * as golden from '../support/golden.ts';
import {
  actionEvent,
  actionMarker,
  attemptMarker,
  headSha,
  loadTicket,
  originSha,
  runStopEvent,
  ticketRow,
} from '../support/execution-reads.ts';
import {
  PR,
  REVIEW_COMMENT,
  commentPosts,
  crashPost,
  okReview,
  onPr,
  prReviewComments,
  reviewFixture,
  ticketComments,
} from '../support/review-flow.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as fakeGhModule from '../support/fake-gh.ts';
import * as keys from '../support/keys.ts';
import {
  HOUR,
  crashPr,
  failPr,
  isPr,
  prCalls,
  pushError,
  pushThrough,
  rateLimitedFor,
  refusedPush,
  retriedOnce,
} from '../support/remote-failures.ts';
import * as suiteRuns from '../support/suite-runs.ts';

type GoldenFixture = golden.GoldenFixture;

// #83: the pr-upsert, pr-ready and push paths of the in-Action retry, end to end.
const PUSH = keys.retryKey({ vertex: 'green', visit: 1, action: 'push', recovery: 0 });
const PR_UPSERT = keys.retryKey({ vertex: 'green', visit: 1, action: 'pr', recovery: 0 });
const PR_READY = keys.retryKey({ vertex: 'publish', visit: 1, action: 'pr-ready', recovery: 0 });
test('a transient pr-upsert failure is retried and opens one PR', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: isPr('create'), status: 502 });
  let during;
  fixture.clock.onSleep = async () => {
    during = loadTicket(fixture).pr;
  };
  const result = await interpreter.runExecution(fixture.options);

  const final = await retriedOnce(fixture, result, PR_UPSERT, attemptMarker(fixture, 'green', 1, 'pr', 0));
  assert.equal(during, null, 'no PR is recorded during the backoff');
  assert.equal(prCalls(fixture, 'create').length, 2, 'the failed create and one retry');
  assert.equal(fixture.gh.pr()!.number, PR, 'one PR');
  assert.equal(final.pr, PR);
  assert.equal(fixture.gh.pr()!.isDraft, false);
});

test('an accepted pr-upsert whose call errored is found, not repeated', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: isPr('create'), status: 502, afterEffect: true });
  const result = await interpreter.runExecution(fixture.options);

  const marker = attemptMarker(fixture, 'green', 1, 'pr', 0);
  const final = await retriedOnce(fixture, result, PR_UPSERT, marker);
  assert.equal(prCalls(fixture, 'create').length, 1, 'never created again');
  assert.equal(prCalls(fixture, 'edit').length, 1, "edited only by publish's re-render");
  assert.deepEqual(
    final.writeAheadLog.find((entry) => entry.actionMarker === marker && entry.step === 'evidence')!.evidence,
    {
      number: PR,
      url: fixture.gh.pr()!.url,
    },
  );
  assert.equal(fixture.executionRecord.pr, PR, 'restored from the found PR');
  assert.equal(final.pr, PR, 'and saved');
  assert.deepEqual(
    prCalls(fixture, 'ready').map((call) => call.args[2]),
    [String(PR)],
    'the found PR is the one made ready',
  );
});

test('a transient pr-ready failure is retried and the PR ends ready', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: isPr('ready'), status: 502 });
  const result = await interpreter.runExecution(fixture.options);

  await retriedOnce(fixture, result, PR_READY, attemptMarker(fixture, 'publish', 1, 'pr-ready', 0));
  assert.equal(prCalls(fixture, 'ready').length, 2, 'the failed call and one retry');
  assert.equal(fixture.gh.pr()!.isDraft, false);
});

test('an accepted pr-ready whose call errored is repeated with one state change', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: isPr('ready'), status: 502, afterEffect: true });
  const drafts: boolean[] = [];
  fixture.options.deps.gh = github.createGh(async (args, cwd, input) => {
    if (isPr('ready')(args)) drafts.push(fixture.gh.pr()!.isDraft);
    return fixture.gh.gh(args, cwd, input);
  });
  const result = await interpreter.runExecution(fixture.options);

  await retriedOnce(fixture, result, PR_READY, attemptMarker(fixture, 'publish', 1, 'pr-ready', 0));
  assert.deepEqual(drafts, [true, false], 'made again on a PR already ready: one state change');
  assert.equal(fixture.gh.pr()!.isDraft, false);
});

test('a transient push failure is retried and pushes once', async (t) => {
  const fixture = await golden.fixture(t);
  const pushes = pushThrough(fixture, (launch, push) => (launch === 1 ? Promise.reject(pushError()) : push()));
  const result = await interpreter.runExecution(fixture.options);

  await retriedOnce(fixture, result, PUSH, actionMarker(fixture, 'green', 'push'));
  assert.equal(pushes(), 2, 'the failed push and one retry');
  assert.equal(await originSha(fixture), await headSha(fixture));
});

test('a push that landed but whose call errored is found on origin, not pushed again', async (t) => {
  const fixture = await golden.fixture(t);
  const unlocked = fixture.options.deps.git;
  const pushes = pushThrough(fixture, async (launch, push) => {
    await push();
    if (launch === 1) throw pushError();
  });
  let during;
  fixture.clock.onSleep = async () => {
    during = await originSha(fixture, unlocked);
  };
  const result = await interpreter.runExecution(fixture.options);

  const marker = actionMarker(fixture, 'green', 'push');
  const final = await retriedOnce(fixture, result, PUSH, marker);
  const head = await headSha(fixture);
  assert.equal(during, head, 'origin had the commit during the backoff');
  assert.equal(pushes(), 1, 'never pushed again');
  assert.deepEqual(
    final.writeAheadLog.find((entry) => entry.actionMarker === marker && entry.step === 'evidence')!.evidence,
    {
      remoteSha: head,
    },
  );
});

for (const [name, key, inject, text] of [
  [
    'pr-upsert',
    PR_UPSERT,
    (fixture) => failPr(fixture, 'create', 3),
    'A transient GitHub failure (HTTP 502) at pr persisted after 2 retries; ' +
      'the error is in this comment and on ticket_end.',
  ],
  [
    'pr-ready',
    PR_READY,
    (fixture) => failPr(fixture, 'ready', 3),
    'A transient GitHub failure (HTTP 502) at pr-ready persisted after 2 retries; ' +
      'the error is in this comment and on ticket_end.',
  ],
  [
    'push',
    PUSH,
    (fixture) => pushThrough(fixture, () => Promise.reject(pushError())),
    'A transient push failure (HTTP 503) at push persisted after 2 retries; ' +
      'the error is in this comment and on ticket_end.',
  ],
] as [string, string, (fixture: GoldenFixture) => unknown, string][]) {
  test(`a ${name} whose retries run out holds with the exhausted reason`, async (t) => {
    const fixture = await golden.fixture(t);
    inject(fixture);
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.deepEqual(fixture.sleeps, [60_000, 120_000]);
    assert.equal(fixture.executionRecord.terminalReason!.text, text);
    assert.ok(
      fixture.logs.some((line) => line.includes(`${key}: transient failure, retries exhausted after 2 of 2`)),
      fixture.logs.join('\n'),
    );
    const final = loadTicket(fixture);
    assert.equal(final.retries[key]!.remote!.count, 2);
    assert.equal(final.state, 'fault');
    assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  });
}

for (const [name, key, inject, text] of [
  [
    'pr-upsert',
    PR_UPSERT,
    (fixture) => crashPr(fixture, 'create'),
    'A transient GitHub failure at pr persisted after 2 retries; ' + 'the error is in this comment and on ticket_end.',
  ],
  [
    'pr-ready',
    PR_READY,
    (fixture) => crashPr(fixture, 'ready'),
    'A transient GitHub failure at pr-ready persisted after 2 retries; ' +
      'the error is in this comment and on ticket_end.',
  ],
  [
    'push',
    PUSH,
    (fixture) =>
      pushThrough(fixture, (launch) =>
        Promise.reject(launch === 3 ? new interpreter.CrashError('crash as the push launched') : pushError()),
      ),
    'A transient push failure at push persisted after 2 retries; ' + 'the error is in this comment and on ticket_end.',
  ],
] as [string, string, (fixture: GoldenFixture) => () => number, string][]) {
  test(`a ${name} that crashes after launch spends its saved budget on resume`, async (t) => {
    const fixture = await golden.fixture(t);
    const launches = inject(fixture);
    // Two transient failures spend the budget; the second retry crashes as it launches.
    await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
    const mid = loadTicket(fixture);
    assert.equal(mid.retries[key]!.remote!.count, 2);
    assert.equal(mid.retries[key]!.remote!.started, true, 'the last retry launched');

    const result = await interpreter.runExecution({ ...fixture.options, record: mid });
    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(launches(), 3, 'no fourth launch');
    const final = loadTicket(fixture);
    assert.equal(final.retries[key]!.remote!.count, 2, 'the budget is not refilled');
    assert.equal(final.terminalReason!.text, text);
    assert.ok(
      fixture.logs.some((line) => line.includes(`${key}: transient failure, retries exhausted after 2 of 2`)),
      fixture.logs.join('\n'),
    );
    assert.equal(final.state, 'fault');
    assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  });
}

// #85: a backoff is bounded, stops with the Run, and leaves its worktree idle while it waits.

test('a backoff longer than the timer limit sleeps in bounded chunks', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(rateLimitedFor(30 * 24 * HOUR));
  const calls = new Set();
  fixture.clock.onSleep = () => {
    calls.add(fixture.gh.calls.length);
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, Array(720).fill(HOUR), 'one sleep of an hour per hour of the 30 days');
  assert.deepEqual(
    [...calls],
    [fixture.gh.calls.indexOf(commentPosts(fixture)[0]) + 1],
    'no lookup or launch between the chunks',
  );
  assert.equal(prReviewComments(fixture).length, 1);
});

test('a backoff keeps one idle generation across timer chunks', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(rateLimitedFor(2 * HOUR));
  const seen: record.ExecutionRecord['activity'][] = [];
  fixture.clock.onSleep = async () => {
    seen.push(loadTicket(fixture).activity);
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.equal(seen[0].busy, false, 'idle while it waits');
  assert.deepEqual(seen[1], seen[0], 'one generation across the chunks');
});

// A deadline in Date's range is logged as a time; anything else as its saved JSON value.
for (const [name, deadline, shown] of [
  ['excessive', (now) => now + 40 * 24 * HOUR, '2026-11-24T00:00:00.000Z'],
  ['invalid', () => null, 'null'],
  ['out of range', () => 1e300, '1e+300'],
] as [string, (now: number) => number | null, string][]) {
  test(`an ${name} saved retry deadline is logged and held`, async (t) => {
    const fixture = await reviewFixture(t, okReview);
    const marker = attemptMarker(fixture, 'reviewer', 1, 'comment', 0);
    fixture.gh.fail(onPr({ status: 502 }));
    await assert.rejects(
      interpreter.runExecution({ ...fixture.options, crashAt: { marker, point: 'after-retry-saved' } }),
      (err) => err instanceof interpreter.CrashError,
    );
    const mid = loadTicket(fixture);
    mid.retries[REVIEW_COMMENT]!.remote!.nextEligibleAt = deadline(fixture.clock.now()) as number;
    const saved = structuredClone(mid.retries[REVIEW_COMMENT]!.remote);
    const result = await interpreter.runExecution({ ...fixture.options, record: mid });

    assert.equal(result.held, true, JSON.stringify(result));
    assert.deepEqual(fixture.sleeps, [], 'never waited');
    assert.equal(commentPosts(fixture).length, 1, 'never retried');
    assert.ok(
      fixture.logs.includes(
        `#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline ${shown} is not a time within 31 days, so it is held`,
      ),
      fixture.logs.join('\n'),
    );
    const final = loadTicket(fixture);
    assert.equal(final.state, 'held');
    assert.deepEqual(final.retries[REVIEW_COMMENT]!.remote, saved, 'the saved retry is kept');
  });
}

test('a wait over 31 days from GitHub is held without reserving a retry', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(rateLimitedFor(40 * 24 * HOUR));
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.held, true, JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [], 'never waited');
  assert.equal(commentPosts(fixture).length, 1, 'never retried');
  assert.ok(
    fixture.logs.includes(
      `#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline 2026-11-24T00:00:00.000Z is not a time within 31 days, ` +
        'so it is held',
    ),
    fixture.logs.join('\n'),
  );
  const final = loadTicket(fixture);
  assert.equal(final.state, 'held');
  assert.equal(final.retries[REVIEW_COMMENT]!.remote!.count, 0, 'no retry is spent');
});

test('a run stop during a backoff ends the Execution at needs-human', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  // Another Ticket's harness call stops the run while this one backs off.
  const { result, saved } = await backoffRunStop.runStoppedInBackoff(fixture, { retryKey: REVIEW_COMMENT });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [60_000]);
  assert.equal(commentPosts(fixture).length, 1, 'no retry launched');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[REVIEW_COMMENT]!.remote, saved, 'the retry stays as saved');
  assert.equal(
    final.terminalReason!.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped while waiting to retry comment; its retry is kept as saved.',
  );
  assert.ok(
    ticketComments(fixture).some((comment) => comment.body.includes(final.terminalReason!.text)),
    'the needs-human comment says so',
  );
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
});

test('a latched run stop does not consume a relaunch retry', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  const posts = crashPost(fixture, 2);
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  const mid = loadTicket(fixture);
  const saved = structuredClone(mid.retries[REVIEW_COMMENT]!.remote);
  assert.equal(saved!.started, true, 'the first retry launched');
  // Another Ticket stops the run once this Action is under way, after the Visit's own check.
  let stop = null;
  const runState = {
    remoteNotBefore: 0,
    get stop() {
      return (stop ??= ticketRow(fixture).activity.busy ? { failureClass: 'auth', ticket: 21 } : null);
    },
  };
  const result = await interpreter.runExecution({ ...fixture.options, record: mid, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(posts(), 2, 'not launched again');
  const final = loadTicket(fixture);
  assert.deepEqual(final.retries[REVIEW_COMMENT]!.remote, saved, 'the retry is not spent');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
});

test('a rate-limited push keeps the fallback without a probe', async (t) => {
  const fixture = await golden.fixture(t);
  const limited = () =>
    Object.assign(pushError(), {
      stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
    });
  const pushes = pushThrough(fixture, (launch, push) => (launch === 1 ? Promise.reject(limited()) : push()));
  const result = await interpreter.runExecution(fixture.options);

  await retriedOnce(fixture, result, PUSH, actionMarker(fixture, 'green', 'push'));
  assert.equal(pushes(), 2);
  assert.ok(
    !fixture.gh.calls.some((call) => call.args[0] === 'api' && call.args[1] === 'rate_limit'),
    'git gives no quota to read',
  );
});

test('a run stop during a pr-ready backoff ends at needs-human without marking ready', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.gh.fail({ matches: isPr('ready'), status: 502 });
  const { result, saved } = await backoffRunStop.runStoppedInBackoff(fixture, { retryKey: PR_READY });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [60_000]);
  assert.equal(prCalls(fixture, 'ready').length, 1, 'no retry launched');
  assert.equal(fixture.gh.pr()!.isDraft, true, 'the PR is not marked ready');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[PR_READY]!.remote, saved, 'the retry stays as saved');
  assert.equal(
    final.terminalReason!.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped while waiting to retry pr-ready; its retry is kept as saved.',
  );
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
});

test('a run stop during the ready-for-qa comment backoff ends at needs-human after pr-ready', async (t) => {
  const fixture = await golden.fixture(t);
  const doneComment = keys.retryKey({ vertex: 'ready-for-qa', visit: 1, action: 'end-comment', recovery: 0 });
  fixture.gh.fail({
    matches: (args) => fakeGhModule.isCommentPost(args, golden.TICKET) && prCalls(fixture, 'ready').length > 0,
    status: 502,
  });
  const { result, saved } = await backoffRunStop.runStoppedInBackoff(fixture, { retryKey: doneComment });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [60_000]);
  assert.equal(prCalls(fixture, 'ready').length, 1);
  assert.equal(fixture.gh.pr()!.isDraft, false, 'pr-ready had landed');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[doneComment]!.remote, saved, 'the retry stays as saved');
  assert.ok(
    !ticketComments(fixture).some((comment) => comment.body.startsWith('### gg: ready-for-qa')),
    'no ready-for-qa comment lands',
  );
  assert.ok(
    ticketComments(fixture).some((comment) => comment.body.startsWith('### gg: needs-human')),
    'the needs-human comment lands',
  );
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human'], 'needs-human, and not ready-for-qa');
});

test('a run stop during a resume lookup backoff ends at needs-human', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  const marker = attemptMarker(fixture, 'reviewer', 1, 'comment', 0);
  fixture.gh.fail(onPr({ status: 502 }));
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const mid = loadTicket(fixture);
  const saved = structuredClone(mid.retries[REVIEW_COMMENT]!.remote);
  // Reconciliation's lookup waits out the saved retry; another Ticket stops the run meanwhile.
  const { result } = await backoffRunStop.runStoppedInBackoff(fixture, { executionRecord: mid });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [60_000]);
  assert.equal(commentPosts(fixture).length, 1, 'no retry launched');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[REVIEW_COMMENT]!.remote, saved, 'the retry stays as saved');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
});

// The backoff's own transition fails: the first save after the retry that flips the worktree `from` busy `to` busy.
async function failActivitySave(t: TestContext, from: boolean, to: boolean) {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  caseDatabase.failSaves(
    t,
    (saved, next) =>
      (saved as record.ExecutionRecord | undefined)?.activity.busy === from &&
      (next as record.ExecutionRecord).activity.busy === to &&
      (next as record.ExecutionRecord).retries[REVIEW_COMMENT]?.remote?.count === 1,
  );
  return fixture;
}

test('a failed idle save before a backoff allows no later save or effect', async (t) => {
  const fixture = await failActivitySave(t, true, false);
  const err = await interpreter.runExecution(fixture.options).then(
    () => null,
    (err: Error) => err,
  );

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(fixture.sleeps, [], 'never waited');
  const saved = loadTicket(fixture);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop, null, 'nor its Terminal');
  assert.equal(saved.cursor.vertex, 'reviewer');
  assert.equal(saved.activity.busy, true, 'the failed transition is not saved by a cleanup');
  assert.equal(saved.retries[REVIEW_COMMENT]!.remote!.count, 1);
  assert.equal(commentPosts(fixture).length, 1);
  assert.equal(ticketComments(fixture).length, 0, 'no fault report');
  assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
});

test('a failed busy save after a backoff allows no later save or effect', async (t) => {
  const fixture = await failActivitySave(t, false, true);
  let before;
  fixture.clock.onSleep = () => {
    before = fixture.gh.calls.length;
  };
  const err = await interpreter.runExecution(fixture.options).then(
    () => null,
    (err: Error) => err,
  );

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(fixture.sleeps, [60_000]);
  const saved = loadTicket(fixture);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop, null, 'nor its Terminal');
  assert.equal(saved.cursor.vertex, 'reviewer');
  assert.equal(saved.activity.busy, false, 'the failed transition is not saved by a cleanup');
  assert.equal(saved.retries[REVIEW_COMMENT]!.remote!.count, 1);
  assert.equal(fixture.gh.calls.length, before, 'no lookup or effect after the wait');
  assert.equal(commentPosts(fixture).length, 1);
  assert.equal(ticketComments(fixture).length, 0, 'no fault report');
  assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
});

test("a worktree backing off is idle to other Tickets' integrity checks", async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  // Another Ticket's Action, in the main checkout, writes into this worktree while it backs off.
  const other = { worktree: fixture.mainRoot, commonDir: fixture.commonDir };
  const check = {
    others: [fixture.worktree],
    protectedPaths: fixture.options.protectedPaths,
    git: fixture.options.deps.git,
  };
  const stray = join(fixture.worktree, 'stray.txt');
  let violations = undefined as integrity.IntegrityViolation[] | undefined;
  fixture.clock.onSleep = async () => {
    const baseline = await integrity.takeBaseline({ record: other, ...check });
    writeFileSync(stray, 'stray\n');
    ({ violations } = await integrity.findViolations({ baseline, record: other, access: 'workspace-write', ...check }));
    rmSync(stray);
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.ok(
    violations?.some((violation) => violation.worktree === fixture.worktree && violation.surface === 'tree'),
    JSON.stringify(violations),
  );
});

test('a remote auth failure stops the run and the next Execution stops before its first Action', async (t) => {
  const fixture = await golden.fixture(t);
  pushThrough(fixture, () =>
    Promise.reject(refusedPush("fatal: Authentication failed for 'https://github.com/o/r.git/'\n")),
  );
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(result.fault, undefined, 'a run stop, not a fault');
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  assert.deepEqual(fixture.sleeps, [], 'never retried');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stop' });
  assert.equal(final.terminalReason!.text, 'The push at push failed with class auth, which stops the whole run.');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);

  const next = await golden.fixture(t);
  const stopped = await interpreter.runExecution({ ...next.options, runState });

  assert.equal(stopped.outcome, 'needs-human', JSON.stringify(stopped));
  assert.equal(next.harness.calls.length, 0, 'no Action ran');
  const reason = loadTicket(next).terminalReason!;
  assert.deepEqual(reason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.equal(
    reason.text,
    `The push of Ticket #${golden.TICKET} failed with class auth, which stops the whole run, ` +
      'so this Execution stopped before red.',
  );
});

test('a remote permission failure faults only its Ticket', async (t) => {
  const fixture = await golden.fixture(t);
  pushThrough(fixture, () =>
    Promise.reject(
      refusedPush("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n"),
    ),
  );
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal(runStopEvent(fixture), null, 'the run goes on');
  assert.equal(runState.stop, null);
  assert.deepEqual(fixture.sleeps, [], 'never retried');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'fault');
  assert.equal(
    final.terminalReason!.text,
    'The push at push failed with class permission (HTTP 403), which faults only this Ticket; ' +
      'the error is in this comment and on ticket_end.',
  );
});

test("a remote auth failure in a Terminal's report latches the run stop and faults its Ticket", async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'unknown' } },
    },
  });
  fixture.gh.fail({
    matches: (args) => fakeGhModule.isCommentPost(args, golden.TICKET),
    status: 401,
    body: { message: 'Bad credentials' },
  });
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal(
    loadTicket(fixture).terminalReason!.text,
    'The comment at end-comment failed with class auth (HTTP 401), which stops the whole run; the error is in this ' +
      'comment and on ticket_end.',
  );
});

test('a remote run stop whose own report fails becomes a fault that keeps the run stop', async (t) => {
  const fixture = await golden.fixture(t);
  pushThrough(fixture, () =>
    Promise.reject(refusedPush("fatal: Authentication failed for 'https://github.com/o/r.git/'\n")),
  );
  fixture.gh.fail({
    matches: (args) => fakeGhModule.isCommentPost(args, golden.TICKET),
    status: 401,
    body: { message: 'Bad credentials' },
  });
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'fault');
  assert.ok(
    fixture.readEvents().some((event) => event.type === 'ticket_end'),
    'the Execution landed',
  );
  assert.match(
    ticketComments(fixture).at(-1)!.body,
    /\*\*Interrupted:\*\* the needs-human Terminal, whose Terminal Reason was: The push at push failed with class auth/,
  );
});

test("a remote auth failure first met in a fault's report keeps the run stop on the fault", async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'unknown' } },
    },
  });
  const onTicket = (args: string[]) => fakeGhModule.isCommentPost(args, golden.TICKET);
  fixture.gh.fail({ matches: onTicket, status: 422, body: { message: 'Validation Failed' } });
  fixture.gh.fail({ matches: onTicket, status: 401, body: { message: 'Bad credentials' } });
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  const final = loadTicket(fixture);
  assert.equal(final.state, 'fault');
  assert.equal(
    (runStopEvent(fixture) as events.ActionEvent | null)?.action,
    'fault-comment',
    "the fault report's failed comment records it",
  );
});

// #251: a failed Action is recorded where it fails, and the run stop is read from the Action Events.
const AUTH_REFUSED = "fatal: Authentication failed for 'https://github.com/o/r.git/'\n";
const FORBIDDEN = "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n";

test('a remote Action that fails for good records its Action Event with its class and error', async (t) => {
  for (const [name, stderr, failureClass, outcome] of [
    ['a push refused with auth', AUTH_REFUSED, 'auth', 'run-stop'],
    ['a push refused with a 403', FORBIDDEN, 'permission', 'fault'],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await golden.fixture(t);
      pushThrough(fixture, () => Promise.reject(refusedPush(stderr)));
      await interpreter.runExecution({ ...fixture.options, runState: { stop: null, remoteNotBefore: 0 } });

      const pushed = actionEvent(fixture, 'green', 'push');
      assert.ok(pushed, 'the failed push has an Action Event');
      const { agent, procedure, attempt, direction, rule, error } = pushed;
      assert.deepEqual(
        { agent, procedure, attempt, outcome: pushed.outcome, direction, rule, failureClass: pushed.failureClass },
        {
          agent: false,
          procedure: 'implement',
          attempt: 1,
          outcome,
          direction: 'stop',
          rule: { table: 'fixed', row: outcome },
          failureClass,
        },
      );
      assert.match(error!, /git push exited 128/);
    });
  }
});

test('a run stop survives a human abandonment of its Terminal', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'auth' } },
    },
  });
  // The run stop's own comment backs off, and a human sets needs-human meanwhile.
  fixture.gh.fail({ matches: (args) => fakeGhModule.isCommentPost(args, golden.TICKET), status: 502 });
  fixture.clock.onSleep = () => {
    fixture.gh.labels.add('gg:state:needs-human');
  };
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(loadTicket(fixture).state, 'abandoned');
  assert.equal(runState.stop?.ticket, golden.TICKET);
  assert.equal(result.runStop?.failureClass, 'auth', 'the result reads the run stop from the Action Events');
  assert.deepEqual(
    [
      (runStopEvent(fixture) as events.ActionEvent | null)?.action,
      (runStopEvent(fixture) as events.ActionEvent | null)?.failureClass,
    ],
    ['red', 'auth'],
  );
});

test('a stop routed to ready-for-qa keeps its run stop when the replacement report fails', async (t) => {
  const fixture = await golden.fixture(t);
  // A Check-only Vertex after publish whose failing lint Check routes ok and failed to ready-for-qa.
  golden.configure(fixture, (configured) => {
    configured.commands.lint = 'npm run lint';
    configured.procedures['lint-only'] = { actions: [{ id: 'lint', do: 'check', kind: 'command', command: 'lint' }] };
    configured.flows.golden.ticket.vertices.publish.route = { ok: 'lint' };
    configured.flows.golden.ticket.vertices.lint = {
      procedure: 'lint-only',
      route: { ok: { end: 'ready-for-qa' }, failed: { end: 'ready-for-qa' } },
    };
  });
  suiteRuns.answerCommand(fixture, 'npm run lint', () => ({ code: 1, output: 'lint failed', timedOut: false }));
  // ready-for-qa's comment meets auth, so a run stop replaces it; that run stop's comment then fails in an ordinary
  // way.
  const onTicket = (args: string[]) => fakeGhModule.isCommentPost(args, golden.TICKET);
  fixture.gh.fail({ matches: onTicket, status: 401, body: { message: 'Bad credentials' } });
  fixture.gh.fail({ matches: onTicket, status: 422, body: { message: 'Validation Failed' } });
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal(result.runStop?.failureClass, 'auth', 'the result reads the run stop from the Action Events');
  const stopped = runStopEvent(fixture) as events.ActionEvent | null;
  assert.deepEqual([stopped?.vertex, stopped?.action, stopped?.outcome], ['ready-for-qa', 'end-comment', 'run-stop']);
});

test("a failed Action's Event that cannot be saved still stops the run and saves nothing more", async (t) => {
  const fixture = await golden.fixture(t);
  pushThrough(fixture, () => Promise.reject(refusedPush(AUTH_REFUSED)));
  caseDatabase.failAppends(t, (event) => event.type === 'action' && event.action === 'push');
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const err = await interpreter.runExecution({ ...fixture.options, runState }).then(
    () => null,
    (err: Error) => err,
  );

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'push' });
  assert.equal(loadTicket(fixture).state, 'active', 'no fault is saved');
  assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
});
