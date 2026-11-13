import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import { actionMarker, attemptMarker, attemptsOf, loadTicket, writeAheadSteps } from '../support/execution-reads.ts';
import { FIRST_VISIT, tddTrace } from '../support/golden-run.ts';
import * as actionSignals from '../support/action-signals.ts';
import { MAJOR, fixed, review, reviewFixture, reviewed, ticketComments } from '../support/review-flow.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as firstVisit from '../support/first-visit.ts';
import * as keys from '../support/keys.ts';

const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const RED_RETRY = keys.responseKey('red', 1, 'red', 2);
const RED_RETRIES = keys.retryKey({ vertex: 'red', visit: 1, action: 'red', recovery: 0 });
const isCrash = (err: unknown) => err instanceof interpreter.CrashError;
// The error a run rejects with, or null when it resolves.
const rejectionOf = (execution: Promise<unknown>) =>
  execution.then(
    () => null,
    (err: Error) => err,
  );

test('a completed call is not rerun after a crash before the next action', async (t) => {
  await t.test('a red call', async (t) => {
    const fixture = await golden.fixture(t);
    await assert.rejects(
      interpreter.runExecution({
        ...fixture.options,
        crashAt: { marker: actionMarker(fixture, 'red', 'red'), point: 'after-completion' },
      }),
      isCrash,
    );
    const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });

    assert.equal(result.outcome, 'ready-for-qa');
    assert.equal(fixture.harness.calls.length, 2, 'red and green run once each');
    assert.deepEqual(tddTrace(fixture), FIRST_VISIT, 'one Action Event per Action');
  });
  await t.test('a review with a changes result', async (t) => {
    const fixture = await reviewFixture(t, {
      [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('changes', [MAJOR])),
      [keys.responseKey('implementer-fix', 1, 'fix', 1)]: fixed({
        'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n',
      }),
      [keys.responseKey('reviewer', 2, 'review', 1)]: reviewed(review('ok')),
    });
    const call = attemptMarker(fixture, 'reviewer', 1, 'review', 0);
    await assert.rejects(
      interpreter.runExecution({ ...fixture.options, crashAt: { marker: call, point: 'after-completion' } }),
      isCrash,
    );
    const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });

    assert.equal(result.outcome, 'ready-for-qa');
    assert.equal(
      fixture.harness.calls.filter((harnessCall) => harnessCall.marker === call).length,
      1,
      'the first review runs once',
    );
    const reviews = fixture
      .readEvents()
      .filter(
        (event): event is events.ActionEvent =>
          event.type === 'action' && event.vertex === 'reviewer' && event.visit === 1 && event.action === 'review',
      );
    assert.deepEqual(
      reviews.map((event) => event.outcome),
      ['changes'],
    );
    const final = loadTicket(fixture);
    const routed = 'the saved changes result routed to the fix';
    assert.equal(final.traversals.get('reviewer->implementer-fix:changes'), 1, routed);
    const visits = { red: 1, green: 1, reviewer: 2, 'implementer-fix': 1, publish: 1 };
    assert.deepEqual(Object.fromEntries(final.visits), visits);
  });
});

const agentEdits: [string, (local: string) => void][] = [
  ['with the file changed', (local) => writeFileSync(local, '{"agent":true}\n')],
  ['with a clean worktree', () => {}],
];
for (const [name, agentWrites] of agentEdits) {
  test(`an interrupted call that changed an ignored protected file is held: ${name}`, async (t) => {
    const fixture = await golden.fixture(t);
    mkdirSync(join(fixture.worktree, '.claude'), { recursive: true });
    writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
    const local = join(fixture.worktree, '.claude', 'settings.local.json');
    writeFileSync(local, '{"owner":true}\n');
    const run = fixture.harness.run;
    let crashed = false;
    fixture.harness.run = async (call) => {
      if (crashed) return run(call);
      crashed = true;
      agentWrites(local);
      throw new interpreter.CrashError('gg died during the call');
    };
    await assert.rejects(interpreter.runExecution(fixture.options), isCrash);
    const left = readFileSync(local, 'utf8');
    const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });

    assert.equal(result.held, true, JSON.stringify(result));
    assert.equal(fixture.harness.calls.length, 0, 'no agent runs again over the interrupted Attempt');
    assert.equal(readFileSync(local, 'utf8'), left, 'nothing is restored or discarded');
    const final = loadTicket(fixture);
    assert.equal(final.state, 'held');
    const red = actionMarker(fixture, 'red', 'red');
    assert.deepEqual(
      writeAhead.openIntents(final).map((entry) => [entry.effect, entry.actionMarker]),
      [['call', red]],
      'the Attempt intent stays open',
    );
    assert.ok(final.terminalReason!.text.includes(red), `the hold names the Attempt: ${final.terminalReason!.text}`);
    // Deleting the record drops the saved baseline, so the hold says to check the files the agent may have changed
    // first.
    const warning = /including ignored Protected Files\. Check them[^]*before deleting the record/;
    assert.match(ticketComments(fixture).at(-1)?.body ?? '', warning, 'the hold comment warns');
    assert.ok(
      fixture.logs.some((line) => warning.test(line)),
      `the hold log warns: ${JSON.stringify(fixture.logs)}`,
    );
  });
}

