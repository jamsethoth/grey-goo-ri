import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  tddTrace, actionEvent, WRONG_ADD, GREEN_FAIL_OUTPUT, attemptsOf, ticketComments, ok, greenSetup, stopReason, subjects,
} from '../support/interpreter.mjs';

test('golden: an invalid structured response is retried once with a nudge then stops', async (t) => {
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'green/1/green/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: null },
    'green/1/green/2': { files: {}, response: { ...golden.greenResponse, claim: 'ok blocked' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const green = attemptsOf(g, 'green', 'green');
  assert.deepEqual(green.map((e) => [e.attempt, e.rule.row]), [[1, 'parse-retry'], [2, 'parse-exhausted']]);
  assert.equal(green[1].outcome, 'harness-unparsed');
  assert.equal(g.harness.calls.length, 3);
  const [, first, nudge] = g.harness.calls;
  assert.equal(nudge.resume, 'fake-session-2', 'the nudge resumes the green session');
  assert.ok(first.brief.startsWith('GREEN PHASE'));
  assert.ok(!nudge.brief.startsWith('GREEN PHASE'), 'attempt 2 gets the nudge, not the green Brief again');
  assert.match(nudge.brief, /structured result/i);
  assert.notEqual(nudge.marker, first.marker, 'the marker names the attempt');
  assert.equal(g.rec.retries['green/1/green/0'].parse, 1);
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)'], 'no feat commit');
  stopReason(g, { vertex: 'green', action: 'green', recovery: 0, outcome: 'harness-unparsed', rule: { table: 'fixed', row: 'parse-exhausted' } });
});

test('a needs-replan reached with a rejected response is headed by its end, never the rejected claim', async (t) => {
  const claim = 'ok\n\n## Injected heading';
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'green/1/green/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: null },
    'green/1/green/2': { files: {}, response: { ...golden.greenResponse, claim } },
  } });
  golden.configure(g, (c) => { c.flows.golden.ticket.vertices.green.route = { 'harness-unparsed': { end: 'needs-replan' } }; });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-replan');
  const [posted, ...rest] = ticketComments(g);
  assert.equal(rest.length, 0);
  assert.match(posted.body, /^### gg: needs-replan\n/);
  assert.ok(!posted.body.includes('## Injected heading'), posted.body);
});

