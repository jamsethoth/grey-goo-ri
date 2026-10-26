import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as run from '../../lib/run.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  steps, actionMarker, reviewFlow, prReviewComments, ticketComments, loadTicket, ticketRow, attemptMarker,
  PR, okReview, REVIEW_COMMENT, commentPosts, onPr, crashPost, originSha, headSha,
} from '../support/interpreter.mjs';

// #83: the pr-upsert, pr-ready and push paths of the in-Action retry, end to end.
const PUSH = 'implementer/1/green/4';
const PR_UPSERT = 'implementer/1/green/5';
const PR_READY = 'done/1/done/1';
const isPr = (verb) => (args) => args[0] === 'pr' && args[1] === verb;
const prCalls = (g, verb) => g.gh.calls.filter((c) => isPr(verb)(c.args));
// A failed push as git reports it: only its text carries the status, with no headers to say how long to wait.
const pushError = () => Object.assign(new Error('git push exited 128'),
  { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503" });

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
  g.options.gh.setGh(async (args, cwd, input) => {
    if (isPr(verb)(args) && ++n === 3) throw new interpreter.CrashError(`crash as pr ${verb} launched`);
    return g.gh.gh(args, cwd, input);
  });
  return () => n;
}

// A retried Action that finished: the Ticket is done, the Action has one evidence and completion, and one retry was
// spent after the 60 s fallback.
async function retriedOnce(g, result, key, m) {
  assert.equal(result.outcome, 'done', JSON.stringify(result));
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
  g.clock.onSleep = async () => { during = (await loadTicket(g)).pr; };
  const result = await interpreter.runExecution(g.options);

  const final = await retriedOnce(g, result, PR_UPSERT, attemptMarker(g, 'implementer', 1, 'green', 5));
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

  const m = attemptMarker(g, 'implementer', 1, 'green', 5);
  const final = await retriedOnce(g, result, PR_UPSERT, m);
  assert.equal(prCalls(g, 'create').length, 1, 'never created again');
  assert.equal(prCalls(g, 'edit').length, 0, 'nor edited');
  assert.deepEqual(final.log.find((e) => e.marker === m && e.step === 'evidence').evidence, { number: PR, url: g.gh.pr().url });
  assert.equal(g.rec.pr, PR, 'restored from the found PR');
  assert.equal(final.pr, PR, 'and saved');
  assert.deepEqual(prCalls(g, 'ready').map((c) => c.args[2]), [String(PR)], 'the found PR is the one made ready');
});

test('a transient pr-ready failure is retried and the PR ends ready', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('ready'), status: 502 });
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PR_READY, attemptMarker(g, 'done', 1, 'done', 1));
  assert.equal(prCalls(g, 'ready').length, 2, 'the failed call and one retry');
  assert.equal(g.gh.pr().isDraft, false);
});

test('an accepted pr-ready whose call errored is repeated with one state change', async (t) => {
  const g = await golden.setup(t);
  g.gh.fail({ matches: isPr('ready'), status: 502, afterEffect: true });
  const drafts = [];
  g.options.gh.setGh(async (args, cwd, input) => {
    if (isPr('ready')(args)) drafts.push(g.gh.pr().isDraft);
    return g.gh.gh(args, cwd, input);
  });
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PR_READY, attemptMarker(g, 'done', 1, 'done', 1));
  assert.deepEqual(drafts, [true, false], 'made again on a PR already ready: one state change');
  assert.equal(g.gh.pr().isDraft, false);
});

test('a transient push failure is retried and pushes once', async (t) => {
  const g = await golden.setup(t);
  const pushes = pushThrough(g, (n, push) => (n === 1 ? Promise.reject(pushError()) : push()));
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PUSH, actionMarker(g, 'green', 4));
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
  g.clock.onSleep = async () => { during = await originSha(g, unlocked); };
  const result = await interpreter.runExecution(g.options);

  const m = actionMarker(g, 'green', 4);
  const final = await retriedOnce(g, result, PUSH, m);
  const head = await headSha(g);
  assert.equal(during, head, 'origin had the commit during the backoff');
  assert.equal(pushes(), 1, 'never pushed again');
  assert.deepEqual(final.log.find((e) => e.marker === m && e.step === 'evidence').evidence, { remoteSha: head });
});

