import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../lib/interpreter.mjs';
import * as marker from '../lib/marker.mjs';
import * as golden from './support/golden.mjs';
import {
  steps, neededHuman, reviewFlow, prReviewComments, ticketComments, loadTicket, ticketRow, attemptMarker, PR, okReview,
  REVIEW_COMMENT, commentPosts, onPr, crashPost, contendRepoLock, lockedSetup,
} from './support/interpreter.mjs';

test('a transient comment failure is retried once and posts one comment', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'done', JSON.stringify(result));
  const posts = commentPosts(g);
  assert.equal(posts.length, 2, 'the failed POST and one retry');
  assert.equal(posts[1].input, posts[0].input, 'the retry sends the recorded payload');
  const between = g.gh.calls.slice(g.gh.calls.indexOf(posts[0]) + 1, g.gh.calls.indexOf(posts[1]));
  assert.ok(between.some((c) => golden.isCommentRead(c.args, PR)), 'the marker lookup runs before the retry');
  const m = attemptMarker(g, 'reviewer', 1, 'review', 3);
  const [posted, ...more] = prReviewComments(g);
  assert.equal(more.length, 0, 'exactly one review comment');
  assert.ok(posted.body.includes(marker.markerComment(m)), 'it carries the original Action Marker');
  assert.deepEqual(g.sleeps, [60_000], 'with no Retry-After the retry waits the 60 s fallback');
  const final = await loadTicket(g);
  assert.deepEqual(steps(final, m), ['intent', 'evidence', 'complete']);
  assert.equal(final.retries[REVIEW_COMMENT].remote.count, 1);
  assert.equal(g.readEvents().filter((e) => e.type === 'action' && `${e.vertex}/${e.visit}/${e.phase}/${e.ordinal}` === REVIEW_COMMENT).length, 1,
    'one Action Event for the retried Action');
});

test('retry-after is honoured on the fake clock', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 403, headers: { 'Retry-After': '7' },
    body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }));
  let seen = null;
  g.clock.onSleep = () => { seen ??= { now: g.clock.now(), calls: g.gh.calls.length, saved: ticketRow(g).retries[REVIEW_COMMENT]?.remote }; };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'done', JSON.stringify(result));
  assert.deepEqual(g.sleeps, [7_000]);
  assert.deepEqual(seen?.saved, { count: 1, class: 'rate-limited', nextEligibleAt: seen?.now + 7_000, started: false },
    'the retry is saved before the sleep');
  assert.equal(seen.calls, g.gh.calls.indexOf(commentPosts(g)[0]) + 1, 'neither the lookup nor the effect runs before the sleep');
  assert.equal(commentPosts(g).length, 2);
  assert.equal(prReviewComments(g).length, 1);
});

test('an accepted write whose call errored is found by marker, not reposted', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502, afterEffect: true }));
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'done', JSON.stringify(result));
  assert.equal(commentPosts(g).length, 1, 'never posted again');
  const [posted, ...more] = prReviewComments(g);
  assert.equal(more.length, 0);
  const m = attemptMarker(g, 'reviewer', 1, 'review', 3);
  const final = await loadTicket(g);
  assert.deepEqual(steps(final, m), ['intent', 'evidence', 'complete']);
  assert.equal(final.log.find((e) => e.marker === m && e.step === 'evidence').evidence.id, posted.id, 'the found comment is the evidence');
});

test('the retry budget survives a crash', async (t) => {
  const g = await reviewFlow(t, okReview);
  const m = attemptMarker(g, 'reviewer', 1, 'review', 3);
  g.gh.fail(onPr({ status: 502 }));
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError);
  const mid = await loadTicket(g);
  assert.equal(mid.retries[REVIEW_COMMENT]?.remote?.count, 1, 'the first retry was saved before the crash');
  assert.deepEqual(g.sleeps, [], 'the crash came before the sleep');
  await g.clock.sleep(20_000);
  g.sleeps.length = 0;

  g.gh.fail(onPr({ status: 502 }));
  g.gh.fail(onPr({ status: 502 }));
  const result = await interpreter.runExecution({ ...g.options, record: mid });
  assert.equal(result.fault, true, 'the second failed retry spends the budget');
  assert.deepEqual(g.sleeps, [40_000, 120_000], 'the resumed retry waits only what is left of its deadline, then the doubled fallback');
  assert.equal(commentPosts(g).length, 3, 'the first try and two retries, across the crash');
  assert.equal(prReviewComments(g).length, 0);
  const final = await loadTicket(g);
  assert.equal(final.retries[REVIEW_COMMENT].remote.count, 2);
  assert.equal(final.state, 'fault');
  assert.ok(neededHuman(g));
});

