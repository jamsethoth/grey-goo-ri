import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as record from '../../lib/record.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { GREEN_FAIL_OUTPUT } from '../support/add-suite.ts';
import { actionEvent, attemptsOf, loadTicket, runStopEvent, subjects } from '../support/execution-reads.ts';
import { WRONG_ADD, greenFixture, greenWrites, stopReason, tddTrace } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { ticketComments } from '../support/review-flow.ts';
import * as suiteRuns from '../support/suite-runs.ts';

test('golden: an invalid structured response is retried once with a nudge then stops', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [keys.responseKey('green', 1, 'green', 1)]: {
        files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' },
        response: null,
      },
      [keys.responseKey('green', 1, 'green', 2)]: {
        files: {},
        response: { ...golden.greenResponse, claim: 'ok blocked' },
      },
    }),
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const green = attemptsOf(fixture, 'green', 'green');
  assert.deepEqual(
    green.map((event) => [event.attempt, event.rule.row]),
    [
      [1, 'parse-retry'],
      [2, 'parse-exhausted'],
    ],
  );
  assert.equal(green[1].outcome, 'harness-unparsed');
  assert.equal(fixture.harness.calls.length, 3);
  const [, first, nudge] = fixture.harness.calls;
  assert.equal(nudge!.resume, 'fake-session-2', 'the nudge resumes the green session');
  assert.ok(first!.brief!.startsWith('GREEN PHASE'));
  assert.ok(!nudge!.brief!.startsWith('GREEN PHASE'), 'attempt 2 gets the nudge, not the green Brief again');
  assert.match(nudge!.brief!, /structured result/i);
  assert.notEqual(nudge.marker, first.marker, 'the marker names the attempt');
  assert.equal(
    fixture.executionRecord.retries[keys.retryKey({ vertex: 'green', visit: 1, action: 'green', recovery: 0 })].parse,
    1,
  );
  assert.deepEqual(await subjects(fixture), ['test: Add two numbers (#15)'], 'no feat commit');
  stopReason(fixture, {
    vertex: 'green',
    action: 'green',
    recovery: 0,
    outcome: 'harness-unparsed',
    rule: { table: 'fixed', row: 'parse-exhausted' },
  });
});

test('a needs-replan reached with a rejected response is headed by its end, never the rejected claim', async (t) => {
  const claim = 'ok\n\n## Injected heading';
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [keys.responseKey('green', 1, 'green', 1)]: {
        files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' },
        response: null,
      },
      [keys.responseKey('green', 1, 'green', 2)]: { files: {}, response: { ...golden.greenResponse, claim } },
    }),
  });
  golden.configure(fixture, (configured) => {
    configured.flows.golden.ticket.vertices.green.route = { 'harness-unparsed': { end: 'needs-replan' } };
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-replan');
  const [posted, ...rest] = ticketComments(fixture);
  assert.equal(rest.length, 0);
  assert.match(posted.body, /^### gg: needs-replan\n/);
  assert.ok(!posted.body.includes('## Injected heading'), posted.body);
});

test('golden: a failing test Check is recovered once then fails with the Outcome failed', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [keys.responseKey('green', 1, 'green', 1)]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [keys.responseKey('green', 1, 'recover', 1)]: greenWrites({
        'lib/add.mjs': 'export const add = (a, b) => a - b;\n',
      }),
    },
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(fixture).map(golden.line((event) => `${event.vertex}/${event.action}/${event.recovery}`)), [
    'red/red/0',
    'red/red-check/0',
    'red/commit/0',
    'red ok -> green',
    'green/green/0',
    'green/test/0',
    'green/green/1',
    'green/test/1',
    'green failed -> needs-human',
  ]);
  assert.deepEqual(
    actionEvent(fixture, 'green', 'test')!.rule,
    { table: 'fixed', row: 'recover' },
    'the first failure recovers',
  );
  assert.ok(
    tddTrace(fixture)
      .filter(golden.isTracedAction)
      .every((event) => event.attempt === 1),
    'the recovery pass is its own Actions, not another Attempt',
  );
  const fix = fixture.harness.calls[2];
  assert.equal(fix.resume, 'fake-session-2', 'the recovery pass resumes the green session');
  assert.ok(fix!.brief!.includes(GREEN_FAIL_OUTPUT), 'the recovery pass gets the failing output');
  const exhausted = actionEvent(fixture, 'green', 'test', 1)!;
  assert.equal(exhausted.outcome, 'failed');
  assert.deepEqual(exhausted.rule, { table: 'failed', row: null });
  assert.deepEqual(
    Object.fromEntries(fixture.executionRecord.visits),
    { red: 1, green: 1 },
    'no Edge was traversed for the retry',
  );
  const reason = stopReason(fixture, {
    vertex: 'green',
    action: 'test',
    recovery: 1,
    outcome: 'failed',
    rule: { table: 'failed', row: null },
  });
  assert.equal(reason.text, 'The command Check green.test failed with no recovery left.');
  assert.equal(
    readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8'),
    'export const add = (a, b) => a - b;\n',
    'the last attempt stays for the human',
  );
});