for (const [name, key, inject, text] of [
  ['pr-upsert', PR_UPSERT, (g) => {
    g.gh.fail({ matches: isPr('create'), status: 502 });
    g.gh.fail({ matches: isPr('create'), status: 502 });
    g.gh.fail({ matches: isPr('create'), status: 502 });
  }, 'A transient GitHub failure (HTTP 502) at green 5 persisted after 2 retries; the error is in this comment and on ticket_end.'],
  ['pr-ready', PR_READY, (g) => {
    g.gh.fail({ matches: isPr('ready'), status: 502 });
    g.gh.fail({ matches: isPr('ready'), status: 502 });
    g.gh.fail({ matches: isPr('ready'), status: 502 });
  }, 'A transient GitHub failure (HTTP 502) at done 1 persisted after 2 retries; the error is in this comment and on ticket_end.'],
  ['push', PUSH, (g) => pushThrough(g, () => Promise.reject(pushError())),
    'A transient push failure (HTTP 503) at green 4 persisted after 2 retries; the error is in this comment and on ticket_end.'],
]) {
  test(`a ${name} whose retries run out holds with the exhausted reason`, async (t) => {
    const g = await golden.setup(t);
    inject(g);
    const result = await interpreter.runExecution(g.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.deepEqual(g.sleeps, [60_000, 120_000]);
    assert.equal(g.rec.terminalReason.text, text);
    assert.ok(g.logs.some((l) => l.includes(`${key}: transient failure, retries exhausted after 2 of 2`)), g.logs.join('\n'));
    const final = await loadTicket(g);
    assert.equal(final.retries[key].remote.count, 2);
    assert.equal(final.state, 'fault');
    assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
  });
}

for (const [name, key, inject, text] of [
  ['pr-upsert', PR_UPSERT, (g) => crashPr(g, 'create'),
    'A transient GitHub failure at green 5 persisted after 2 retries; the error is in this comment and on ticket_end.'],
  ['pr-ready', PR_READY, (g) => crashPr(g, 'ready'),
    'A transient GitHub failure at done 1 persisted after 2 retries; the error is in this comment and on ticket_end.'],
  ['push', PUSH, (g) => pushThrough(g, (n) => Promise.reject(n === 3 ? new interpreter.CrashError('crash as the push launched') : pushError())),
    'A transient push failure at green 4 persisted after 2 retries; the error is in this comment and on ticket_end.'],
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
    assert.ok(g.logs.some((l) => l.includes(`${key}: transient failure, retries exhausted after 2 of 2`)), g.logs.join('\n'));
    assert.equal(final.state, 'fault');
    assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
  });
}

// #85: a backoff is bounded, stops with the Run, and leaves its worktree idle while it waits.
const HOUR = 3_600_000;
const rateLimitedFor = (ms) => onPr({ status: 403, headers: { 'Retry-After': String(ms / 1000) },
  body: { message: 'You have exceeded a secondary rate limit.' } });

test('a backoff longer than the timer limit sleeps in bounded chunks', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(rateLimitedFor(30 * 24 * HOUR));
  const calls = new Set();
  g.clock.onSleep = () => { calls.add(g.gh.calls.length); };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'done', JSON.stringify(result));
  assert.deepEqual(g.sleeps, Array(720).fill(HOUR), 'one sleep of an hour per hour of the 30 days');
  assert.deepEqual([...calls], [g.gh.calls.indexOf(commentPosts(g)[0]) + 1], 'no lookup or launch between the chunks');
  assert.equal(prReviewComments(g).length, 1);
});

test('a backoff keeps one idle generation across timer chunks', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(rateLimitedFor(2 * HOUR));
  const seen = [];
  g.clock.onSleep = async () => { seen.push((await loadTicket(g)).activity); };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'done', JSON.stringify(result));
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
    const m = attemptMarker(g, 'reviewer', 1, 'review', 3);
    g.gh.fail(onPr({ status: 502 }));
    await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-retry-saved' } }),
      (err) => err instanceof interpreter.CrashError);
    const mid = await loadTicket(g);
    mid.retries[REVIEW_COMMENT].remote.nextEligibleAt = deadline(g.clock.now());
    const saved = structuredClone(mid.retries[REVIEW_COMMENT].remote);
    const result = await interpreter.runExecution({ ...g.options, record: mid });

    assert.equal(result.held, true, JSON.stringify(result));
    assert.deepEqual(g.sleeps, [], 'never waited');
    assert.equal(commentPosts(g).length, 1, 'never retried');
    assert.ok(g.logs.includes(`#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline ${shown} is not a time within 31 days, so it is held`),
      g.logs.join('\n'));
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
  assert.ok(g.logs.includes(`#${golden.TICKET} ${REVIEW_COMMENT}: retry deadline 2026-11-24T00:00:00.000Z is not a time within 31 days, so it is held`),
    g.logs.join('\n'));
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
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry stays as saved');
  assert.equal(final.terminalReason.text, 'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this '
    + 'Execution stopped while waiting to retry review 3; its retry is kept as saved.');
  assert.ok(ticketComments(g).some((c) => c.body.includes(final.terminalReason.text)), 'the needs-human comment says so');
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
  const runState = { remoteNotBefore: 0, get stop() { return (stop ??= ticketRow(g).activity.busy ? { failureClass: 'auth', ticket: 21 } : null); } };
  const result = await interpreter.runExecution({ ...g.options, record: mid, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(posts(), 2, 'not launched again');
  const final = await loadTicket(g);
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry is not spent');
  assert.equal(final.terminalReason.rule, 'run-stopped');
});

