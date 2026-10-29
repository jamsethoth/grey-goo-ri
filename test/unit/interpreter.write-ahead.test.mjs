import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  FIRST_VISIT, steps, actionMarker, tddTrace, attemptsOf, review, reviewed, fixed, MAJOR, reviewFlow, ticketComments, loadTicket,
  attemptMarker,
} from '../support/interpreter.mjs';

test('a completed call is not rerun after a crash before the next action', async (t) => {
  await t.test('a red call', async (t) => {
    const g = await golden.setup(t);
    await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: actionMarker(g, 'red', 'red'), point: 'after-completion' } }),
      (err) => err instanceof interpreter.CrashError);
    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

    assert.equal(result.outcome, 'ready-for-qa');
    assert.equal(g.harness.calls.length, 2, 'red and green run once each');
    assert.deepEqual(tddTrace(g), FIRST_VISIT, 'one Action Event per Action');
  });
  await t.test('a review with a changes result', async (t) => {
    const g = await reviewFlow(t, {
      'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
      'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      'reviewer/2/review/1': reviewed(review('ok')),
    });
    const call = attemptMarker(g, 'reviewer', 1, 'review', 0);
    await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: call, point: 'after-completion' } }),
      (err) => err instanceof interpreter.CrashError);
    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

    assert.equal(result.outcome, 'ready-for-qa');
    assert.equal(g.harness.calls.filter((c) => c.marker === call).length, 1, 'the first review runs once');
    const events = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'reviewer' && e.visit === 1 && e.action === 'review');
    assert.deepEqual(events.map((e) => e.outcome), ['changes']);
    const final = await loadTicket(g);
    assert.equal(final.traversals['reviewer->implementer-fix:changes'], 1, 'the saved changes result routed to the fix');
    assert.deepEqual(final.visits, { red: 1, green: 1, reviewer: 2, 'implementer-fix': 1, publish: 1 });
  });
});

for (const [name, agentWrites] of [
  ['with the file changed', (local) => writeFileSync(local, '{"agent":true}\n')],
  ['with a clean worktree', () => {}],
]) {
  test(`an interrupted call that changed an ignored protected file is held: ${name}`, async (t) => {
    const g = await golden.setup(t);
    mkdirSync(join(g.worktree, '.claude'), { recursive: true });
    writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
    const local = join(g.worktree, '.claude', 'settings.local.json');
    writeFileSync(local, '{"owner":true}\n');
    const run = g.harness.run;
    let crashed = false;
    g.harness.run = async (call) => {
      if (crashed) return run(call);
      crashed = true;
      agentWrites(local);
      throw new interpreter.CrashError('gg died during the call');
    };
    await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
    const left = readFileSync(local, 'utf8');
    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

    assert.equal(result.held, true, JSON.stringify(result));
    assert.equal(g.harness.calls.length, 0, 'no agent runs again over the interrupted Attempt');
    assert.equal(readFileSync(local, 'utf8'), left, 'nothing is restored or discarded');
    const final = await loadTicket(g);
    assert.equal(final.state, 'held');
    const red = actionMarker(g, 'red', 'red');
    assert.deepEqual(record.openIntents(final).map((e) => [e.action, e.marker]), [['call', red]], 'the Attempt intent stays open');
    assert.ok(final.terminalReason.text.includes(red), `the hold names the Attempt: ${final.terminalReason.text}`);
    // Deleting the record drops the saved baseline, so the hold says to check the files the agent may have changed first.
    const warning = /including ignored Protected Files\. Check them[^]*before deleting the record/;
    assert.match(ticketComments(g).at(-1)?.body ?? '', warning, 'the hold comment warns');
    assert.ok(g.logs.some((l) => warning.test(l)), `the hold log warns: ${JSON.stringify(g.logs)}`);
  });
}