test('a timed-out result gets one fresh attempt then needs-human', async (t) => {
  const red = golden.firstVisitResponses[keys.responseKey('red', 1, 'red', 1)];
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { ...red, result: { status: 'timed-out' } },
      [keys.responseKey('red', 1, 'red', 2)]: { ...red, result: { status: 'timed-out' } },
    },
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    attemptsOf(fixture, 'red', 'red').map((event) => [event.attempt, event.rule.row]),
    [
      [1, 'timeout-retry'],
      [2, 'timeout-exhausted'],
    ],
  );
  assert.equal(fixture.harness.calls.length, 2);
  assert.equal(fixture.harness.calls[1].resume, 'fake-session-1', 'the fresh Attempt resumes the session');
  assert.equal(
    fixture.executionRecord.retries[keys.retryKey({ vertex: 'red', visit: 1, action: 'red', recovery: 0 })].timeout,
    1,
  );
  const reason = stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    recovery: 0,
    outcome: 'harness-timeout',
    rule: { table: 'fixed', row: 'timeout-exhausted' },
  });
  assert.match(reason.text, /timed out/);
});

test('a transient failure is retried within budget honouring retryAfterMs', async (t) => {
  const failed = { files: {}, response: null, failure: { failureClass: 'transient', retryAfterMs: 5 } };
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: failed,
      [keys.responseKey('red', 1, 'red', 2)]: failed,
      [keys.responseKey('red', 1, 'red', 3)]: failed,
    },
  });
  const sleeps: number[] = [];
  const clock = fixture.options.deps.clock!;
  fixture.options.deps.clock = {
    ...clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      return clock.sleep(ms);
    },
  };
  const start = clock.now();
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    attemptsOf(fixture, 'red', 'red').map((event) => [event.attempt, event.rule.row]),
    [
      [1, 'transient-retry'],
      [2, 'transient-retry'],
      [3, 'transient-exhausted'],
    ],
  );
  assert.equal(fixture.harness.calls.length, 3);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(clock.now() - start, 10, 'the injected clock advanced by retryAfterMs each time');
  assert.equal(
    fixture.executionRecord.retries[keys.retryKey({ vertex: 'red', visit: 1, action: 'red', recovery: 0 })].transient,
    2,
  );
  const reason = stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    recovery: 0,
    outcome: 'harness-transient',
    rule: { table: 'fixed', row: 'transient-exhausted' },
  });
  assert.match(reason.text, /transient/);
});

test('an auth failure stops the run with its class', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'auth' } },
    },
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  assert.equal(fixture.harness.calls.length, 1, 'no retry');
  assert.equal(actionEvent(fixture, 'red', 'red')!.failureClass, 'auth');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  const reason = stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    recovery: 0,
    outcome: 'run-stop',
    rule: { table: 'fixed', row: 'run-stop' },
  });
  assert.match(reason.text, /auth/);
});

test('an auth failure keeps its run stop when the terminal comment fails', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'auth' } },
    },
  });
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    comment: async () => {
      throw new Error('gh comment down');
    },
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, true);
  assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
});

// What ticket_end keeps of the Terminal a fault interrupted.
type InterruptedEnd = NonNullable<record.TerminalStop['interrupted']>;
const terminalMarker = (fixture: golden.GoldenFixture, action: string) =>
  golden.markerOf(fixture.executionRecord, 'needs-human', 1, action);