test('the repeat Check appends once per visit across a crash', async (t) => {
  const fixture = await reviewFixture(t, {
    [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('changes', [MAJOR])),
    [keys.responseKey('implementer-fix', 1, 'fix', 1)]: fixed({
      'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n',
    }),
    [keys.responseKey('reviewer', 2, 'review', 1)]: reviewed(review('ok')),
  });
  const appendEvent = fixture.options.events;
  let crashed = false;
  // gg dies as the repeat Check of the first review records its Event.
  const crashingEvents: typeof appendEvent = (type, data) => {
    const action = type === 'action' ? (data as events.EventInput<'action'>) : null;
    if (!crashed && action?.vertex === 'reviewer' && action.action === 'repeat') {
      crashed = true;
      throw new interpreter.CrashError('crash at the repeat Event');
    }
    return appendEvent(type, data);
  };
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, events: crashingEvents }),
    // The Event is appended in the save's transaction, so the crash surfaces as a failed save.
    (err: unknown) => err instanceof record.RecordSaveError && err.cause instanceof interpreter.CrashError,
  );
  const result = await interpreter.runExecution({
    ...fixture.options,
    events: crashingEvents,
    record: loadTicket(fixture),
  });

  assert.equal(result.outcome, 'ready-for-qa');
  const final = loadTicket(fixture);
  assert.deepEqual(
    final.outputs.filter((output) => output.action === 'repeat').map((output) => [output.vertex, output.visit]),
    [
      ['reviewer', 1],
      ['reviewer', 2],
    ],
    'one review entry per Visit',
  );
  const hashed = fixture
    .readEvents()
    .filter(
      (event): event is events.ActionEvent =>
        event.type === 'action' && event.vertex === 'reviewer' && event.visit === 1 && event.action === 'repeat',
    );
  assert.equal(hashed.length, 1);
  assert.equal(actionSignals.signalsOf(hashed[0]).checks[0].state, 'passed', 'the review is not its own repeat');
});

test('the terminal stop survives a crash before the first terminal action', async (t) => {
  const responses = firstVisit.firstVisitWith();
  responses[keys.responseKey('green', 1, 'green', 1)].response = {
    ...golden.greenResponse,
    claim: 'blocked',
    diagnosis: 'NOTES-7f3: the ticket contradicts itself.',
  };
  const fixture = await golden.fixture(t, { responses });
  // Every save carrying a Terminal stop fails, as if gg died once the Terminal cursor was saved.
  const restore = caseDatabase.failSaves(t, (_saved, next) => (next as record.ExecutionRecord).terminalStop != null);
  await assert.rejects(
    interpreter.runExecution(fixture.options),
    (err: unknown) => err instanceof record.RecordSaveError && (err.cause as Error).message === 'disk I/O error',
  );
  restore();
  assert.equal(ticketComments(fixture).length, 0);
  const result = await interpreter.runExecution({ ...fixture.options, record: loadTicket(fixture) });

  assert.equal(result.outcome, 'needs-human');
  const posted = ticketComments(fixture);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /### gg: blocked/);
  assert.ok(posted[0].body.includes('NOTES-7f3'), 'the blocked response is in the blocked comment');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 1);
});

