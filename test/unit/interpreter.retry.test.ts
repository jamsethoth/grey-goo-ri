import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as sideEffect from '../../lib/effects/side-effect.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as golden from '../support/golden.ts';
import {
  actionEvent,
  attemptMarker,
  intents,
  loadTicket,
  originSha,
  runStopEvent,
  writeAheadSteps,
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
import * as fakeGhModule from '../support/fake-gh.ts';
import * as keys from '../support/keys.ts';

test('a transient comment failure is retried once and posts one comment', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const posts = commentPosts(fixture);
  assert.equal(posts.length, 2, 'the failed POST and one retry');
  assert.equal(posts[1].input, posts[0].input, 'the retry sends the recorded payload');
  const between = fixture.gh.calls.slice(fixture.gh.calls.indexOf(posts[0]) + 1, fixture.gh.calls.indexOf(posts[1]));
  assert.ok(
    between.some((call) => fakeGhModule.isCommentRead(call.args, PR)),
    'the marker lookup runs before the retry',
  );
  const actionMarker = attemptMarker(fixture, 'reviewer', 1, 'comment', 0);
  const [posted, ...more] = prReviewComments(fixture);
  assert.equal(more.length, 0, 'exactly one review comment');
  assert.ok(posted.body.includes(marker.markerComment(actionMarker)), 'it carries the original Action Marker');
  assert.deepEqual(fixture.sleeps, [60_000], 'with no Retry-After the retry waits the 60 s fallback');
  const final = loadTicket(fixture);
  assert.deepEqual(writeAheadSteps(final, actionMarker), ['intent', 'evidence', 'complete']);
  assert.equal(final.retries[REVIEW_COMMENT].remote!.count, 1);
  assert.equal(
    fixture.readEvents().filter((event) => event.type === 'action' && keys.retryKey(event) === REVIEW_COMMENT).length,
    1,
    'one Action Event for the retried Action',
  );
});

test('retry-after is honoured on the fake clock', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(
    onPr({
      status: 403,
      headers: { 'Retry-After': '7' },
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
    }),
  );
  let seen = null as { now: number; calls: number; saved: unknown } | null;
  fixture.clock.onSleep = async () => {
    seen ??= {
      now: fixture.clock.now(),
      calls: fixture.gh.calls.length,
      saved: loadTicket(fixture).retries[REVIEW_COMMENT]?.remote,
    };
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [7_000]);
  assert.deepEqual(
    seen?.saved,
    { count: 1, failureClass: 'rate-limited', nextEligibleAt: (seen?.now as number) + 7_000, started: false },
    'the retry is saved before the sleep',
  );
  assert.equal(
    seen!.calls,
    fixture.gh.calls.indexOf(commentPosts(fixture)[0]) + 1,
    'neither the lookup nor the effect runs before the sleep',
  );
  assert.equal(commentPosts(fixture).length, 2);
  assert.equal(prReviewComments(fixture).length, 1);
});

test('an accepted write whose call errored is found by marker, not reposted', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502, afterEffect: true }));
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.equal(commentPosts(fixture).length, 1, 'never posted again');
  const [posted, ...more] = prReviewComments(fixture);
  assert.equal(more.length, 0);
  const actionMarker = attemptMarker(fixture, 'reviewer', 1, 'comment', 0);
  const final = loadTicket(fixture);
  assert.deepEqual(writeAheadSteps(final, actionMarker), ['intent', 'evidence', 'complete']);
  assert.deepEqual(
    final.writeAheadLog.find((event) => event.actionMarker === actionMarker && event.step === 'evidence')!.evidence,
    { id: posted.id },
    'the found comment is the evidence',
  );
});

