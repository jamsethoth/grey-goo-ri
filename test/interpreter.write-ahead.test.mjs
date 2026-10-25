import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';
import {
  FIRST_VISIT, intents, steps, actionMarker, tddTrace, attemptsOf, review, reviewed, fixed, MAJOR, reviewFlow,
  ticketComments, loadTicket, ticketRow, attemptMarker,
} from './support/interpreter.mjs';

// A wait for state a timer writes: there is no barrier to await on a heartbeat save. A save that never comes fails at
// the case timeout.
async function until(check) {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('a completed call is not rerun after a crash before the next action', async (t) => {
  await t.test('a red call', async (t) => {
    const g = await golden.setup(t);
    await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: actionMarker(g, 'red', 1), point: 'after-completion' } }),
      (err) => err instanceof interpreter.CrashError);
    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

    assert.equal(result.outcome, 'done');
    assert.equal(g.harness.calls.length, 2, 'red and green run once each');
    assert.deepEqual(tddTrace(g), FIRST_VISIT, 'one Action Event per Action');
  });
  await t.test('a review with a changes result', async (t) => {
    const g = await reviewFlow(t, {
      'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
      'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      'reviewer/2/review/1': reviewed(review('ok')),
    });
    const call = attemptMarker(g, 'reviewer', 1, 'review', 1);
    await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: call, point: 'after-completion' } }),
      (err) => err instanceof interpreter.CrashError);
    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });

    assert.equal(result.outcome, 'done');
    assert.equal(g.harness.calls.filter((c) => c.marker === call).length, 1, 'the first review runs once');
    const events = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'reviewer' && e.visit === 1 && e.phase === 'review' && e.ordinal === 1);
    assert.deepEqual(events.map((e) => e.outcome), ['changes']);
    const final = await loadTicket(g);
    assert.equal(final.traversals['reviewer->implementer-fix:changes'], 1, 'the saved changes result routed to the fix');
    assert.deepEqual(final.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
  });
});

test('an interrupted call that changed an ignored protected file is held', async (t) => {
  for (const changed of [true, false]) {
    await t.test(changed ? 'with the file changed' : 'with a clean worktree', async (t) => {
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
        if (changed) writeFileSync(local, '{"agent":true}\n');
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
      const red = actionMarker(g, 'red', 1);
      assert.deepEqual(record.openIntents(final).map((e) => [e.action, e.marker]), [['call', red]], 'the Attempt intent stays open');
      assert.ok(final.terminalReason.text.includes(red), `the hold names the Attempt: ${final.terminalReason.text}`);
      // Deleting the record drops the saved baseline, so the hold says to check the files the agent may have changed first.
      const warning = /ignored Protected Files such as \.claude\/settings\.local\.json[^]*before deleting the record/;
      assert.match(ticketComments(g).at(-1)?.body ?? '', warning, 'the hold comment warns');
      assert.ok(g.logs.some((l) => warning.test(l)), `the hold log warns: ${JSON.stringify(g.logs)}`);
    });
  }
});

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
    if (!crashed && type === 'action' && data.vertex === 'reviewer' && data.phase === 'review' && data.ordinal === 2) {
      crashed = true;
      throw new interpreter.CrashError('crash at the findings-hash Event');
    }
    return ev(type, data);
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, events }));
  const result = await interpreter.runExecution({ ...g.options, events, record: await loadTicket(g) });

  assert.equal(result.outcome, 'done');
  const final = await loadTicket(g);
  assert.deepEqual(final.outputs.reviews.map((r) => [r.vertex, r.visit]), [['reviewer', 1], ['reviewer', 2]], 'one review entry per Visit');
  const hashed = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'reviewer' && e.visit === 1 && e.phase === 'review' && e.ordinal === 2);
  assert.equal(hashed.length, 1);
  assert.notEqual(hashed[0].repeat, true, 'the review is not its own repeat');
});