test('attempt numbering continues after resume', async (t) => {
  const red = golden.firstVisitResponses[RED_CALL];
  const fixture = await golden.fixture(t, {
    responses: firstVisit.firstVisitWith({
      [RED_CALL]: { ...red, result: { status: 'timed-out' } },
      [RED_RETRY]: red,
    }),
  });
  let reads = 0;
  // The other worktrees are read once per Attempt before its baseline: gg dies after Attempt 1 retried, before
  // Attempt 2.
  const others = async () => {
    if (++reads === 2) throw new interpreter.CrashError('crash before attempt 2');
    return [];
  };
  await assert.rejects(interpreter.runExecution({ ...fixture.options, others }), isCrash);
  const result = await interpreter.runExecution({ ...fixture.options, others, record: loadTicket(fixture) });

  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(
    attemptsOf(fixture, 'red', 'red').map((event) => event.attempt),
    [1, 2],
    'no second Attempt 1',
  );
  assert.equal(fixture.harness.calls.length, 3, 'red twice, green once');
  assert.equal(
    fixture.harness.calls[1].marker,
    attemptMarker(fixture, 'red', 1, 'red', 0, 2),
    'the resume runs Attempt 2',
  );
  assert.equal(fixture.harness.calls[1].resume, 'fake-session-1', 'Attempt 2 resumes the session Attempt 1 saved');
  assert.deepEqual(loadTicket(fixture).retries[RED_RETRIES], { timeout: 1 }, 'one retry consumed');
});

test('a failed Event insert at an Action completion saves nothing more of that record', async (t) => {
  const fixture = await golden.fixture(t);
  caseDatabase.failAppends(t, (event) => event.type === 'action' && event.vertex === 'red' && event.action === 'red');
  const err = await rejectionOf(interpreter.runExecution(fixture.options));

  assert.equal(err?.name, 'RecordSaveError', String(err));
  const saved = loadTicket(fixture);
  assert.equal(saved.state, 'active', 'no fault is saved over the failed transition');
  assert.deepEqual(saved.sessions, {}, 'the call result rolled back with its Event');
  assert.deepEqual(writeAheadSteps(saved, actionMarker(fixture, 'red', 'red')), ['intent']);
  assert.ok(!fixture.readEvents().some((event) => event.type === 'action' || event.type === 'ticket_end'));
  assert.equal(fixture.gh.comments.length, 0);
});

test('a label update whose failure was saved before its completion is retried on resume', async (t) => {
  const fixture = await golden.fixture(t);
  const appendEvent = fixture.options.events;
  let crashed = false;
  // The ready-for-qa label does not land, and gg dies as that Action records its Event: { ok: false } is saved,
  // uncompleted.
  const crashingEvents: typeof appendEvent = (type, data) => {
    const action = type === 'action' ? (data as events.EventInput<'action'>) : null;
    if (!crashed && action?.vertex === 'ready-for-qa' && action.action === 'end-label') {
      crashed = true;
      throw new interpreter.CrashError('crash at the label Event');
    }
    return appendEvent(type, data);
  };
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      events: crashingEvents,
      deps: { ...fixture.options.deps, gh: { ...fixture.options.deps.gh, setLabels: async () => false } },
    }),
    (err: unknown) => err instanceof record.RecordSaveError && err.cause instanceof interpreter.CrashError,
  );
  const label = attemptMarker(fixture, 'ready-for-qa', 1, 'end-label', 0);
  const mid = loadTicket(fixture);
  assert.deepEqual(
    mid.writeAheadLog.filter((entry) => entry.actionMarker === label).map((entry) => [entry.step, entry.evidence]),
    [
      ['intent', null],
      ['evidence', { ok: false }],
    ],
  );
  assert.ok(!fixture.gh.labels.has('gg:state:ready-for-qa'));

  const result = await interpreter.runExecution({ ...fixture.options, events: crashingEvents, record: mid });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'), 'the failed label update is made on resume');
  assert.equal(writeAheadSteps(loadTicket(fixture), label).at(-1), 'complete');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 1);
});