test('the retry budget survives a crash', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  const actionMarker = attemptMarker(fixture, 'reviewer', 1, 'comment', 0);
  fixture.gh.fail(onPr({ status: 502 }));
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const mid = loadTicket(fixture);
  assert.equal(mid.retries[REVIEW_COMMENT]?.remote?.count, 1, 'the first retry was saved before the crash');
  assert.deepEqual(fixture.sleeps, [], 'the crash came before the sleep');
  await fixture.clock.sleep(20_000);
  fixture.sleeps.length = 0;

  fixture.gh.fail(onPr({ status: 502 }));
  fixture.gh.fail(onPr({ status: 502 }));
  const result = await interpreter.runExecution({ ...fixture.options, record: mid });
  assert.equal(result.fault, true, 'the second failed retry spends the budget');
  assert.deepEqual(
    fixture.sleeps,
    [40_000, 120_000],
    'the resumed retry waits only what is left of its deadline, then the doubled fallback',
  );
  assert.equal(commentPosts(fixture).length, 3, 'the first try and two retries, across the crash');
  assert.equal(prReviewComments(fixture).length, 0);
  const final = loadTicket(fixture);
  assert.equal(final.retries[REVIEW_COMMENT].remote!.count, 2);
  assert.equal(final.state, 'fault');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
});

test('auth and non-fast-forward failures are not retried', async (t) => {
  await t.test('an auth failure', async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 401, body: { message: 'Bad credentials' } }));
    const result = await interpreter.runExecution(fixture.options);

    assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth', JSON.stringify(result));
    assert.equal(commentPosts(fixture).length, 1, 'never retried');
    assert.deepEqual(fixture.sleeps, []);
    assert.equal(fixture.executionRecord.retries[REVIEW_COMMENT].remote!.count, 0, 'no retry is reserved');
    assert.match(fixture.executionRecord.terminalStop!.detail!, /HTTP 401/, 'the run stop carries the error');
    assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  });
  await t.test('a non-fast-forward push', async (t) => {
    const fixture = await golden.fixture(t);
    // origin has the Ticket branch at a commit the worktree's branch does not contain.
    const theirs = fixture.fakeGit!.commit(fixture.mainRoot, 'someone else');
    const { push } = fixture.options.deps.git;
    await push(fixture.mainRoot, golden.BRANCH, theirs);
    let pushes = 0;
    fixture.options.deps.git = {
      ...fixture.options.deps.git,
      push: (...args) => {
        pushes++;
        return push(...args);
      },
    };
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(pushes, 1, 'never retried');
    assert.deepEqual(fixture.sleeps, []);
    assert.equal(
      fixture.executionRecord.retries[keys.retryKey({ vertex: 'green', visit: 1, action: 'push', recovery: 0 })].remote!
        .count,
      0,
      'no retry is reserved',
    );
    assert.match(fixture.executionRecord.terminalStop!.error!, /non-fast-forward|rejected/);
    assert.equal(await originSha(fixture), theirs, 'nothing was forced');
    assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  });
});

test('a human needs-human label during backoff abandons before the retry', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  fixture.clock.onSleep = () => {
    fixture.gh.labels.add('Gg:State:Needs-Human');
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(
    fixture.gh.calls.filter((call) => fakeGhModule.isCommentPost(call.args)).length,
    1,
    'the retry never ran and nothing else was posted',
  );
  assert.equal(prReviewComments(fixture).length, 0);
  const final = loadTicket(fixture);
  assert.equal(final.state, 'abandoned');
  assert.ok(
    !fixture.gh.calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'edit'),
    'no label written: in-progress was not there to remove',
  );
  const ends = fixture.readEvents().filter((event) => event.type === 'ticket_end');
  assert.equal(ends.length, 1);
  // The abandonment names the Visit and the Action its backoff cut off (#341).
  assert.deepEqual((ends[0] as events.TicketEndEvent).terminalReason?.decidedBy, {
    label: 'gg:state:needs-human',
    vertex: 'reviewer',
    visit: 1,
    action: 'comment',
    recovery: 0,
  });
});

test('a retry that crashed as it launched needs a new retry to launch again', async (t) => {
  await t.test('within the budget', async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 502 }));
    const posts = crashPost(fixture, 2);
    await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
    assert.deepEqual(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.started, true, 'the first retry launched');

    const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });
    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    assert.equal(posts(), 3);
    assert.equal(prReviewComments(fixture).length, 1);
    assert.equal(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.count, 2, 'the relaunch spent the second retry');
  });
  await t.test('with the budget spent', async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 502 }));
    fixture.gh.fail(onPr({ status: 502 }));
    const posts = crashPost(fixture, 3);
    await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
    assert.equal(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.count, 2);

    const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });
    assert.equal(result.fault, true, JSON.stringify(result));
    assert.equal(posts(), 3, 'no fourth write');
    assert.equal(prReviewComments(fixture).length, 0);
    assert.equal(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.count, 2);
    assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
    // Its failure Event names the class its retries were spent on, as its Terminal Reason does (#251).
    assert.equal(actionEvent(fixture, 'reviewer', 'comment')?.failureClass, 'transient');
  });
});

