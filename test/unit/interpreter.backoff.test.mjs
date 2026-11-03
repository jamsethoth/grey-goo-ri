import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as github from '../../lib/github.mjs';
import * as integrity from '../../lib/integrity.ts';
import * as run from '../../lib/run.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.ts';
import * as golden from '../support/golden.mjs';
import {
  steps,
  actionMarker,
  reviewFlow,
  prReviewComments,
  ticketComments,
  loadTicket,
  ticketRow,
  attemptMarker,
  PR,
  okReview,
  REVIEW_COMMENT,
  commentPosts,
  onPr,
  crashPost,
  originSha,
  headSha,
  actionEvent,
  runStopEvent,
} from '../support/interpreter.mjs';

// #83: the pr-upsert, pr-ready and push paths of the in-Action retry, end to end.
const PUSH = 'green/1/push/0';
const PR_UPSERT = 'green/1/pr/0';
const PR_READY = 'publish/1/pr-ready/0';
const isPr = (verb) => (args) => args[0] === 'pr' && args[1] === verb;
const prCalls = (g, verb) => g.gh.calls.filter((c) => isPr(verb)(c.args));
// A failed push as git reports it: only its text carries the status, with no headers to say how long to wait.
const pushError = () =>
  Object.assign(new Error('git push exited 128'), {
    code: 128,
    stdout: '',
    stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
  });

// The golden Execution on the orchestrator's locked git, whose nth raw push runs `push(n, real)`; returns the count.
function pushThrough(g, push) {
  let n = 0;
  const git = g.options.git;
  g.options.git = run.lockedGit({ ...git, push: (...args) => push(++n, () => git.push(...args)) }, g.commonDir);
  return () => n;
}

// Fails the first two launches of `gh pr <verb>` transiently and crashes the third as it launches; returns the count.
function crashPr(g, verb) {
  let n = 0;
  g.gh.fail({ matches: isPr(verb), status: 502 });
  g.gh.fail({ matches: isPr(verb), status: 502 });
  g.options.gh = github.createGh(async (args, cwd, input) => {
    if (isPr(verb)(args) && ++n === 3) throw new interpreter.CrashError(`crash as pr ${verb} launched`);
    return g.gh.gh(args, cwd, input);
  });
  return () => n;
}

// A retried Action that finished: the Ticket is ready-for-qa, the Action has one evidence and completion, and one retry was
// spent after the 60 s fallback.
async function retriedOnce(g, result, key, m) {
  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  const final = await loadTicket(g);
  assert.deepEqual(steps(final, m), ['intent', 'evidence', 'complete']);
  assert.equal(final.retries[key].remote.count, 1);
  return final;
}

test('a transient pr-upsert failure is retried and opens one PR', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('create'), status: 502 });
  let during;
  g.clock.onSleep = async () => {
    during = (await loadTicket(g)).pr;
  };
  const result = await interpreter.runExecution(g.options);

  const final = await retriedOnce(g, result, PR_UPSERT, attemptMarker(g, 'green', 1, 'pr', 0));
  assert.equal(during, null, 'no PR is recorded during the backoff');
  assert.equal(prCalls(g, 'create').length, 2, 'the failed create and one retry');
  assert.equal(g.gh.pr().number, PR, 'one PR');
  assert.equal(final.pr, PR);
  assert.equal(g.gh.pr().isDraft, false);
});

test('an accepted pr-upsert whose call errored is found, not repeated', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('create'), status: 502, afterEffect: true });
  const result = await interpreter.runExecution(g.options);

  const m = attemptMarker(g, 'green', 1, 'pr', 0);
  const final = await retriedOnce(g, result, PR_UPSERT, m);
  assert.equal(prCalls(g, 'create').length, 1, 'never created again');
  assert.equal(prCalls(g, 'edit').length, 1, "edited only by publish's re-render");
  assert.deepEqual(final.writeAheadLog.find((e) => e.actionMarker === m && e.step === 'evidence').evidence, {
    number: PR,
    url: g.gh.pr().url,
  });
  assert.equal(g.rec.pr, PR, 'restored from the found PR');
  assert.equal(final.pr, PR, 'and saved');
  assert.deepEqual(
    prCalls(g, 'ready').map((c) => c.args[2]),
    [String(PR)],
    'the found PR is the one made ready',
  );
});