test('a rate-limited push keeps the fallback without a probe', async (t) => {
  const g = await golden.setup(t);
  const limited = () => Object.assign(pushError(),
    { stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429" });
  const pushes = pushThrough(g, (n, push) => (n === 1 ? Promise.reject(limited()) : push()));
  const result = await interpreter.runExecution(g.options);

  await retriedOnce(g, result, PUSH, actionMarker(g, 'green', 4));
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
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.deepEqual(final.retries[PR_READY].remote, saved, 'the retry stays as saved');
  assert.equal(final.terminalReason.text, 'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this '
    + 'Execution stopped while waiting to retry done 1; its retry is kept as saved.');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

test('a run stop during the done comment backoff ends at needs-human after pr-ready', async (t) => {
  const g = await golden.setup(t);
  const DONE_COMMENT = 'done/1/done/2';
  g.gh.fail({ matches: (args) => golden.isCommentPost(args, golden.TICKET) && prCalls(g, 'ready').length > 0, status: 502 });
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
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.deepEqual(final.retries[DONE_COMMENT].remote, saved, 'the retry stays as saved');
  assert.ok(!ticketComments(g).some((c) => c.body.startsWith('### gg: done')), 'no done comment lands');
  assert.ok(ticketComments(g).some((c) => c.body.startsWith('### gg: needs-human')), 'the needs-human comment lands');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'needs-human, and not ready-for-qa');
});

test('a run stop during a resume lookup backoff ends at needs-human', async (t) => {
  const g = await reviewFlow(t, okReview);
  const m = attemptMarker(g, 'reviewer', 1, 'review', 3);
  g.gh.fail(onPr({ status: 502 }));
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError);
  const mid = await loadTicket(g);
  const saved = structuredClone(mid.retries[REVIEW_COMMENT].remote);
  const runState = { stop: null, remoteNotBefore: 0 };
  // Reconciliation's lookup waits out the saved retry; another Ticket stops the run meanwhile.
  g.clock.onSleep = () => { runState.stop = { failureClass: 'auth', ticket: 21 }; };
  const result = await interpreter.runExecution({ ...g.options, record: mid, runState });

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [60_000]);
  assert.equal(commentPosts(g).length, 1, 'no retry launched');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.deepEqual(final.retries[REVIEW_COMMENT].remote, saved, 'the retry stays as saved');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

// The backoff's own transition fails: the first save after the retry that flips the worktree `from` busy `to` busy.
async function failActivitySave(t, from, to) {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  golden.failSaves(t, (saved, next) => saved?.activity.busy === from && next.activity.busy === to
    && next.retries[REVIEW_COMMENT]?.remote?.count === 1);
  return g;
}

test('a failed idle save before a backoff allows no later save or effect', async (t) => {
  const g = await failActivitySave(t, true, false);
  const err = await interpreter.runExecution(g.options).then(() => null, (e) => e);

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(g.sleeps, [], 'never waited');
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop ?? null, null, 'nor its Terminal');
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
  g.clock.onSleep = () => { before = g.gh.calls.length; };
  const err = await interpreter.runExecution(g.options).then(() => null, (e) => e);

  assert.equal(err?.name, 'RecordSaveError', String(err));
  assert.deepEqual(g.sleeps, [60_000]);
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved');
  assert.equal(saved.terminalStop ?? null, null, 'nor its Terminal');
  assert.equal(saved.cursor.vertex, 'reviewer');
  assert.equal(saved.activity.busy, false, 'the failed transition is not saved by a cleanup');
  assert.equal(saved.retries[REVIEW_COMMENT].remote.count, 1);
  assert.equal(g.gh.calls.length, before, 'no lookup or effect after the wait');
  assert.equal(commentPosts(g).length, 1);
  assert.equal(ticketComments(g).length, 0, 'no fault report');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});