test('findings-hash appends once per visit across a crash', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  const ev = g.options.events;
  let crashed = false;
  // gg dies as the findings-hash Action of the first review records its Event.
  const events = (type, data) => {
    if (!crashed && type === 'action' && data.vertex === 'reviewer' && data.action === 'repeat') {
      crashed = true;
      throw new interpreter.CrashError('crash at the findings-hash Event');
    }
    return ev(type, data);
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, events }));
  const result = await interpreter.runExecution({ ...g.options, events, record: await loadTicket(g) });

  assert.equal(result.outcome, 'ready-for-qa');
  const final = await loadTicket(g);
  assert.deepEqual(final.outputs.filter((o) => o.action === 'repeat').map((o) => [o.vertex, o.visit]), [['reviewer', 1], ['reviewer', 2]], 'one review entry per Visit');
  const hashed = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'reviewer' && e.visit === 1 && e.action === 'repeat');
  assert.equal(hashed.length, 1);
  assert.notEqual(hashed[0].repeat, true, 'the review is not its own repeat');
});

test('the terminal stop survives a crash before the first terminal action', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', diagnosis: 'NOTES-7f3: the ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  // Every save carrying a Terminal stop fails, as if gg died once the Terminal cursor was saved.
  const restore = golden.failSaves(t, (saved, next) => next.terminalStop !== undefined);
  await assert.rejects(interpreter.runExecution(g.options));
  restore();
  assert.equal(ticketComments(g).length, 0);
  const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

  assert.equal(result.outcome, 'needs-human');
  const posted = ticketComments(g);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /### gg: blocked/);
  assert.ok(posted[0].body.includes('NOTES-7f3'), 'the blocked response is in the blocked comment');
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

test('attempt numbering continues after resume', async (t) => {
  const red = golden.firstVisitResponses['red/1/red/1'];
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'red/1/red/1': { ...red, result: { status: 'timed-out' } }, 'red/1/red/2': red } });
  let reads = 0;
  // The other worktrees are read once per Attempt before its baseline: gg dies after Attempt 1 retried, before Attempt 2.
  const others = async () => {
    if (++reads === 2) throw new interpreter.CrashError('crash before attempt 2');
    return [];
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, others }), (err) => err instanceof interpreter.CrashError);
  const result = await interpreter.runExecution({ ...g.options, others, record: await loadTicket(g) });

  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(attemptsOf(g, 'red', 'red').map((e) => e.attempt), [1, 2], 'no second Attempt 1');
  assert.equal(g.harness.calls.length, 3, 'red twice, green once');
  assert.equal(g.harness.calls[1].marker, attemptMarker(g, 'red', 1, 'red', 0, 2), 'the resume runs Attempt 2');
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'Attempt 2 resumes the session Attempt 1 saved');
  assert.deepEqual((await loadTicket(g)).retries['red/1/red/0'], { timeout: 1 }, 'one retry consumed');
});

test('a failed Event insert at an Action completion saves nothing more of that record', async (t) => {
  const g = await golden.setup(t);
  golden.failAppends(t, (event) => event.type === 'action' && event.vertex === 'red' && event.action === 'red');
  const err = await interpreter.runExecution(g.options).then(() => null, (e) => e);

  assert.equal(err?.name, 'RecordSaveError', String(err));
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved over the failed transition');
  assert.deepEqual(saved.sessions, {}, 'the call result rolled back with its Event');
  assert.deepEqual(steps(saved, actionMarker(g, 'red', 'red')), ['intent']);
  assert.ok(!g.readEvents().some((e) => e.type === 'action' || e.type === 'ticket_end'));
  assert.equal(g.gh.comments.length, 0);
});

test('a label update whose failure was saved before its completion is retried on resume', async (t) => {
  const g = await golden.setup(t);
  const ev = g.options.events;
  let crashed = false;
  // The ready-for-qa label does not land, and gg dies as that Action records its Event: { ok: false } is saved, uncompleted.
  const events = (type, data) => {
    if (!crashed && type === 'action' && data.vertex === 'ready-for-qa' && data.action === 'end-label') {
      crashed = true;
      throw new interpreter.CrashError('crash at the label Event');
    }
    return ev(type, data);
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, events, gh: { ...g.options.gh, setLabels: async () => false } }));
  const label = attemptMarker(g, 'ready-for-qa', 1, 'end-label', 0);
  const mid = await loadTicket(g);
  assert.deepEqual(mid.log.filter((e) => e.marker === label).map((e) => [e.step, e.evidence]), [['intent', undefined], ['evidence', { ok: false }]]);
  assert.ok(!g.gh.labels.has('gg:state:ready-for-qa'));

  const result = await interpreter.runExecution({ ...g.options, events, record: mid });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.ok(g.gh.labels.has('gg:state:ready-for-qa'), 'the failed label update is made on resume');
  assert.equal(steps(await loadTicket(g), label).at(-1), 'complete');
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