test('a label update whose failure was saved with its completion is retried on resume', async (t) => {
  const fixture = await golden.fixture(t);
  const label = attemptMarker(fixture, 'ready-for-qa', 1, 'end-label', 0);
  // The ready-for-qa label does not land, and gg dies just after { ok: false } is saved with the completion.
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      crashAt: { marker: label, point: 'after-completion' },
      deps: { ...fixture.options.deps, gh: { ...fixture.options.deps.gh, setLabels: async () => false } },
    }),
    isCrash,
  );
  const mid = loadTicket(fixture);
  assert.deepEqual(writeAheadSteps(mid, label), ['intent', 'evidence', 'complete']);
  assert.ok(!fixture.gh.labels.has('gg:state:ready-for-qa'));

  const result = await interpreter.runExecution({ ...fixture.options, record: mid });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'), 'the failed label update is made on resume');
  const labelEvents = fixture
    .readEvents()
    .filter((event) => event.type === 'action' && event.vertex === 'ready-for-qa' && event.action === 'end-label');
  assert.equal(labelEvents.length, 1, 'the completed Action records no second Event');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 1);
});

// A Session cannot be resumed without its transcript, so Attempt 2 then starts fresh with the full Brief.
const transcripts: [string, (path: string) => void, string | null][] = [
  ['with its transcript', () => {}, 'fake-session-1'],
  ['without its transcript', (path) => rmSync(path), null],
];
for (const [name, dropTranscript, resume] of transcripts) {
  test(
    'a record saved before write-ahead Attempts resumes its retried call ' +
      `from the saved session and budget: ${name}`,
    async (t) => {
      const red = golden.firstVisitResponses[RED_CALL];
      const fixture = await golden.fixture(t, {
        responses: firstVisit.firstVisitWith({
          [RED_CALL]: { ...red, result: { status: 'timed-out' } },
          [RED_RETRY]: red,
        }),
      });
      let reads = 0;
      const others = async () => {
        if (++reads === 2) throw new interpreter.CrashError('crash before attempt 2');
        return [];
      };
      await assert.rejects(interpreter.runExecution({ ...fixture.options, others }), isCrash);
      // Reshaped as an earlier gg saved it: no call intents, evidence or settled results, and no heartbeat.
      const legacy = loadTicket(fixture);
      legacy.writeAheadLog = legacy.writeAheadLog.filter((entry) => entry.effect !== 'call');
      legacy.visitState!.settled = null;
      legacy.heartbeat = null;
      assert.equal(legacy.cursor.attempt, 2);
      assert.deepEqual(legacy.retries[RED_RETRIES], { timeout: 1 });
      record.save(legacy);
      dropTranscript(legacy.sessions[keys.sessionKey({ vertex: 'red', visit: 1, action: 'red' })].transcriptPath!);

      const result = await interpreter.runExecution({ ...fixture.options, others, record: loadTicket(fixture) });
      assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
      const call = fixture.harness.calls[1];
      assert.equal(call.marker, attemptMarker(fixture, 'red', 1, 'red', 0, 2), 'the resume runs Attempt 2');
      assert.equal(call.resume, resume, 'from the session the record saved, when it can be resumed');
      assert.ok(call.brief!.startsWith('RED PHASE'), 'with the full Brief');
      assert.deepEqual(loadTicket(fixture).retries[RED_RETRIES], { timeout: 1 }, 'the spent budget is kept');
    },
  );
}

const stops: [string, Record<string, unknown>, string][] = [
  ['fault', { fault: new Error('admission broke') }, 'fault'],
  [
    'abandonment',
    { admission: { kind: 'abandon', terminalReasonText: 'A human set needs-human.', inProgress: true } },
    'abandoned',
  ],
];
for (const [kind, stopOptions, state] of stops) {
  test(`a ${kind} whose ticket_end fails is not saved as finished`, async (t) => {
    const fixture = await golden.fixture(t);
    const restore = caseDatabase.failAppends(t, (event) => event.type === 'ticket_end');
    const err = await rejectionOf(interpreter.runExecution({ ...fixture.options, ...stopOptions }));
    assert.equal(err?.name, 'RecordSaveError', String(err));
    const mid = loadTicket(fixture);
    assert.equal(mid.state, 'active', 'no finished state without its ticket_end');
    assert.equal(interpreter.resumption(mid), 'finish-report', 'the decided report waits for the next Run');

    restore();
    await interpreter.runExecution({ ...fixture.options, record: mid });
    assert.equal(loadTicket(fixture).state, state);
    assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 1);
  });
}