test('auth and non-fast-forward failures are not retried', async (t) => {
  await t.test('an auth failure', async (t) => {
    const g = await reviewFlow(t, okReview);
    g.gh.fail(onPr({ status: 401, body: { message: 'Bad credentials' } }));
    const result = await interpreter.runExecution(g.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(commentPosts(g).length, 1, 'never retried');
    assert.deepEqual(g.sleeps, []);
    assert.equal(g.rec.retries[REVIEW_COMMENT].remote.count, 0, 'no retry is reserved');
    assert.match(g.rec.terminalStop.error, /HTTP 401/);
    assert.ok(neededHuman(g));
  });
  await t.test('a non-fast-forward push', async (t) => {
    const g = await golden.setup(t, { git: 'real' });
    // origin has the Ticket branch at a commit the worktree's branch does not contain.
    golden.sh(g.mainRoot, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    golden.sh(g.mainRoot, 'push', '-q', 'origin', `HEAD:refs/heads/${golden.BRANCH}`);
    const theirs = golden.sh(g.mainRoot, 'rev-parse', 'HEAD');
    const { push } = g.options.git;
    let pushes = 0;
    g.options.git = { ...g.options.git, push: (...args) => { pushes++; return push(...args); } };
    const result = await interpreter.runExecution(g.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(pushes, 1, 'never retried');
    assert.deepEqual(g.sleeps, []);
    assert.equal(g.rec.retries['implementer/1/green/4'].remote.count, 0, 'no retry is reserved');
    assert.match(g.rec.terminalStop.error, /non-fast-forward|rejected/);
    assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], theirs, 'nothing was forced');
    assert.ok(neededHuman(g));
  });
});

test('a human needs-human label during backoff abandons before the retry', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  g.clock.onSleep = () => { g.gh.labels.add('Gg:State:Needs-Human'); };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(g.gh.calls.filter((c) => golden.isCommentPost(c.args)).length, 1, 'the retry never ran and nothing else was posted');
  assert.equal(prReviewComments(g).length, 0);
  const final = await loadTicket(g);
  assert.equal(final.state, 'abandoned');
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'edit'), 'no label written: in-progress was not there to remove');
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

test('a retry that crashed as it launched needs a new retry to launch again', async (t) => {
  await t.test('within the budget', async (t) => {
    const g = await reviewFlow(t, okReview);
    g.gh.fail(onPr({ status: 502 }));
    const posts = crashPost(g, 2);
    await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
    assert.deepEqual((await loadTicket(g)).retries[REVIEW_COMMENT].remote.started, true, 'the first retry launched');

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'done', JSON.stringify(result));
    assert.equal(posts(), 3);
    assert.equal(prReviewComments(g).length, 1);
    assert.equal((await loadTicket(g)).retries[REVIEW_COMMENT].remote.count, 2, 'the relaunch spent the second retry');
  });
  await t.test('with the budget spent', async (t) => {
    const g = await reviewFlow(t, okReview);
    g.gh.fail(onPr({ status: 502 }));
    g.gh.fail(onPr({ status: 502 }));
    const posts = crashPost(g, 3);
    await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
    assert.equal((await loadTicket(g)).retries[REVIEW_COMMENT].remote.count, 2);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(posts(), 3, 'no fourth write');
    assert.equal(prReviewComments(g).length, 0);
    assert.equal((await loadTicket(g)).retries[REVIEW_COMMENT].remote.count, 2);
    assert.ok(neededHuman(g));
  });
});

test('a cooldown raised while a retry looks for its effect is waited out before the launch', async (t) => {
  const g = await reviewFlow(t, okReview);
  g.gh.fail(onPr({ status: 502 }));
  const runState = { stop: null, remoteNotBefore: 0 };
  const { prComments } = g.options.gh;
  let raised = false;
  // Another Ticket backs off while this retry's lookup is in flight.
  g.options.gh = { ...g.options.gh, prComments: async (...args) => {
    if (!raised) runState.remoteNotBefore = g.clock.now() + 10_000;
    raised = true;
    return prComments(...args);
  } };
  // A human sets needs-human during that second wait.
  g.clock.onSleep = (ms) => { if (ms === 10_000) g.gh.labels.add('gg:state:needs-human'); };
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.deepEqual(g.sleeps, [60_000, 10_000], 'the launch waits for the cooldown raised during its lookup');
  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(commentPosts(g).length, 1, 'nothing launched after the wait the human override ended');
});

test('a human needs-human label during a fault report backoff abandons the Execution', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  g.gh.fail({ matches: (args) => golden.isCommentPost(args, golden.TICKET), status: 502 });
  g.clock.onSleep = () => { g.gh.labels.add('gg:state:needs-human'); };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(g.gh.calls.filter((c) => golden.isCommentPost(c.args)).length, 1, 'the fault comment is not retried');
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'edit'), 'no label written: in-progress was not there to remove');
  const final = await loadTicket(g);
  assert.equal(final.state, 'abandoned');
  const ends = g.readEvents().filter((e) => e.type === 'ticket_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].outcome, 'abandoned');
});