test('the terminal stop survives a crash before the first terminal action', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', notes: 'NOTES-7f3: the ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  const db = record.openDb(g.commonDir);
  // Every save carrying a Terminal stop fails, as if gg died once the Terminal cursor was saved.
  db.exec(`CREATE TRIGGER fail_stop BEFORE UPDATE ON records WHEN NEW.json LIKE '%"terminalStop"%'
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  await assert.rejects(interpreter.runExecution(g.options));
  db.exec('DROP TRIGGER fail_stop');
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
  const red = golden.firstVisitResponses['implementer/1/red/1'];
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/red/1': { ...red, result: { status: 'timed-out' } }, 'implementer/1/red/2': red } });
  let reads = 0;
  // The other worktrees are read once per Attempt before its baseline: gg dies after Attempt 1 retried, before Attempt 2.
  const others = async () => {
    if (++reads === 2) throw new interpreter.CrashError('crash before attempt 2');
    return [];
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, others }), (err) => err instanceof interpreter.CrashError);
  const result = await interpreter.runExecution({ ...g.options, others, record: await loadTicket(g) });

  assert.equal(result.outcome, 'done');
  assert.deepEqual(attemptsOf(g, 'red', 1).map((e) => e.attempt), [1, 2], 'no second Attempt 1');
  assert.equal(g.harness.calls.length, 3, 'red twice, green once');
  assert.equal(g.harness.calls[1].marker, attemptMarker(g, 'implementer', 1, 'red', 1, 2), 'the resume runs Attempt 2');
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'Attempt 2 resumes the session Attempt 1 saved');
  assert.deepEqual((await loadTicket(g)).retries['implementer/1/red/1'], { timeout: 1 }, 'one retry consumed');
});

test('the record carries the last heartbeat of a running call', { timeout: 120_000 }, async (t) => {
  const red = golden.firstVisitResponses['implementer/1/red/1'];
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/red/1': { ...red, hang: true }, 'implementer/1/red/2': red } });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const run = g.harness.run;
  g.harness.run = (call) => {
    const out = run(call);
    if (call.attempt === 1) started();
    return out;
  };
  const execution = interpreter.runExecution({ ...g.options, heartbeatMs: 5 });
  try {
    await running;
    const first = ticketRow(g).heartbeat;
    assert.match(String(first), /^2026-10-15T/, 'the heartbeat is saved with the Attempt intent');
    await g.options.clock.sleep(60_000);
    await until(() => ticketRow(g).heartbeat !== first);
    assert.ok(Date.parse(ticketRow(g).heartbeat) > Date.parse(first), 'updated while the call runs');
    assert.equal(ticketRow(g).activity.busy, true, 'a heartbeat leaves the activity as it is');
  } finally {
    // Settled before the case ends either way, so no Execution outlives its temp repo.
    g.harness.cancel();
    await execution.catch(() => {});
  }
  assert.equal((await execution).outcome, 'done');
  assert.equal(ticketRow(g).heartbeat, null, 'cleared once the call ends');
});

test('a completed call with an integrity violation still rolls back under its own marker', async (t) => {
  const g = await golden.setup(t);
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    golden.sh(g.worktree, 'add', '-A');
    golden.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.deepEqual(steps(g.rec, actionMarker(g, 'red', 1)), ['intent', 'evidence', 'complete']);
  const [reset] = intents(g.rec, 'reset');
  // After the red Phase's three declared ordinals, keeping the Attempt.
  assert.equal(reset.marker, actionMarker(g, 'red', 4));
  assert.deepEqual(steps(g.rec, reset.marker), ['intent', 'evidence', 'complete']);
});

test('a failed Event insert at an Action completion saves nothing more of that record', async (t) => {
  const g = await golden.setup(t);
  record.openDb(g.commonDir).exec(`CREATE TRIGGER fail_red BEFORE INSERT ON events
    WHEN NEW.type = 'action' AND json_extract(NEW.json, '$.phase') = 'red' AND json_extract(NEW.json, '$.ordinal') = 1
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  const err = await interpreter.runExecution(g.options).then(() => null, (e) => e);

  assert.equal(err?.name, 'RecordSaveError', String(err));
  const saved = await loadTicket(g);
  assert.equal(saved.state, 'active', 'no fault is saved over the failed transition');
  assert.deepEqual(saved.sessions, {}, 'the call result rolled back with its Event');
  assert.deepEqual(steps(saved, actionMarker(g, 'red', 1)), ['intent']);
  assert.ok(!g.readEvents().some((e) => e.type === 'action' || e.type === 'ticket_end'));
  assert.equal(g.gh.comments.length, 0);
});