test('a transient pr-ready failure is retried and the PR ends ready', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('ready'), status: 502 });
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PR_READY, attemptMarker(g, 'publish', 1, 'pr-ready', 0));
  assert.equal(prCalls(g, 'ready').length, 2, 'the failed call and one retry');
  assert.equal(g.gh.pr().isDraft, false);
});

test('an accepted pr-ready whose call errored is repeated with one state change', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('ready'), status: 502, afterEffect: true });
  const drafts = [];
  g.options.gh = github.createGh(async (args, cwd, input) => {
    if (isPr('ready')(args)) drafts.push(g.gh.pr().isDraft);
    return g.gh.gh(args, cwd, input);
  });
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PR_READY, attemptMarker(g, 'publish', 1, 'pr-ready', 0));
  assert.deepEqual(drafts, [true, false], 'made again on a PR already ready: one state change');
  assert.equal(g.gh.pr().isDraft, false);
});

test('a transient push failure is retried and pushes once', async (t) => {
  const g = await golden.setup(t);
  const pushes = pushThrough(g, (n, push) => (n === 1 ? Promise.reject(pushError()) : push()));
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PUSH, actionMarker(g, 'green', 'push'));
  assert.equal(pushes(), 2, 'the failed push and one retry');
  assert.equal(await originSha(g), await headSha(g));
});

test('a push that landed but whose call errored is found on origin, not pushed again', async (t) => {
  const g = await golden.setup(t);
  const unlocked = g.options.git;
  const pushes = pushThrough(g, async (n, push) => {
    await push();
    if (n === 1) throw pushError();
  });
  let during;
  g.clock.onSleep = async () => {
    during = await originSha(g, unlocked);
  };
  const result = await interpreter.runExecution(g.options);

  const m = actionMarker(g, 'green', 'push');
  const final = await retriedOnce(g, result, PUSH, m);
  const head = await headSha(g);
  assert.equal(during, head, 'origin had the commit during the backoff');
  assert.equal(pushes(), 1, 'never pushed again');
  assert.deepEqual(final.writeAheadLog.find((e) => e.actionMarker === m && e.step === 'evidence').evidence, {
    remoteSha: head,
  });
});