test('a first launch that crashed spends the budget when launched again', async (t) => {
  const g = await reviewFlow(t, okReview);
  let posts = 0;
  // Every POST crashes as it launches, the first included, so each Run's lookup finds the comment absent.
  g.options.gh.setGh(async (args, cwd, input) => {
    if (golden.isCommentPost(args, PR) && ++posts) throw new interpreter.CrashError('crash as the POST launched');
    return g.gh.gh(args, cwd, input);
  });
  const outcomes = [];
  for (let run = 0; run < 4; run++) {
    const record = run ? { record: await loadTicket(g) } : {};
    const got = await interpreter.runExecution({ ...g.options, ...record }).then((r) => r, (err) => err);
    outcomes.push(got instanceof interpreter.CrashError ? 'crash' : got.fault ? 'fault' : JSON.stringify(got));
  }
  assert.deepEqual(outcomes, ['crash', 'crash', 'crash', 'fault'], 'the first launch and two relaunches, then none');
  assert.equal(posts, 3);
  assert.equal((await loadTicket(g)).retries[REVIEW_COMMENT].remote.count, 2);
});

test('a pending report waiting out a sibling cooldown checks the human override again before posting', async (t) => {
  const g = await golden.setup(t);
  const onTicket = { matches: (args) => golden.isCommentPost(args, golden.TICKET), status: 502 };
  for (let i = 0; i < 3; i++) g.gh.fail(onTicket);
  // The hold comment fails through its whole budget, so the hold stays pending for the next Run.
  const first = await interpreter.runExecution({ ...g.options,
    admission: { kind: 'hold', name: 'dirty-worktree', text: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.' } });
  assert.equal(first.fault, true, JSON.stringify(first));
  const mid = await loadTicket(g);
  assert.ok(interpreter.pendingReport(mid));
  const posted = g.gh.calls.filter((c) => golden.isCommentPost(c.args)).length;

  // Another Ticket of the next Run is backing off; a human sets needs-human during the wait.
  const runState = { stop: null, remoteNotBefore: g.clock.now() + 7_000 };
  g.sleeps.length = 0;
  g.clock.onSleep = () => { g.gh.labels.add('gg:state:needs-human'); };
  const result = await interpreter.runExecution({ ...g.options, record: mid, runState });

  assert.deepEqual(g.sleeps, [7_000]);
  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(g.gh.calls.filter((c) => golden.isCommentPost(c.args)).length, posted, 'the report is not posted');
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

test('a git write queued behind another holder of the repo lock checks the human override first', async (t) => {
  await t.test('a queued push', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => { g.gh.labels.add('gg:state:needs-human'); });
    // The green commit's write is the last before the push, whose lock attempt then waits.
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
    assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
  await t.test('a queued push whose commit origin already has', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => golden.sh(g.worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${golden.BRANCH}`));
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'done', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'the commit is on origin, so it is not pushed again');
    assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'));
  });
  await t.test('a queued commit', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => { g.gh.labels.add('gg:state:needs-human'); });
    // The green commit's tree is written; its commit is the next locked write.
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'writeTree' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the commit waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.commitStaged, 1, 'only the red commit was made');
    assert.deepEqual(golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean).length, 1);
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
});

test('a remote budget that runs out says so in the Terminal Reason', async (t) => {
  await t.test('a transient comment failure', async (t) => {
    const g = await reviewFlow(t, okReview);
    for (let i = 0; i < 3; i++) g.gh.fail(onPr({ status: 502 }));
    const result = await interpreter.runExecution(g.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    const text = 'A transient GitHub failure (HTTP 502) at review 3 persisted after 2 retries; the error is in this comment and on ticket_end.';
    assert.equal(g.rec.terminalReason.text, text);
    assert.ok(ticketComments(g).some((c) => c.body.includes(`**Terminal Reason:** ${text}`)), 'the comment carries it');
    assert.ok(g.logs.some((l) => /reviewer\/1\/review\/3: transient failure, retries exhausted after 2 of 2/.test(l)), g.logs.join('\n'));
  });
  await t.test('an auth failure keeps the unexpected-fault reason', async (t) => {
    const g = await reviewFlow(t, okReview);
    g.gh.fail(onPr({ status: 401, body: { message: 'Bad credentials' } }));
    await interpreter.runExecution(g.options);

    assert.equal(g.rec.terminalReason.text, 'An unexpected fault stopped the Execution at review 3; the error is in this comment and on ticket_end.');
    assert.ok(!g.logs.some((l) => /retries exhausted/.test(l)));
  });
});

test('a transient read inside a retry spends the budget and is never taken for absence', async (t) => {
  for (const [name, matches] of [
    ['the comment lookup', (args) => golden.isCommentRead(args, PR)],
    ['the label read', (args) => args[0] === 'issue' && args[1] === 'view'],
  ]) {
    await t.test(name, async (t) => {
      const g = await reviewFlow(t, okReview);
      g.gh.fail(onPr({ status: 502 }));
      // The retry's first read of `name` fails too; its next one works.
      g.gh.fail({ matches, status: 502 });
      const result = await interpreter.runExecution(g.options);

      assert.equal(result.outcome, 'done', JSON.stringify(result));
      assert.deepEqual(g.sleeps, [60_000, 120_000], 'the failed read spent the second retry');
      assert.equal(commentPosts(g).length, 2, 'the failed POST and one retry, launched only after a read that worked');
      assert.equal(prReviewComments(g).length, 1);
      assert.equal((await loadTicket(g)).retries[REVIEW_COMMENT].remote.count, 2);
    });
  }
});