test('a cooldown raised while a retry looks for its effect is waited out before the launch', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  fixture.gh.fail(onPr({ status: 502 }));
  const runState = sideEffect.createRunState();
  const { comments } = fixture.options.deps.gh;
  let raised = false;
  // Another Ticket backs off while this retry's lookup is in flight.
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    comments: async (...args) => {
      if (!raised) runState.remoteNotBefore = fixture.clock.now() + 10_000;
      raised = true;
      return comments(...args);
    },
  };
  // A human sets needs-human during that second wait.
  fixture.clock.onSleep = (ms) => {
    if (ms === 10_000) fixture.gh.labels.add('gg:state:needs-human');
  };
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.deepEqual(fixture.sleeps, [60_000, 10_000], 'the launch waits for the cooldown raised during its lookup');
  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(commentPosts(fixture).length, 1, 'nothing launched after the wait the human override ended');
});

test('a human needs-human label during a fault report backoff abandons the Execution', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey({ vertex: 'red', visit: 1, action: 'red' })]: { throw: new Error('harness exploded') },
    },
  });
  fixture.gh.fail({ matches: (args: string[]) => fakeGhModule.isCommentPost(args, golden.TICKET), status: 502 });
  fixture.clock.onSleep = () => {
    fixture.gh.labels.add('gg:state:needs-human');
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(
    fixture.gh.calls.filter((call) => fakeGhModule.isCommentPost(call.args)).length,
    1,
    'the fault comment is not retried',
  );
  assert.ok(
    !fixture.gh.calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'edit'),
    'no label written: in-progress was not there to remove',
  );
  const final = loadTicket(fixture);
  assert.equal(final.state, 'abandoned');
  const ends = fixture.readEvents().filter((event) => event.type === 'ticket_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].outcome, 'abandoned');
});

test('a first launch that crashed spends the budget when launched again', async (t) => {
  const fixture = await reviewFixture(t, okReview);
  let posts = 0;
  // Every POST crashes as it launches, the first included, so each Run's lookup finds the comment absent.
  fixture.options.deps.gh = github.createGh(async (args, cwd, input) => {
    if (fakeGhModule.isCommentPost(args, PR) && ++posts) throw new interpreter.CrashError('crash as the POST launched');
    return fixture.gh.gh(args, cwd, input);
  });
  const crashed = (err: unknown) => err instanceof interpreter.CrashError;
  await assert.rejects(interpreter.runExecution(fixture.options), crashed, 'the first launch');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) }),
    crashed,
    'the first relaunch',
  );
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) }),
    crashed,
    'the second relaunch',
  );
  const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });
  assert.equal(result.fault, true, `then none: ${JSON.stringify(result)}`);
  assert.equal(posts, 3);
  assert.equal(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.count, 2);
});

test('a pending report waiting out a sibling cooldown checks the human override again before posting', async (t) => {
  const fixture = await golden.fixture(t);
  const onTicket = { matches: (args: string[]) => fakeGhModule.isCommentPost(args, golden.TICKET), status: 502 };
  fixture.gh.fail(onTicket);
  fixture.gh.fail(onTicket);
  fixture.gh.fail(onTicket);
  // The hold comment fails through its whole budget, so the hold stays pending for the next Run.
  const first = await interpreter.runExecution({
    ...fixture.options,
    admission: {
      kind: 'hold',
      name: 'dirty-worktree',
      terminalReasonText:
        'The worktree has uncommitted changes the Execution Record does not account for, so the Ticket is held.',
    },
  });
  assert.equal(first.fault, true, JSON.stringify(first));
  const mid = loadTicket(fixture);
  assert.equal(interpreter.resumption(mid, stateDatabase), 'finish-report');
  const posted = fixture.gh.calls.filter((call) => fakeGhModule.isCommentPost(call.args)).length;

  // Another Ticket of the next Run is backing off; a human sets needs-human during the wait.
  const runState = { ...sideEffect.createRunState(), remoteNotBefore: fixture.clock.now() + 7_000 };
  fixture.sleeps.length = 0;
  fixture.clock.onSleep = () => {
    fixture.gh.labels.add('gg:state:needs-human');
  };
  const result = await interpreter.runExecution({ ...fixture.options, record: mid, runState });

  assert.deepEqual(fixture.sleeps, [7_000]);
  assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
  assert.equal(
    fixture.gh.calls.filter((call) => fakeGhModule.isCommentPost(call.args)).length,
    posted,
    'the report is not posted',
  );
  assert.equal(loadTicket(fixture).state, 'abandoned');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 1);
});