for (const [name, key, inject, text] of [
  [
    'pr-upsert',
    PR_UPSERT,
    (g) => {
      g.gh.fail({ matches: isPr('create'), status: 502 });
      g.gh.fail({ matches: isPr('create'), status: 502 });
      g.gh.fail({ matches: isPr('create'), status: 502 });
    },
    'A transient GitHub failure (HTTP 502) at pr persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
  [
    'pr-ready',
    PR_READY,
    (g) => {
      g.gh.fail({ matches: isPr('ready'), status: 502 });
      g.gh.fail({ matches: isPr('ready'), status: 502 });
      g.gh.fail({ matches: isPr('ready'), status: 502 });
    },
    'A transient GitHub failure (HTTP 502) at pr-ready persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
  [
    'push',
    PUSH,
    (g) => pushThrough(g, () => Promise.reject(pushError())),
    'A transient push failure (HTTP 503) at push persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
]) {
  test(`a ${name} whose retries run out holds with the exhausted reason`, async (t) => {
    const g = await golden.setup(t);
    inject(g);
    const result = await interpreter.runExecution(g.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.deepEqual(g.sleeps, [60_000, 120_000]);
    assert.equal(g.rec.terminalReason.text, text);
    assert.ok(
      g.logs.some((l) => l.includes(`${key}: transient failure, retries exhausted after 2 of 2`)),
      g.logs.join('\n'),
    );
    const final = await loadTicket(g);
    assert.equal(final.retries[key].remote.count, 2);
    assert.equal(final.state, 'fault');
    assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
  });
}

for (const [name, key, inject, text] of [
  [
    'pr-upsert',
    PR_UPSERT,
    (g) => crashPr(g, 'create'),
    'A transient GitHub failure at pr persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
  [
    'pr-ready',
    PR_READY,
    (g) => crashPr(g, 'ready'),
    'A transient GitHub failure at pr-ready persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
  [
    'push',
    PUSH,
    (g) =>
      pushThrough(g, (n) =>
        Promise.reject(n === 3 ? new interpreter.CrashError('crash as the push launched') : pushError()),
      ),
    'A transient push failure at push persisted after 2 retries; the error is in this comment and on ticket_end.',
  ],
]) {
  test(`a ${name} that crashes after launch spends its saved budget on resume`, async (t) => {
    const g = await golden.setup(t);
    const launches = inject(g);
    // Two transient failures spend the budget; the second retry crashes as it launches.
    await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
    const mid = await loadTicket(g);
    assert.equal(mid.retries[key].remote.count, 2);
    assert.equal(mid.retries[key].remote.started, true, 'the last retry launched');

    const result = await interpreter.runExecution({ ...g.options, record: mid });
    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(launches(), 3, 'no fourth launch');
    const final = await loadTicket(g);
    assert.equal(final.retries[key].remote.count, 2, 'the budget is not refilled');
    assert.equal(final.terminalReason.text, text);
    assert.ok(
      g.logs.some((l) => l.includes(`${key}: transient failure, retries exhausted after 2 of 2`)),
      g.logs.join('\n'),
    );
    assert.equal(final.state, 'fault');
    assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
  });
}

// #85: a backoff is bounded, stops with the Run, and leaves its worktree idle while it waits.
const HOUR = 3_600_000;
const rateLimitedFor = (ms) =>
  onPr({
    status: 403,
    headers: { 'Retry-After': String(ms / 1000) },
    body: { message: 'You have exceeded a secondary rate limit.' },
  });

test('a backoff longer than the timer limit sleeps in bounded chunks', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(rateLimitedFor(30 * 24 * HOUR));
  const calls = new Set();
  g.clock.onSleep = () => {
    calls.add(g.gh.calls.length);
  };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(g.sleeps, Array(720).fill(HOUR), 'one sleep of an hour per hour of the 30 days');
  assert.deepEqual([...calls], [g.gh.calls.indexOf(commentPosts(g)[0]) + 1], 'no lookup or launch between the chunks');
  assert.equal(prReviewComments(g).length, 1);
});

test('a backoff keeps one idle generation across timer chunks', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(rateLimitedFor(2 * HOUR));
  const seen = [];
  g.clock.onSleep = async () => {
    seen.push((await loadTicket(g)).activity);
  };
  const result = await interpreter.runExecution(g.options);

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
]) {
  test(`an ${name} saved retry deadline is logged and held`, async (t) => {
    const g = await reviewFlow(t, okReview);
    const m = attemptMarker(g, 'reviewer', 1, 'comment', 0);
    g.gh.fail(onPr({ status: 502 }));
    await assert.rejects(
      interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-retry-saved' } }),
      (err) => err instanceof interpreter.CrashError,
    );
    const mid = await loadTicket(g);
    mid.retries[REVIEW_COMMENT].remote.nextEligibleAt = deadline(g.clock.now());
    const saved = structuredClone(mid.retries[REVIEW_COMMENT].remote);
    const result = await interpreter.runExecution({ ...g.options, record: mid });

    assert.equal(result.held, true, JSON.stringify(result));
    assert.deepEqual(g.sleeps, [], 'never waited');
    assert.equal(commentPosts(g).length, 1, 'never retried');
    assert.ok(
      g.logs.includes(
        `#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline ${shown} is not a time within 31 days, so it is held`,
      ),
      g.logs.join('\n'),
    );
    const final = await loadTicket(g);
    assert.equal(final.state, 'held');
    assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the saved retry is kept');
  });
}

test('a wait over 31 days from GitHub is held without reserving a retry', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(rateLimitedFor(40 * 24 * HOUR));
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.held, true, JSON.stringify(result));
  assert.deepEqual(g.sleeps, [], 'never waited');
  assert.equal(commentPosts(g).length, 1, 'never retried');
  assert.ok(
    g.logs.includes(
      `#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline 2026-11-24T00:00:00.000Z is not a time within 31 days, so it is held`,
    ),
    g.logs.join('\n'),
  );
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.equal(final.retries[REVIEW_COMMENT].remote.count, 0, 'no retry is spent');
});

test('a run stop during a backoff ends the Execution at needs-human', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  const runState = { stop: null, remoteNotBefore: 0 };
  let saved;
  // Another Ticket's harness call stops the run while this one backs off.
  g.clock.onSleep = async () => {
    saved = (await loadTicket(g)).retries[REVIEW_COMMENT].remote;
    runState.stop = { failureClass: 'auth', ticket: 21 };
  };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  assert.equal(commentPosts(g).length, 1, 'no retry launched');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry stays as saved');
  assert.equal(
    final.terminalReason.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped while waiting to retry comment; its retry is kept as saved.',
  );
  assert.ok(
    ticketComments(g).some((c) => c.body.includes(final.terminalReason.text)),
    'the needs-human comment says so',
  );
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

test('a latched run stop does not consume a relaunch retry', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  const posts = crashPost(g, 2);
  await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
  const mid = await loadTicket(g);
  const saved = structuredClone(mid.retries[REVIEW_COMMENT].remote);
  assert.equal(saved.started, true, 'the first retry launched');
  // Another Ticket stops the run once this Action is under way, after the Visit's own check.
  let stop = null;
  const runState = {
    remoteNotBefore: 0,
    get stop() {
      return (stop ??= ticketRow(g).activity.busy ? { failureClass: 'auth', ticket: 21 } : null);
    },
  };
  const result = await interpreter.runExecution({ ...g.options, record: mid, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(posts(), 2, 'not launched again');
  const final = await loadTicket(g);
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry is not spent');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stopped' });
});

test('a rate-limited push keeps the fallback without a probe', async (t) => {
  const g = await golden.setup(t);
  const limited = () =>
    Object.assign(pushError(), {
      stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
    });
  const pushes = pushThrough(g, (n, push) => (n === 1 ? Promise.reject(limited()) : push()));
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PUSH, actionMarker(g, 'green', 'push'));
  assert.equal(pushes(), 2);
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'api' && c.args[1] === 'rate_limit'), 'git gives no quota to read');
});