test(
  'a fault interrupting a Terminal comment posts its own comment with the error and the interrupted Terminal ' +
    'Reason',
  async (t) => {
    const fixture = await golden.fixture(t, {
      responses: {
        [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'auth' } },
      },
    });
    const real = fixture.options.deps.gh.comment;
    let calls = 0;
    fixture.options.deps.gh = {
      ...fixture.options.deps.gh,
      comment: async (...args) => {
        if (calls++ === 0) throw new Error('gh comment down');
        return real(...args);
      },
    };
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(result.fault, true);
    assert.equal((runStopEvent(fixture) as events.ActionEvent | null)?.failureClass, 'auth');
    const [posted, ...rest] = ticketComments(fixture);
    assert.equal(rest.length, 0);
    assert.match(posted.body, /gh comment down/, 'the fault comment carries the error, as its Terminal Reason says');
    assert.match(
      posted.body,
      /\*\*Interrupted:\*\* the needs-human Terminal, whose Terminal Reason was: .*auth/,
      'the run stop reason survives its failed comment',
    );
    assert.ok(
      posted.body.includes(terminalMarker(fixture, 'fault-comment')),
      'the fault report has its own Action Marker',
    );
    const executionRecord = loadTicket(fixture);
    assert.deepEqual(
      writeAhead.openIntents(executionRecord).map((event) => event.actionMarker),
      [terminalMarker(fixture, 'end-comment')],
      'the intent of the interrupted comment stays open, and the fault report never replays it',
    );
    const end = fixture.readEvents().find((event) => event.type === 'ticket_end') as events.TicketEndEvent;
    assert.equal((end.interrupted as InterruptedEnd).terminal, 'needs-human');
    assert.match(
      (end.interrupted as InterruptedEnd).terminalReason.text,
      /auth/,
      'ticket_end keeps the interrupted Terminal Reason too',
    );
  },
);

test('a hold over an interrupted blocked terminal posts its own comment', async (t) => {
  const responses = firstVisitWith();
  responses[keys.responseKey('green', 1, 'green', 1)].response = {
    ...golden.greenResponse,
    claim: 'blocked',
    diagnosis: 'The ticket contradicts itself.',
  };
  const fixture = await golden.fixture(t, { responses });
  const blocked = terminalMarker(fixture, 'end-comment');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: blocked, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  assert.equal(ticketComments(fixture).length, 0);

  const result = await interpreter.runExecution({
    ...fixture.options,
    record: loadTicket(fixture),
    admission: {
      kind: 'hold',
      name: 'dirty-worktree',
      terminalReasonText: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.',
      advice: 'Commit, stash or remove these changes in the worktree.',
      detail: ' human.txt (untracked)\n',
    },
  });

  assert.equal(result.held, true, JSON.stringify(result));
  const [posted, ...rest] = ticketComments(fixture);
  assert.equal(rest.length, 0, 'only the hold is reported');
  assert.ok(posted.body.includes(terminalMarker(fixture, 'hold-comment')), 'the hold has its own Action Marker');
  assert.match(posted.body, /uncommitted changes gg did not make/);
  assert.match(posted.body, /Commit, stash or remove/);
  assert.match(posted.body, /human\.txt \(untracked\)/);
  assert.doesNotMatch(posted.body, /### gg: blocked|contradicts/, 'the interrupted blocked comment is not replayed');
  assert.ok(fixture.gh.labels.has('gg:state:needs-human'));
  const executionRecord = loadTicket(fixture);
  assert.equal(executionRecord.state, 'held');
  assert.deepEqual(
    writeAhead.openIntents(executionRecord).map((event) => event.actionMarker),
    [blocked],
    'the interrupted blocked intent stays open, untouched',
  );
  const end = fixture.readEvents().find((event) => event.type === 'ticket_end') as events.TicketEndEvent;
  assert.equal(end.terminalReason!.decidedBy.hold, 'dirty-worktree');
});

test('a crash inside the fault report replays its comment once on resume', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [keys.responseKey('red', 1, 'red', 1)]: { throw: new Error('harness exploded') } },
  });
  const actionMarker = terminalMarker(fixture, 'fault-comment');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const mid = loadTicket(fixture);
  const result = await interpreter.runExecution({ ...fixture.options, record: mid });

  assert.equal(result.fault, true);
  const posted = ticketComments(fixture);
  assert.equal(posted.length, 1, 'posted exactly once');
  assert.match(posted[0].body, /harness exploded/);
  assert.doesNotMatch(posted[0].body, /Interrupted/, 'a fault inside a Visit interrupted no Terminal');
  assert.equal(
    (fixture.readEvents().find((event) => event.type === 'ticket_end') as events.TicketEndEvent).interrupted,
    null,
  );
  // The faulted Attempt never completed, so its intent stays open on the finished record.
  assert.deepEqual(
    writeAhead.openIntents(loadTicket(fixture)).map((event) => event.effect),
    ['call'],
  );
});