test('a remote budget that runs out says so in the Terminal Reason', async (t) => {
  await t.test('a transient comment failure', async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 502 }));
    fixture.gh.fail(onPr({ status: 502 }));
    fixture.gh.fail(onPr({ status: 502 }));
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(result.fault, true, JSON.stringify(result));
    const text =
      'A transient GitHub failure (HTTP 502) at comment persisted after 2 retries; ' +
      'the error is in this comment and on ticket_end.';
    assert.equal(fixture.executionRecord.terminalReason!.text, text);
    assert.ok(
      ticketComments(fixture).some((comment) => comment.body.includes(`**Terminal Reason:** ${text}`)),
      'the comment carries it',
    );
    assert.ok(
      fixture.logs.some((line) =>
        /reviewer\/1\/comment\/0: transient failure, retries exhausted after 2 of 2/.test(line),
      ),
      fixture.logs.join('\n'),
    );
    // The Action that ran out of retries records its failure Event (#251).
    const failed = actionEvent(fixture, 'reviewer', 'comment');
    assert.deepEqual(
      [failed?.outcome, failed?.rule, failed?.failureClass],
      ['fault', { table: 'fixed', row: 'fault' }, 'transient'],
    );
    assert.match(failed!.error!, /502/);
  });
  await t.test('an auth failure stops the run, naming the comment', async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 401, body: { message: 'Bad credentials' } }));
    const result = await interpreter.runExecution(fixture.options);

    assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth', JSON.stringify(result));
    assert.equal(
      fixture.executionRecord.terminalReason!.text,
      'The comment at comment failed with class auth, which stops the whole run.',
    );
    assert.ok(!fixture.logs.some((line) => /retries exhausted/.test(line)));
  });
});

for (const [name, matches] of [
  ['the comment lookup', (args: string[]) => fakeGhModule.isCommentRead(args, PR)],
  ['the label read', (args: string[]) => args[0] === 'issue' && args[1] === 'view'],
] as [string, (args: string[]) => boolean][]) {
  test(`a transient read inside a retry spends the budget and is never taken for absence: ${name}`, async (t) => {
    const fixture = await reviewFixture(t, okReview);
    fixture.gh.fail(onPr({ status: 502 }));
    // The retry's first read fails too; its next one works.
    fixture.gh.fail({ matches, status: 502 });
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    assert.deepEqual(fixture.sleeps, [60_000, 120_000], 'the failed read spent the second retry');
    assert.equal(
      commentPosts(fixture).length,
      2,
      'the failed POST and one retry, launched only after a read that worked',
    );
    assert.equal(prReviewComments(fixture).length, 1);
    assert.equal(loadTicket(fixture).retries[REVIEW_COMMENT].remote!.count, 2);
  });
}