test('a run stop during a pr-ready backoff ends at needs-human without marking ready', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('ready'), status: 502 });
  const runState = { stop: null, remoteNotBefore: 0 };
  let saved;
  g.clock.onSleep = async () => {
    saved = (await loadTicket(g)).retries[PR_READY].remote;
    runState.stop = { failureClass: 'auth', ticket: 21 };
  };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  assert.equal(prCalls(g, 'ready').length, 1, 'no retry launched');
  assert.equal(g.gh.pr().isDraft, true, 'the PR is not marked ready');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[PR_READY].remote, saved, 'the retry stays as saved');
  assert.equal(
    final.terminalReason.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped while waiting to retry pr-ready; its retry is kept as saved.',
  );
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

test('a run stop during the ready-for-qa comment backoff ends at needs-human after pr-ready', async (t) => {
  const g = await golden.setup(t);
  const DONE_COMMENT = 'ready-for-qa/1/end-comment/0';
  g.gh.fail({
    matches: (args) => golden.isCommentPost(args, golden.TICKET) && prCalls(g, 'ready').length > 0,
    status: 502,
  });
  const runState = { stop: null, remoteNotBefore: 0 };
  let saved;
  g.clock.onSleep = async () => {
    saved = (await loadTicket(g)).retries[DONE_COMMENT].remote;
    runState.stop = { failureClass: 'auth', ticket: 21 };
  };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  assert.equal(prCalls(g, 'ready').length, 1);
  assert.equal(g.gh.pr().isDraft, false, 'pr-ready had landed');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[DONE_COMMENT].remote, saved, 'the retry stays as saved');
  assert.ok(!ticketComments(g).some((c) => c.body.startsWith('### gg: ready-for-qa')), 'no ready-for-qa comment lands');
  assert.ok(
    ticketComments(g).some((c) => c.body.startsWith('### gg: needs-human')),
    'the needs-human comment lands',
  );
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'needs-human, and not ready-for-qa');
});