test('golden: a failing test Check is recovered once then fails with the Outcome failed', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' }),
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.vertex}/${e.action}/${e.recovery}`),
    ['red/red/0', 'red/red-check/0', 'red/commit/0', 'green/green/0', 'green/test/0', 'green/green/1', 'green/test/1']);
  assert.deepEqual(actionEvent(g, 'green', 'test').rule, { table: 'fixed', row: 'recover' }, 'the first failure recovers');
  assert.ok(tddTrace(g).every((e) => e.attempt === 1), 'the recovery pass is its own Actions, not another Attempt');
  const fix = g.harness.calls[2];
  assert.equal(fix.resume, 'fake-session-2', 'the recovery pass resumes the green session');
  assert.ok(fix.brief.includes(GREEN_FAIL_OUTPUT), 'the recovery pass gets the failing output');
  const exhausted = actionEvent(g, 'green', 'test', 1);
  assert.equal(exhausted.outcome, 'failed');
  assert.deepEqual(exhausted.rule, { table: 'failed', row: null });
  assert.deepEqual(g.rec.visits, { red: 1, green: 1 }, 'no Edge was traversed for the retry');
  const reason = stopReason(g, { vertex: 'green', action: 'test', recovery: 1, outcome: 'failed', rule: { table: 'failed', row: null } });
  assert.equal(reason.text, 'The command Check test failed with no recovery left.');
  assert.equal(readFileSync(join(g.worktree, 'lib', 'add.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n', 'the last attempt stays for the human');
});

test('a timed-out result gets one fresh attempt then needs-human', async (t) => {
  const red = golden.firstVisitResponses['red/1/red/1'];
  const g = await golden.setup(t, { responses: {
    'red/1/red/1': { ...red, result: { status: 'timed-out' } },
    'red/1/red/2': { ...red, result: { status: 'timed-out' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 'red').map((e) => [e.attempt, e.rule.row]), [[1, 'timeout-retry'], [2, 'timeout-exhausted']]);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'the fresh Attempt resumes the session');
  assert.equal(g.rec.retries['red/1/red/0'].timeout, 1);
  const reason = stopReason(g, { vertex: 'red', action: 'red', recovery: 0, outcome: 'harness-timeout', rule: { table: 'fixed', row: 'timeout-exhausted' } });
  assert.match(reason.text, /timed out/);
});

test('a transient failure is retried within budget honouring retryAfterMs', async (t) => {
  const failed = { files: {}, response: null, failure: { class: 'transient', retryAfterMs: 5 } };
  const g = await golden.setup(t, { responses: {
    'red/1/red/1': failed, 'red/1/red/2': failed, 'red/1/red/3': failed,
  } });
  const sleeps = [];
  const { clock } = g.options;
  g.options.clock = { ...clock, sleep: async (ms) => { sleeps.push(ms); return clock.sleep(ms); } };
  const start = clock.now();
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 'red').map((e) => [e.attempt, e.rule.row]),
    [[1, 'transient-retry'], [2, 'transient-retry'], [3, 'transient-exhausted']]);
  assert.equal(g.harness.calls.length, 3);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(clock.now() - start, 10, 'the injected clock advanced by retryAfterMs each time');
  assert.equal(g.rec.retries['red/1/red/0'].transient, 2);
  const reason = stopReason(g, { vertex: 'red', action: 'red', recovery: 0, outcome: 'harness-transient', rule: { table: 'fixed', row: 'transient-exhausted' } });
  assert.match(reason.text, /transient/);
});

test('an auth failure stops the run with its class', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(actionEvent(g, 'red', 'red').failureClass, 'auth');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
  const reason = stopReason(g, { vertex: 'red', action: 'red', recovery: 0, outcome: 'run-stop', rule: { table: 'fixed', row: 'run-stop' } });
  assert.match(reason.text, /auth/);
});

test('an auth failure keeps its run stop when the terminal comment fails', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human']);
});

const terminalMarker = (g, action) => golden.markerOf(g.rec, 'needs-human', 1, action);

test('a fault interrupting a Terminal comment posts its own comment with the error and the interrupted Terminal Reason', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const real = g.options.gh.commentIssue;
  let calls = 0;
  g.options.gh = { ...g.options.gh, commentIssue: async (...a) => { if (calls++ === 0) throw new Error('gh comment down'); return real(...a); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth');
  const [posted, ...rest] = ticketComments(g);
  assert.equal(rest.length, 0);
  assert.match(posted.body, /gh comment down/, 'the fault comment carries the error, as its Terminal Reason says');
  assert.match(posted.body, /\*\*Interrupted:\*\* the needs-human Terminal, whose Terminal Reason was: .*auth/,
    'the run stop reason survives its failed comment');
  assert.ok(posted.body.includes(terminalMarker(g, 'fault-comment')), 'the fault report has its own Action Marker');
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(record.openIntents(rec).map((e) => e.marker), [terminalMarker(g, 'end-comment')],
    'the intent of the interrupted comment stays open, and the fault report never replays it');
  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.interrupted.terminal, 'needs-human');
  assert.match(end.interrupted.reason.text, /auth/, 'ticket_end keeps the interrupted Terminal Reason too');
});

test('a hold over an interrupted blocked terminal posts its own comment', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', diagnosis: 'The ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  const blocked = terminalMarker(g, 'end-comment');
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: blocked, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  assert.equal(ticketComments(g).length, 0);

  const result = await interpreter.runExecution({ ...g.options, record: await record.load(g.commonDir, 'ticket', golden.TICKET),
    admission: { kind: 'hold', name: 'dirty-worktree', text: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.',
      advice: 'Commit, stash or remove these changes in the worktree.', detail: ' human.txt (untracked)\n' } });

  assert.equal(result.held, true, JSON.stringify(result));
  const [posted, ...rest] = ticketComments(g);
  assert.equal(rest.length, 0, 'only the hold is reported');
  assert.ok(posted.body.includes(terminalMarker(g, 'hold-comment')), 'the hold has its own Action Marker');
  assert.match(posted.body, /uncommitted changes gg did not make/);
  assert.match(posted.body, /Commit, stash or remove/);
  assert.match(posted.body, /human\.txt \(untracked\)/);
  assert.doesNotMatch(posted.body, /### gg: blocked|contradicts/, 'the interrupted blocked comment is not replayed');
  assert.ok(g.gh.labels.has('gg:state:needs-human'));
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(rec.state, 'held');
  assert.deepEqual(record.openIntents(rec).map((e) => e.marker), [blocked], 'the interrupted blocked intent stays open, untouched');
  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.reason.decidedBy.hold, 'dirty-worktree');
});

test('a crash inside the fault report replays its comment once on resume', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { throw: new Error('harness exploded') } } });
  const m = terminalMarker(g, 'fault-comment');
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-effect' } }));
  const mid = await record.load(g.commonDir, 'ticket', golden.TICKET);
  const result = await interpreter.runExecution({ ...g.options, record: mid });

  assert.equal(result.fault, true);
  const posted = ticketComments(g);
  assert.equal(posted.length, 1, 'posted exactly once');
  assert.match(posted[0].body, /harness exploded/);
  assert.doesNotMatch(posted[0].body, /Interrupted/, 'a fault inside a Visit interrupted no Terminal');
  assert.ok(!('interrupted' in g.readEvents().find((e) => e.type === 'ticket_end')));
  // The faulted Attempt never completed, so its intent stays open on the finished record.
  assert.deepEqual(record.openIntents(await record.load(g.commonDir, 'ticket', golden.TICKET)).map((e) => e.action), ['call']);
});

test('a pending fault report keeps its run stop when its comment lookup fails on resume', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const real = g.options.gh.commentIssue;
  let calls = 0;
  const gh = { ...g.options.gh, commentIssue: async (...a) => { if (calls++ === 0) throw new Error('gh comment down'); return real(...a); } };
  // The run stop's comment fails, so a fault reports it, and the process dies after the fault comment landed.
  await assert.rejects(interpreter.runExecution({ ...g.options, gh, crashAt: { marker: terminalMarker(g, 'fault-comment'), point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  const lookupDown = { ...g.options.gh, issueComments: async () => { throw new Error('gh api exited 1\nHTTP 502: Bad Gateway'); } };

  const result = await interpreter.runExecution({ ...g.options, gh: lookupDown, record: await record.load(g.commonDir, 'ticket', golden.TICKET) });
  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth', 'the saved run stop survives the failed recovery');
  assert.equal(ticketComments(g).length, 1, 'no second comment');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('an unknown failure goes to needs-human without retry', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'unknown' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop, undefined);
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(attemptsOf(g, 'red', 'red').length, 1);
  const reason = stopReason(g, { vertex: 'red', action: 'red', recovery: 0, outcome: 'needs-human', rule: { table: 'fixed', row: 'unknown-failure' } });
  assert.match(reason.text, /unknown/);
});

test('a rejecting harness is an unexpected fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { throw: new Error('harness exploded') } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(g.harness.calls.length, 1, 'never retried');
  assert.equal(g.rec.state, 'fault');
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault', 'the record is marked on disk');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-human');
  assert.match(end.error, /harness exploded/);
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'the ticket goes to needs-human');
});

test('a fault whose terminal comment also fails is still recorded as a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { throw: new Error('harness exploded') } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.match(end.error, /harness exploded/);
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'the label is still attempted');
});

test('a harness rejecting with an empty error is still a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { throw: new Error() } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.ok(end.error, 'ticket_end carries a non-empty error');
});

test('a CrashError propagates untouched', async (t) => {
  const crash = new interpreter.CrashError('injected crash');
  const g = await golden.setup(t, { responses: { 'red/1/red/1': { throw: crash } } });
  await assert.rejects(interpreter.runExecution(g.options), (err) => err === crash);

  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'active');
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'issue'), 'no label change and no comment');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('golden: blocked after a red recovery pass stops', async (t) => {
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'red/1/recover/1': { files: {}, response: { ...golden.redResponse, claim: 'blocked', diagnosis: 'The tests cannot fail first.' } },
  } });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.gh.comments.length, 1);
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  stopReason(g, { vertex: 'red', action: 'red-check', recovery: 1, outcome: 'blocked', rule: { table: 'stopped', row: null }, comment: false });
});

test('a persona edit between green and its recovery pass does not reach the recovery call', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
  });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'green') g.files['implementer.md'] = golden.layerFile('# edited mid-visit\n');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.equal(g.harness.calls.length, 3);
  assert.equal(g.harness.calls[2].personaBytes, golden.PERSONA, 'the recovery call gets the bytes pinned at Visit entry');
  assert.equal(g.harness.calls[2].personaHash, g.harness.calls[1].personaHash);
});