// An escapee of red's first call (#532, ADR 0030 decision 4): the call reports `job`, as the fake does, then the
// watcher's first sight of a process outside gg's job reports `none`. Once that report returns, the escapee is adopted
// and each `later` report follows; when it throws, the escapee is ended and the call taken down, as a Harness must (Q2
// A). `dies` is gg killed once the call has returned. The case wraps the fake's run, with no scripting key (Q4 A).
function escapingRed(
  fixture: golden.GoldenFixture,
  { later = [], dies = false, rejects = false }: { later?: string[]; dies?: boolean; rejects?: boolean } = {},
) {
  const seen: string[] = [];
  const run = fixture.harness.run;
  fixture.harness.run = async (call, hooks) => {
    const answer = run(call, hooks);
    if (call.vertex !== 'red' || call.attempt !== 1) return answer;
    try {
      hooks!.started({ kind: 'none' });
    } catch {
      seen.push('ended');
      fixture.harness.cancel();
      if (!rejects) return answer;
      await answer;
      throw new Error('the Harness rejected after it ended the call');
    }
    seen.push('adopted');
    for (const kind of later) hooks!.started({ kind });
    if (!dies) return answer;
    await answer;
    throw new interpreter.CrashError(`gg was killed during ${call.marker as string}`);
  };
  return seen;
}

// red answers its first call and, should a resume retry it, its second.
const redCall = (attempt: number) => keys.responseKey({ vertex: 'red', visit: 1, action: 'red', attempt });
const escapingFixture = (t: TestContext) =>
  golden.fixture(t, {
    responses: { ...golden.firstVisitResponses, [redCall(2)]: golden.firstVisitResponses[redCall(1)]! },
  });
const redFirst = (fixture: golden.GoldenFixture) => attemptMarker(fixture, 'red', 1, 'red', 0, 1);

// The containment red's first call intent holds, in a record about to be saved or as saved.
const containmentIn = (executionRecord: record.ExecutionRecord, actionMarker: string) =>
  (
    intents(executionRecord, 'call').find((entry) => entry.actionMarker === actionMarker)?.payload as
      { containment?: { kind: string } } | undefined
  )?.containment?.kind ?? null;
const savedContainment = (fixture: golden.GoldenFixture) => containmentIn(loadTicket(fixture), redFirst(fixture));

const crashed = (err: unknown) => err instanceof interpreter.CrashError;

// The next Run rescues red's Interrupted Attempt and holds it: one of its processes may still write (N1, L6).
async function assertRescuedAndHeld(fixture: golden.GoldenFixture) {
  const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });
  assert.equal(result.held, true, JSON.stringify(result));
  const saved = loadTicket(fixture);
  assert.equal(intents(saved, 'rescue').length, 1, 'the work is rescued');
  assert.deepEqual(intents(saved, 'reset'), [], 'and not reset');
  assert.match(saved.terminalReason?.text ?? '', /nothing was reset/);
  assert.equal(fixture.harness.calls.filter((call) => call.marker?.includes(':red:')).length, 1, 'nothing was retried');
}

test('a crash after the none save commits holds the Interrupted Attempt', async (t) => {
  const fixture = await escapingFixture(t);
  const seen = escapingRed(fixture);
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: redFirst(fixture), point: 'after-none-saved' } }),
    crashed,
  );
  assert.equal(seen.includes('adopted'), false, 'gg died before it adopted the escapee');
  assert.equal(savedContainment(fixture), 'none', 'the none save committed');
  await assertRescuedAndHeld(fixture);
});

// The save comes first (ADR 0005), so gg dying inside it leaves the escapee as the watcher found it: ADR 0030 decision
// 8's residual risk. A save cut off is a RecordSaveError, whose cause is the crash.
test('a none save that is interrupted stops the Run before the escapee is adopted or ended', async (t) => {
  const fixture = await escapingFixture(t);
  const seen = escapingRed(fixture);
  let atCrash: string[] | null = null;
  caseDatabase.onSave(t, (next) => {
    if (atCrash || !('execution' in next) || containmentIn(next, redFirst(fixture)) !== 'none') return;
    atCrash = [...seen];
    throw new interpreter.CrashError('gg was killed during the none save');
  });
  await assert.rejects(
    interpreter.runExecution(fixture.options),
    (err) => err instanceof record.RecordSaveError && err.cause instanceof interpreter.CrashError,
  );
  assert.deepEqual(atCrash, [], 'neither adopted nor ended while the save ran');
  assert.equal(savedContainment(fixture), 'job', 'the call stays job');
});

// The one fatal error after which gg performs an effect (ADR 0030 decision 2): the escapee ends first.
test('a none save that fails ends the escapee, then stops the Run', async (t) => {
  for (const rejects of [false, true])
    await t.test(rejects ? 'the Harness rejects after it' : 'the Harness resolves', (t) => noneSaveFails(t, rejects));
});