test('a run stop during a resume lookup backoff ends at needs-human', async (t) => {
  const g = await reviewFlow(t, okReview);
  const m = attemptMarker(g, 'reviewer', 1, 'comment', 0);
  g.gh.fail(onPr({ status: 502 }));
  await assert.rejects(
    interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const mid = await loadTicket(g);
  const saved = structuredClone(mid.retries[REVIEW_COMMENT].remote);
  const runState = { stop: null, remoteNotBefore: 0 };
  // Reconciliation's lookup waits out the saved retry; another Ticket stops the run meanwhile.
  g.clock.onSleep = () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
  };
  const result = await interpreter.runExecution({ ...g.options, record: mid, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  assert.equal(commentPosts(g).length, 1, 'no retry launched');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry stays as saved');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

// The backoff's own transition fails: the first save after the retry that flips the worktree `from` busy `to` busy.
async function failActivitySave(t, from, to) {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  golden.failSaves(
    t,
    (saved, next) =>
      saved?.activity.busy === from && next.activity.busy === to && next.retries[REVIEW_COMMENT]?.remote?.count === 1,
  );
  return g;
}

test('a failed idle save before a backoff allows no later save or effect', async (t) => {
  const g = await failActivitySave(t, true, false);
  const err = await interpreter.runExecution(g.options).then(
    () => null,
    (e) => e,
  );

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(g.sleeps, [], 'never waited');
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop, null, 'nor its Terminal');
  assert.equal(saved.cursor.vertex, 'reviewer');
  assert.equal(saved.activity.busy, true, 'the failed transition is not saved by a cleanup');
  assert.equal(saved.retries[REVIEW_COMMENT].remote.count, 1);
  assert.equal(commentPosts(g).length, 1);
  assert.equal(ticketComments(g).length, 0, 'no fault report');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('a failed busy save after a backoff allows no later save or effect', async (t) => {
  const g = await failActivitySave(t, false, true);
  let before;
  g.clock.onSleep = () => {
    before = g.gh.calls.length;
  };
  const err = await interpreter.runExecution(g.options).then(
    () => null,
    (e) => e,
  );

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(g.sleeps, [60_000]);
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop, null, 'nor its Terminal');
  assert.equal(saved.cursor.vertex, 'reviewer');
  assert.equal(saved.activity.busy, false, 'the failed transition is not saved by a cleanup');
  assert.equal(saved.retries[REVIEW_COMMENT].remote.count, 1);
  assert.equal(g.gh.calls.length, before, 'no lookup or effect after the wait');
  assert.equal(commentPosts(g).length, 1);
  assert.equal(ticketComments(g).length, 0, 'no fault report');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test("a worktree backing off is idle to other Tickets' integrity checks", async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  // Another Ticket's Action, in the main checkout, writes into this worktree while it backs off.
  const other = { worktree: g.mainRoot, commonDir: g.commonDir };
  const check = { others: [g.worktree], protectedPaths: g.options.protectedPaths, git: g.options.git };
  const stray = join(g.worktree, 'stray.txt');
  let violations;
  g.clock.onSleep = async () => {
    const baseline = await integrity.begin({ record: other, ...check });
    writeFileSync(stray, 'stray\n');
    ({ violations } = await integrity.end({ baseline, record: other, access: 'workspace-write', ...check }));
    rmSync(stray);
  };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.ok(
    violations?.some((v) => v.worktree === g.worktree && v.surface === 'tree'),
    JSON.stringify(violations),
  );
});

// A push git refused: a credential failure carries no status, a permission refusal its 403.
const refusedPush = (stderr) => Object.assign(new Error('git push exited 128'), { code: 128, stdout: '', stderr });

test('a remote auth failure stops the run and the next Execution stops before its first Action', async (t) => {
  const g = await golden.setup(t);
  pushThrough(g, () => Promise.reject(refusedPush("fatal: Authentication failed for 'https://github.com/o/r.git/'\n")));
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(result.fault, undefined, 'a run stop, not a fault');
  assert.equal(runStopEvent(g)?.failureClass, 'auth');
  assert.deepEqual(g.sleeps, [], 'never retried');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason.rule, { table: 'fixed', row: 'run-stop' });
  assert.equal(final.terminalReason.text, 'The push at push failed with class auth, which stops the whole run.');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);

  const next = await golden.setup(t);
  const stopped = await interpreter.runExecution({ ...next.options, runState });

  assert.equal(stopped.outcome, 'needs-human', JSON.stringify(stopped));
  assert.equal(next.harness.calls.length, 0, 'no Action ran');
  const reason = (await loadTicket(next)).terminalReason;
  assert.deepEqual(reason.rule, { table: 'fixed', row: 'run-stopped' });
  assert.equal(
    reason.text,
    `The push of Ticket #${golden.TICKET} failed with class auth, which stops the whole run, so this Execution stopped before red.`,
  );
});

test('a remote permission failure faults only its Ticket', async (t) => {
  const g = await golden.setup(t);
  pushThrough(g, () =>
    Promise.reject(
      refusedPush("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n"),
    ),
  );
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal(runStopEvent(g), null, 'the run goes on');
  assert.equal(runState.stop, null);
  assert.deepEqual(g.sleeps, [], 'never retried');
  const final = await loadTicket(g);
  assert.equal(final.state, 'fault');
  assert.equal(
    final.terminalReason.text,
    'The push at push failed with class permission (HTTP 403), which faults only this Ticket; the error is in this comment and on ticket_end.',
  );
});

test("a remote auth failure in a Terminal's report latches the run stop and faults its Ticket", async (t) => {
  const g = await golden.setup(t, {
    responses: { 'red/1/red/1': { files: {}, response: null, failure: { failureClass: 'unknown' } } },
  });
  g.gh.fail({
    matches: (args) => golden.isCommentPost(args, golden.TICKET),
    status: 401,
    body: { message: 'Bad credentials' },
  });
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal(runStopEvent(g)?.failureClass, 'auth');
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal(
    (await loadTicket(g)).terminalReason.text,
    'The comment at end-comment failed with class auth (HTTP 401), which stops the whole run; the error is in this ' +
      'comment and on ticket_end.',
  );
});

test('a remote run stop whose own report fails becomes a fault that keeps the run stop', async (t) => {
  const g = await golden.setup(t);
  pushThrough(g, () => Promise.reject(refusedPush("fatal: Authentication failed for 'https://github.com/o/r.git/'\n")));
  g.gh.fail({
    matches: (args) => golden.isCommentPost(args, golden.TICKET),
    status: 401,
    body: { message: 'Bad credentials' },
  });
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.equal(runStopEvent(g)?.failureClass, 'auth');
  const final = await loadTicket(g);
  assert.equal(final.state, 'fault');
  assert.ok(
    g.readEvents().some((e) => e.type === 'ticket_end'),
    'the Execution landed',
  );
  assert.match(
    ticketComments(g).at(-1).body,
    /\*\*Interrupted:\*\* the needs-human Terminal, whose Terminal Reason was: The push at push failed with class auth/,
  );
});

test("a remote auth failure first met in a fault's report keeps the run stop on the fault", async (t) => {
  const g = await golden.setup(t, {
    responses: { 'red/1/red/1': { files: {}, response: null, failure: { failureClass: 'unknown' } } },
  });
  const onTicket = (args) => golden.isCommentPost(args, golden.TICKET);
  g.gh.fail({ matches: onTicket, status: 422, body: { message: 'Validation Failed' } });
  g.gh.fail({ matches: onTicket, status: 401, body: { message: 'Bad credentials' } });
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal(runStopEvent(g)?.failureClass, 'auth');
  const final = await loadTicket(g);
  assert.equal(final.state, 'fault');
  assert.equal(runStopEvent(g)?.action, 'fault-comment', "the fault report's failed comment records it");
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
      const g = await golden.setup(t);
      pushThrough(g, () => Promise.reject(refusedPush(stderr)));
      await interpreter.runExecution({ ...g.options, runState: { stop: null, remoteNotBefore: 0 } });

      const pushed = actionEvent(g, 'green', 'push');
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
      assert.match(error, /git push exited 128/);
    });
  }
});