// A Session cannot be resumed without its transcript, so Attempt 2 then starts fresh with the full Brief.
for (const [name, dropTranscript, resume] of [
  ['with its transcript', () => {}, 'fake-session-1'],
  ['without its transcript', (path) => rmSync(path), null],
]) {
  test(`a record saved before write-ahead Attempts resumes its retried call from the saved session and budget: ${name}`, async (t) => {
    const red = golden.firstVisitResponses['red/1/red/1'];
    const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
      'red/1/red/1': { ...red, result: { status: 'timed-out' } }, 'red/1/red/2': red } });
    let reads = 0;
    const others = async () => {
      if (++reads === 2) throw new interpreter.CrashError('crash before attempt 2');
      return [];
    };
    await assert.rejects(interpreter.runExecution({ ...g.options, others }), (err) => err instanceof interpreter.CrashError);
    // Reshaped as an earlier gg saved it: no call intents, evidence or settled results, and no heartbeat.
    const legacy = await loadTicket(g);
    legacy.log = legacy.log.filter((e) => e.action !== 'call');
    delete legacy.visitState.settled;
    delete legacy.heartbeat;
    assert.equal(legacy.cursor.attempt, 2);
    assert.deepEqual(legacy.retries['red/1/red/0'], { timeout: 1 });
    await record.save(legacy);
    dropTranscript(legacy.sessions['red/1/red'].transcriptPath);

    const result = await interpreter.runExecution({ ...g.options, others, record: await loadTicket(g) });
    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    const call = g.harness.calls[1];
    assert.equal(call.marker, attemptMarker(g, 'red', 1, 'red', 0, 2), 'the resume runs Attempt 2');
    assert.equal(call.resume, resume, 'from the session the record saved, when it can be resumed');
    assert.ok(call.brief.startsWith('RED PHASE'), 'with the full Brief');
    assert.deepEqual((await loadTicket(g)).retries['red/1/red/0'], { timeout: 1 }, 'the spent budget is kept');
  });
}

for (const [kind, opts, state] of [
  ['fault', { fault: new Error('admission broke') }, 'fault'],
  ['abandonment', { admission: { kind: 'abandon', reason: 'A human set needs-human.', inProgress: true } }, 'abandoned'],
]) {
  test(`a ${kind} whose ticket_end fails is not saved as finished`, async (t) => {
    const g = await golden.setup(t);
    const restore = golden.failAppends(t, (event) => event.type === 'ticket_end');
    const err = await interpreter.runExecution({ ...g.options, ...opts }).then(() => null, (e) => e);
    assert.equal(err?.name, 'RecordSaveError', String(err));
    const mid = await loadTicket(g);
    assert.equal(mid.state, 'active', 'no finished state without its ticket_end');
    assert.ok(interpreter.pendingReport(mid), 'the decided report waits for the next Run');

    restore();
    await interpreter.runExecution({ ...g.options, record: mid });
    assert.equal((await loadTicket(g)).state, state);
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

test('the record carries the last heartbeat of a running call', async (t) => {
  const red = golden.firstVisitResponses['red/1/red/1'];
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'red/1/red/1': { ...red, hang: true }, 'red/1/red/2': red } });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const run = g.harness.run;
  g.harness.run = (call) => {
    const out = run(call);
    if (call.attempt === 1) started();
    return out;
  };
  const execution = interpreter.runExecution(g.options);
  try {
    await running;
    const first = (await loadTicket(g)).heartbeat;
    assert.match(String(first), /^2026-10-15T/, 'the heartbeat is saved with the Attempt intent');
    await g.clock.sleep(60_000);
    g.clock.beat();
    const beating = await loadTicket(g);
    assert.ok(Date.parse(beating.heartbeat) > Date.parse(first), 'updated while the call runs');
    assert.equal(beating.activity.busy, true, 'a heartbeat leaves the activity as it is');
  } finally {
    // Settled before the case ends either way, so no Execution outlives its temp repo.
    g.harness.cancel();
    await execution.catch(() => {});
  }
  assert.equal((await execution).outcome, 'ready-for-qa');
  assert.equal((await loadTicket(g)).heartbeat, null, 'cleared once the call ends');
});