// The save's error outranks the Harness's own rejection, which would hide it.
async function noneSaveFails(t: TestContext, rejects: boolean) {
  const fixture = await escapingFixture(t);
  const seen = escapingRed(fixture, { rejects });
  let failed = false;
  caseDatabase.failSaves(t, (_saved, next) => {
    if (failed || !('execution' in next) || containmentIn(next, redFirst(fixture)) !== 'none') return false;
    return (failed = true);
  });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof record.RecordSaveError);
  assert.deepEqual(seen, ['ended'], 'the escapee was ended, never adopted');
  const saved = loadTicket(fixture);
  assert.deepEqual(writeAheadSteps(saved, redFirst(fixture)), ['intent'], "the call's result is never saved");
  assert.equal(savedContainment(fixture), 'job');
  assert.equal(actionEvent(fixture, 'red', 'red'), undefined, 'nor its Action Event');
}

// A failed save is fatal (effect-errors): once one of red's call fails, the heartbeat's or a started report's, no save
// of the record is tried again, an escapee found after it is ended, and the Run stops on that first error.
test('after a save during a call fails, no save of the record is tried again', async (t) => {
  const cases = [
    ["the job report's save fails, then the take-down finds an escapee", 'job', ['none'], ['ended']],
    ["the job report's save fails, then a heartbeat", 'job', ['beat'], []],
    ["a heartbeat's save fails, then an escapee", 'beat', ['beat', 'none'], ['ended']],
    [
      "an escapee, then a heartbeat's save fails, then a second escapee",
      'beat',
      ['none', 'beat', 'none'],
      ['adopted', 'ended'],
    ],
  ] as const;
  for (const [name, failing, next, fates] of cases)
    await t.test(name, async (t) => {
      const fixture = await escapingFixture(t);
      const seen: string[] = [];
      let first: unknown = null;
      let beating = false;
      let triedAfter = 0;
      caseDatabase.onSave(t, (saved) => {
        if (!('execution' in saved)) return;
        if (first) return void triedAfter++;
        if (failing === 'beat' ? !beating : containmentIn(saved, redFirst(fixture)) !== 'job') return;
        throw (first = new Error('disk I/O error'));
      });
      const run = fixture.harness.run;
      fixture.harness.run = async (call, hooks) => {
        const answer = run(call, hooks);
        if (call.vertex !== 'red' || call.attempt !== 1) return answer;
        answer.catch(() => {});
        for (const step of next) {
          if (step === 'beat') {
            beating = true;
            fixture.clock.beat();
            beating = false;
          } else
            try {
              hooks!.started({ kind: 'none' });
              seen.push('adopted');
            } catch {
              seen.push('ended');
            }
        }
        fixture.harness.cancel();
        return answer;
      };
      await assert.rejects(
        interpreter.runExecution(fixture.options),
        (err) => err instanceof record.RecordSaveError && err.cause === first,
      );
      assert.equal(triedAfter, 0, 'no save is tried after the failed one');
      assert.deepEqual(seen, fates, 'an escapee after the failed save is ended, never adopted');
    });
});

// Every `started` report after a `none` leaves it `none` and saves nothing (ADR 0030 decision 4): the stop path's late
// `job`, after the take-down's last poll, and a second escapee's `none`.
test('an Interrupted Attempt whose call had an escapee gg adopted is rescued and held, not reset', async (t) => {
  for (const [name, later] of [
    ["a late job report from the call's stop", 'job'],
    ["a second escapee's none", 'none'],
  ] as const)
    await t.test(name, async (t) => {
      const fixture = await escapingFixture(t);
      const seen = escapingRed(fixture, { later: [later], dies: true });
      let laterSaves = 0;
      caseDatabase.onSave(t, () => {
        if (seen.includes('adopted')) laterSaves++;
      });
      await assert.rejects(interpreter.runExecution(fixture.options), crashed);
      assert.equal(savedContainment(fixture), 'none', "the escapee's none stays");
      assert.equal(laterSaves, 0, 'a report after none saves nothing');
      await assertRescuedAndHeld(fixture);
    });
});