test('a label update whose failure was saved before its completion is retried on resume', async (t) => {
  const g = await golden.setup(t);
  const ev = g.options.events;
  let crashed = false;
  // The done label does not land, and gg dies as that Action records its Event: { ok: false } is saved, uncompleted.
  const events = (type, data) => {
    if (!crashed && type === 'action' && data.vertex === 'done' && data.ordinal === 3) {
      crashed = true;
      throw new interpreter.CrashError('crash at the label Event');
    }
    return ev(type, data);
  };
  await assert.rejects(interpreter.runExecution({ ...g.options, events, gh: { ...g.options.gh, setLabels: async () => false } }));
  const label = attemptMarker(g, 'done', 1, 'done', 3);
  const mid = await loadTicket(g);
  assert.deepEqual(mid.log.filter((e) => e.marker === label).map((e) => [e.step, e.evidence]), [['intent', undefined], ['evidence', { ok: false }]]);
  assert.ok(!g.gh.labels.has('gg:state:ready-for-qa'));

  const result = await interpreter.runExecution({ ...g.options, events, record: mid });
  assert.equal(result.outcome, 'done');
  assert.ok(g.gh.labels.has('gg:state:ready-for-qa'), 'the failed label update is made on resume');
  assert.equal(steps(await loadTicket(g), label).at(-1), 'complete');
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

test('a record saved before write-ahead Attempts resumes its retried call from the saved session and budget', async (t) => {
  for (const transcript of [true, false]) {
    await t.test(transcript ? 'with its transcript' : 'without its transcript', async (t) => {
      const red = golden.firstVisitResponses['implementer/1/red/1'];
      const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
        'implementer/1/red/1': { ...red, result: { status: 'timed-out' } }, 'implementer/1/red/2': red } });
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
      assert.deepEqual(legacy.retries['implementer/1/red/1'], { timeout: 1 });
      await record.save(legacy);
      if (!transcript) rmSync(legacy.sessions['implementer/1/red'].transcriptPath);

      const result = await interpreter.runExecution({ ...g.options, others, record: await loadTicket(g) });
      assert.equal(result.outcome, 'done', JSON.stringify(result));
      const call = g.harness.calls[1];
      assert.equal(call.marker, attemptMarker(g, 'implementer', 1, 'red', 1, 2), 'the resume runs Attempt 2');
      // A Session cannot be resumed without its transcript, so Attempt 2 then starts fresh with the full Brief.
      assert.equal(call.resume, transcript ? 'fake-session-1' : null, 'from the session the record saved, when it can be resumed');
      assert.ok(call.brief.startsWith('RED PHASE'), 'with the full Brief');
      assert.deepEqual((await loadTicket(g)).retries['implementer/1/red/1'], { timeout: 1 }, 'the spent budget is kept');
    });
  }
});

test('a fault or abandonment whose ticket_end fails is not saved as finished', async (t) => {
  for (const [kind, opts, state] of [
    ['fault', { fault: new Error('admission broke') }, 'fault'],
    ['abandonment', { admission: { kind: 'abandon', reason: 'A human set needs-human.', inProgress: true } }, 'abandoned'],
  ]) {
    await t.test(kind, async (t) => {
      const g = await golden.setup(t);
      const db = record.openDb(g.commonDir);
      db.exec("CREATE TRIGGER fail_end BEFORE INSERT ON events WHEN NEW.type = 'ticket_end' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
      const err = await interpreter.runExecution({ ...g.options, ...opts }).then(() => null, (e) => e);
      assert.equal(err?.name, 'RecordSaveError', String(err));
      const mid = await loadTicket(g);
      assert.equal(mid.state, 'active', 'no finished state without its ticket_end');
      assert.ok(interpreter.pendingReport(mid), 'the decided report waits for the next Run');

      db.exec('DROP TRIGGER fail_end');
      await interpreter.runExecution({ ...g.options, record: mid });
      assert.equal((await loadTicket(g)).state, state);
      assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
    });
  }
});