test('a pending fault report keeps its run stop when its comment lookup fails on resume', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'auth' } },
    },
  });
  const real = fixture.options.deps.gh.comment;
  let calls = 0;
  const gh = {
    ...fixture.options.deps.gh,
    comment: async (...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error('gh comment down');
      return real(...args);
    },
  };
  // The run stop's comment fails, so a fault reports it, and the process dies after the fault comment landed.
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      deps: { ...fixture.options.deps, gh },
      crashAt: { marker: terminalMarker(fixture, 'fault-comment'), point: 'after-effect' },
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  const lookupDown = {
    ...fixture.options.deps.gh,
    comments: async () => {
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    },
  };

  const result = await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, gh: lookupDown },
    record: loadTicket(fixture),
  });
  assert.equal(result.fault, true);
  assert.equal(
    (runStopEvent(fixture) as events.ActionEvent | null)?.failureClass,
    'auth',
    'the run stop survives the failed recovery',
  );
  assert.equal(ticketComments(fixture).length, 1, 'no second comment');
  assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
});

test('an unknown failure goes to needs-human without retry', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [keys.responseKey('red', 1, 'red', 1)]: { files: {}, response: null, failure: { failureClass: 'unknown' } },
    },
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(runStopEvent(fixture), null);
  assert.equal(fixture.harness.calls.length, 1, 'no retry');
  assert.equal(attemptsOf(fixture, 'red', 'red').length, 1);
  const reason = stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    recovery: 0,
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'unknown-failure' },
  });
  assert.match(reason.text, /unknown/);
});

test('a rejecting harness is an unexpected fault', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [keys.responseKey('red', 1, 'red', 1)]: { throw: new Error('harness exploded') } },
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, true);
  assert.equal(fixture.harness.calls.length, 1, 'never retried');
  assert.equal(fixture.executionRecord.state, 'fault');
  assert.equal(loadTicket(fixture).state, 'fault', 'the record is marked on disk');
  const end = fixture.readEvents().at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-human');
  assert.match(end.error!, /harness exploded/);
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human'], 'the ticket goes to needs-human');
});

test('a fault whose terminal comment also fails is still recorded as a fault', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [keys.responseKey('red', 1, 'red', 1)]: { throw: new Error('harness exploded') } },
  });
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    comment: async () => {
      throw new Error('gh comment down');
    },
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, true);
  assert.equal(loadTicket(fixture).state, 'fault');
  const end = fixture.readEvents().at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.match(end.error!, /harness exploded/);
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human'], 'the label is still attempted');
});

test('a harness rejecting with an empty error is still a fault', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [keys.responseKey('red', 1, 'red', 1)]: { throw: new Error() } },
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, true);
  assert.equal(loadTicket(fixture).state, 'fault');
  const end = fixture.readEvents().at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.ok(end.error, 'ticket_end carries a non-empty error');
});

test('a CrashError propagates untouched', async (t) => {
  const crash = new interpreter.CrashError('injected crash');
  const fixture = await golden.fixture(t, { responses: { [keys.responseKey('red', 1, 'red', 1)]: { throw: crash } } });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err === crash);

  assert.equal(loadTicket(fixture).state, 'active');
  assert.ok(!fixture.gh.calls.some((call) => call.args[0] === 'issue'), 'no label change and no comment');
  assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
});

test('golden: blocked after a red recovery pass stops', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [keys.responseKey('red', 1, 'recover', 1)]: {
        files: {},
        response: { ...golden.redResponse, claim: 'blocked', diagnosis: 'The tests cannot fail first.' },
      },
    }),
  });
  suiteRuns.answerAll(fixture, () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }));
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 2);
  assert.equal(fixture.gh.comments.length, 1);
  assert.match(fixture.gh.comments[0].body, /### gg: blocked/);
  stopReason(fixture, {
    vertex: 'red',
    action: 'red-check',
    recovery: 1,
    outcome: 'blocked',
    rule: { table: 'stopped', row: null },
    comment: false,
  });
});

test('a persona edit between green and its recovery pass does not reach the recovery call', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [keys.responseKey('green', 1, 'green', 1)]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [keys.responseKey('green', 1, 'recover', 1)]: greenWrites({
        'lib/add.mjs': 'export const add = (a, b) => a + b;\n',
      }),
    },
  });
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const ran = await run(call);
    if (call.phase === 'green') fixture.files['implementer.md'] = golden.layerFile('# edited mid-visit\n');
    return ran;
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.equal(fixture.harness.calls.length, 3);
  assert.equal(
    fixture.harness.calls[2].personaBytes,
    golden.PERSONA,
    'the recovery call gets the bytes pinned at Visit entry',
  );
  assert.equal(fixture.harness.calls[2].personaHash, fixture.harness.calls[1].personaHash);
});