// A ticket_end row of the Execution that fails the read's check: not JSON, or the JSON of another Execution.
const REFUSED_TICKET_ENDS: [string, string][] = [
  ['that is not JSON', '{'],
  [
    "holding another Execution's JSON",
    JSON.stringify({
      schemaVersion: 2,
      time: 't',
      type: 'ticket_end',
      ...{ run: 'run-1', execution: 'other', ticket: golden.TICKET, outcome: 'fault', diffStats: null },
      ...{ terminalReason: null, error: null, interrupted: null },
    }),
  ],
];
for (const [name, json] of REFUSED_TICKET_ENDS) {
  test(`a decided report beside a ticket_end row ${name} is still pending, and the next Run finishes it`, async (t) => {
    const fixture = await golden.fixture(t);
    const restore = caseDatabase.failAppends(t, (event) => event.type === 'ticket_end');
    await rejectionOf(interpreter.runExecution({ ...fixture.options, fault: new Error('admission broke') }));
    restore();
    const mid = loadTicket(fixture);
    stateDatabase
      .open(fixture.commonDir)
      .prepare(
        "INSERT INTO events (ts, type, run, execution, ticket, json) VALUES ('t', 'ticket_end', 'run-1', ?, ?, ?)",
      )
      .run(mid.execution, golden.TICKET, json);
    assert.equal(interpreter.resumption(mid), 'finish-report', 'a refused row is no ticket_end');

    await interpreter.runExecution({ ...fixture.options, record: mid });
    assert.equal(loadTicket(fixture).state, 'fault');
    assert.equal(fixture.gh.comments.length, 1, 'one fault comment');
    assert.ok(
      fixture.logs.some((line) => /run stop: skipped corrupt event \d+ \(ticket_end\)/.test(line)),
      fixture.logs.join('\n'),
    );
  });
}

// A fixture whose red call hangs until cancelled, and a promise that settles once that call has started.
async function hangingRed(t: TestContext) {
  const red = golden.firstVisitResponses[RED_CALL];
  const fixture = await golden.fixture(t, {
    responses: firstVisit.firstVisitWith({
      [RED_CALL]: { ...red, hang: true },
      [RED_RETRY]: red,
    }),
  });
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = fixture.harness.run;
  fixture.harness.run = (call) => {
    const result = run(call);
    if (call.attempt === 1) started();
    return result;
  };
  return { fixture, running };
}

test('the record carries the last heartbeat of a running call', async (t) => {
  const { fixture, running } = await hangingRed(t);
  const execution = interpreter.runExecution(fixture.options);
  try {
    await running;
    const first = loadTicket(fixture).heartbeat;
    assert.match(String(first), /^2026-10-15T/, 'the heartbeat is saved with the Attempt intent');
    await fixture.clock.sleep(60_000);
    fixture.clock.beat();
    const beating = loadTicket(fixture);
    assert.ok(Date.parse(beating.heartbeat!) > Date.parse(first!), 'updated while the call runs');
    assert.equal(beating.activity.busy, true, 'a heartbeat leaves the activity as it is');
  } finally {
    // Settled before the case ends either way, so no Execution outlives its temp repo.
    fixture.harness.cancel();
    await execution.catch(() => {});
  }
  assert.equal((await execution).outcome, 'ready-for-qa');
  assert.equal(loadTicket(fixture).heartbeat, null, 'cleared once the call ends');
});

// A heartbeat fires on a timer, where a throw would end the process, so its failed save fails the call instead.
test('a heartbeat that cannot be saved fails the call, not the timer', async (t) => {
  const { fixture, running } = await hangingRed(t);
  const execution = interpreter.runExecution(fixture.options);
  try {
    await running;
    await fixture.clock.sleep(60_000);
    const undo = caseDatabase.failSaves(t, () => true);
    assert.doesNotThrow(() => fixture.clock.beat(), 'the timer sees no throw');
    undo();
  } finally {
    // Settled before the case ends either way, so no Execution outlives its temp repo.
    fixture.harness.cancel();
    await execution.catch(() => {});
  }
  await assert.rejects(execution, (err: unknown) => err instanceof record.RecordSaveError);
});