test('a run stop survives a human abandonment of its Terminal', async (t) => {
  const g = await golden.setup(t, {
    responses: { 'red/1/red/1': { files: {}, response: null, failure: { failureClass: 'auth' } } },
  });
  // The run stop's own comment backs off, and a human sets needs-human meanwhile.
  g.gh.fail({ matches: (args) => golden.isCommentPost(args, golden.TICKET), status: 502 });
  g.clock.onSleep = () => {
    g.gh.labels.add('gg:state:needs-human');
  };
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(runState.stop?.ticket, golden.TICKET);
  assert.equal(result.runStop?.failureClass, 'auth', 'the result reads the run stop from the Action Events');
  assert.deepEqual([runStopEvent(g)?.action, runStopEvent(g)?.failureClass], ['red', 'auth']);
});

test('a stop routed to ready-for-qa keeps its run stop when the replacement report fails', async (t) => {
  const g = await golden.setup(t);
  // A Check-only Vertex after publish whose failing lint Check routes ok and failed to ready-for-qa.
  golden.configure(g, (c) => {
    c.commands.lint = 'npm run lint';
    c.procedures['lint-only'] = { actions: [{ id: 'lint', do: 'check', kind: 'command', command: 'lint' }] };
    c.flows.golden.ticket.vertices.publish.route = { ok: 'lint' };
    c.flows.golden.ticket.vertices.lint = {
      procedure: 'lint-only',
      route: { ok: { end: 'ready-for-qa' }, failed: { end: 'ready-for-qa' } },
    };
  });
  const { runShell } = g.options.exec;
  g.options.exec = {
    runShell: (command, opts) =>
      command === 'npm run lint'
        ? Promise.resolve({ code: 1, output: 'lint failed', timedOut: false })
        : runShell(command, opts),
  };
  // ready-for-qa's comment meets auth, so a run stop replaces it; that run stop's comment then fails in an ordinary way.
  const onTicket = (args) => golden.isCommentPost(args, golden.TICKET);
  g.gh.fail({ matches: onTicket, status: 401, body: { message: 'Bad credentials' } });
  g.gh.fail({ matches: onTicket, status: 422, body: { message: 'Validation Failed' } });
  const runState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(result.fault, true, JSON.stringify(result));
  assert.deepEqual(runState.stop, { failureClass: 'auth', ticket: golden.TICKET, source: 'comment' });
  assert.equal(result.runStop?.failureClass, 'auth', 'the result reads the run stop from the Action Events');
  const stopped = runStopEvent(g);
  assert.deepEqual([stopped?.vertex, stopped?.action, stopped?.outcome], ['ready-for-qa', 'end-comment', 'run-stop']);
});
