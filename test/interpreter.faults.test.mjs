import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as marker from '../lib/marker.mjs';
import * as golden from './support/golden.mjs';
import {
  terminalReasonOf, tddTrace, actionEvent, WRONG_ADD, GREEN_FAIL_OUTPUT, attemptsOf, neededHuman, ticketComments,
} from './support/interpreter.mjs';

const ok = (files) => ({ files, response: golden.greenResponse });

// The suite passes only once lib/add.mjs really adds, so a wrong green fails the Green Check.
async function greenSetup(t, responses, integrity, git) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses }, integrity, git });
  g.options.exec = {
    runShell: async (command, opts) => {
      const file = join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs');
      if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
      return readFileSync(file, 'utf8').includes('a + b')
        ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
    },
  };
  return g;
}

// A stop's Terminal Reason names the deciding Action, that Action's Outcome and rule, and a sentence of its own.
function stopReason(g, { phase, ordinal, outcome, rule, comment }) {
  const reason = terminalReasonOf(g, { comment });
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase, ordinal });
  assert.equal(reason.outcome, outcome);
  assert.equal(reason.rule, rule);
  assert.doesNotMatch(reason.text, /ended with|cannot run yet/, `a sentence naming the failure: ${reason.text}`);
  return reason;
}

test('golden: an invalid structured response is retried once with a nudge then stops', async (t) => {
  const g = await golden.setup(t, { git: 'real', responses: {
    ...structuredClone(golden.firstVisitResponses),
    'implementer/1/green/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: null },
    'implementer/1/green/2': { files: {}, response: { ...golden.greenResponse, claim: 'ok blocked' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const green = attemptsOf(g, 'green', 1);
  assert.deepEqual(green.map((e) => [e.attempt, e.rule]), [[1, 'parse-retry'], [2, 'parse-exhausted']]);
  assert.equal(green[1].outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 3);
  const [, first, nudge] = g.harness.calls;
  assert.equal(nudge.resume, 'fake-session-2', 'the nudge resumes the green session');
  assert.ok(first.brief.startsWith('GREEN PHASE'));
  assert.ok(!nudge.brief.startsWith('GREEN PHASE'), 'attempt 2 gets the nudge, not the green Brief again');
  assert.match(nudge.brief, /structured result/i);
  assert.notEqual(nudge.marker, first.marker, 'the marker names the attempt');
  assert.equal(g.rec.retries['implementer/1/green/1'].parse, 1);
  assert.ok(!golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').some((s) => s.startsWith('feat:')));
  stopReason(g, { phase: 'green', ordinal: 1, outcome: 'needs-human', rule: 'parse-exhausted' });
});

test('golden: an integrity violation restores the baseline and stops at needs-human', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      golden.sh(g.worktree, 'add', '-A');
      golden.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
      g.agentCommit = golden.sh(g.worktree, 'rev-parse', 'HEAD');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 1);
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal(red.direction, 'stop');
  assert.ok(red.violations.some((v) => v.surface === 'head'), JSON.stringify(red.violations));
  assert.notEqual(g.agentCommit, g.base);
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.equal(golden.sh(g.worktree, 'branch', '--contains', g.agentCommit), '', 'the agent commit is gone from the branch');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '');
  assert.equal(g.harness.calls.length, 1, 'no retry after a violation');
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'integrity-violation', rule: 'integrity-violation' });
  assert.match(reason.text, /integrity/i);
  assert.match(g.gh.comments[0].body, /\bhead\b/, 'the comment names the surface');
  assert.ok(neededHuman(g), 'the ticket is at needs-human');
});

test('an integrity violation removes an injected ignored Protected File and restores a pre-existing one', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  mkdirSync(join(g.worktree, '.claude', 'skills', 'injected'), { recursive: true });
  writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(g.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      writeFileSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md'), 'injected\n');
      writeFileSync(local, '{"agent":true}\n');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 1);
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.violations.find((v) => v.surface === 'protected').after.sort(),
    ['.claude/settings.local.json', '.claude/skills/injected/SKILL.md']);
  assert.ok(!existsSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md')), 'the injected skill is removed');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', 'the pre-existing file keeps its baseline bytes');
});

test('a failing green check runs test-fix once then derives gate-failed(test)', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' }),
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.phase}/${e.ordinal}`),
    ['red/1', 'red/2', 'red/3', 'green/1', 'green/2', 'test-fix/1', 'test-fix/2']);
  assert.equal(actionEvent(g, 'green', 2).rule, 'check-failed', 'the first failure recovers through test-fix');
  assert.ok(tddTrace(g).every((e) => e.attempt === 1), 'test-fix is its own Actions, not another Attempt');
  const fix = g.harness.calls[2];
  assert.equal(fix.resume, 'fake-session-2', 'test-fix resumes the green session');
  assert.ok(fix.brief.includes(GREEN_FAIL_OUTPUT), 'test-fix gets the failing output');
  const exhausted = actionEvent(g, 'test-fix', 2);
  assert.equal(exhausted.outcome, 'gate-failed(test)');
  assert.equal(exhausted.rule, 'check-exhausted');
  assert.equal(g.rec.visits.implementer, 1, 'no Edge was traversed for the retry');
  const reason = stopReason(g, { phase: 'test-fix', ordinal: 2, outcome: 'gate-failed(test)', rule: 'check-exhausted' });
  assert.match(reason.text, /Green Check/);
});

test('a test-fix that changes the committed test is rolled back to its baseline and stops', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/add.test.mjs': '// weakened\n' }),
  }, 'real');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(g, 'test-fix', 2);
  assert.equal(check.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'no forbidden edit or implementation file survives');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'), 'the committed test bytes are restored');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', 'HEAD'), '2', 'the red commit survives');
});

// Ignored paths survive git clean, so the rollback removes the ignored tests the agent added and only those.
function excludeTests(g, ...paths) {
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), paths.join(String.fromCharCode(10)));
}

test('a test-fix that adds an ignored test file has it removed by the rollback', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/injected.test.mjs': 'injected' }),
  }, 'real');
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'test-fix', 2).violations, ['test/injected.test.mjs']);
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});

test('an ignored test file that was there before the call gets its bytes back from the rollback', async (t) => {
  const g = await greenSetup(t, { 'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/owner.test.mjs': 'agent' }) }, 'real');
  excludeTests(g, 'test/owner.test.mjs');
  mkdirSync(join(g.worktree, 'test'), { recursive: true });
  writeFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'owner');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'green', 2).violations, ['test/owner.test.mjs']);
  assert.equal(readFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'utf8'), 'owner');
});

test('an integrity violation on a Protected File also removes an ignored test file the same Attempt added', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'test/injected.test.mjs': 'injected', 'AGENTS.md': 'agent' }),
  }, 'real');
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'test-fix', 1).outcome, 'integrity-violation');
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});

test('a timed-out result gets one fresh attempt then needs-human', async (t) => {
  const red = golden.firstVisitResponses['implementer/1/red/1'];
  const g = await golden.setup(t, { responses: {
    'implementer/1/red/1': { ...red, result: { status: 'timed-out' } },
    'implementer/1/red/2': { ...red, result: { status: 'timed-out' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 1).map((e) => [e.attempt, e.rule]), [[1, 'timeout-retry'], [2, 'timeout-exhausted']]);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'the fresh Attempt resumes the session');
  assert.equal(g.rec.retries['implementer/1/red/1'].timeout, 1);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'timeout-exhausted' });
  assert.match(reason.text, /timed out/);
});

test('a transient failure is retried within budget honouring retryAfterMs', async (t) => {
  const failed = { files: {}, response: null, failure: { class: 'transient', retryAfterMs: 5 } };
  const g = await golden.setup(t, { responses: {
    'implementer/1/red/1': failed, 'implementer/1/red/2': failed, 'implementer/1/red/3': failed,
  } });
  const sleeps = [];
  const { clock } = g.options;
  g.options.clock = { now: clock.now, sleep: async (ms) => { sleeps.push(ms); return clock.sleep(ms); } };
  const start = clock.now();
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 1).map((e) => [e.attempt, e.rule]),
    [[1, 'transient-retry'], [2, 'transient-retry'], [3, 'transient-exhausted']]);
  assert.equal(g.harness.calls.length, 3);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(clock.now() - start, 10, 'the injected clock advanced by retryAfterMs each time');
  assert.equal(g.rec.retries['implementer/1/red/1'].transient, 2);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'transient-exhausted' });
  assert.match(reason.text, /transient/);
});

test('an auth failure stops the run with its class', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(actionEvent(g, 'red', 1).failureClass, 'auth');
  assert.ok(neededHuman(g));
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'run-stop', rule: 'run-stop' });
  assert.match(reason.text, /auth/);
});

test('an auth failure keeps its run stop when the terminal comment fails', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.ok(neededHuman(g));
});

const terminalMarker = (g, phase, ordinal) => marker.formatMarker({
  execution: g.rec.execution, vertex: 'needs-human', visit: 1, phase, ordinal, run: g.rec.run, attempt: 1,
});

test('a fault interrupting a Terminal comment posts its own comment with the error and the interrupted Terminal Reason', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
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
  assert.ok(posted.body.includes(terminalMarker(g, 'fault', 1)), 'the fault report has its own Action Marker');
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(record.openIntents(rec).map((e) => e.marker), [terminalMarker(g, 'needs-human', 1)],
    'the intent of the interrupted comment stays open, and the fault report never replays it');
  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.interrupted.terminal, 'needs-human');
  assert.match(end.interrupted.reason.text, /auth/, 'ticket_end keeps the interrupted Terminal Reason too');
});

test('a hold over an interrupted blocked terminal posts its own comment', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', notes: 'The ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  const blocked = terminalMarker(g, 'needs-human', 1);
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: blocked, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  assert.equal(ticketComments(g).length, 0);

  const result = await interpreter.runExecution({ ...g.options, record: await record.load(g.commonDir, 'ticket', golden.TICKET),
    admission: { kind: 'hold', name: 'dirty-worktree', text: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.',
      advice: 'Commit, stash or remove these changes in the worktree.', detail: ' human.txt (untracked)\n' } });

  assert.equal(result.held, true, JSON.stringify(result));
  const [posted, ...rest] = ticketComments(g);
  assert.equal(rest.length, 0, 'only the hold is reported');
  assert.ok(posted.body.includes(terminalMarker(g, 'hold', 1)), 'the hold has its own Action Marker');
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
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  const m = terminalMarker(g, 'fault', 1);
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
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const real = g.options.gh.commentIssue;
  let calls = 0;
  const gh = { ...g.options.gh, commentIssue: async (...a) => { if (calls++ === 0) throw new Error('gh comment down'); return real(...a); } };
  // The run stop's comment fails, so a fault reports it, and the process dies after the fault comment landed.
  await assert.rejects(interpreter.runExecution({ ...g.options, gh, crashAt: { marker: terminalMarker(g, 'fault', 1), point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  const lookupDown = { ...g.options.gh, issueComments: async () => { throw new Error('gh api exited 1\nHTTP 502: Bad Gateway'); } };

  const result = await interpreter.runExecution({ ...g.options, gh: lookupDown, record: await record.load(g.commonDir, 'ticket', golden.TICKET) });
  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth', 'the saved run stop survives the failed recovery');
  assert.equal(ticketComments(g).length, 1, 'no second comment');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('an unknown failure goes to needs-human without retry', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'unknown' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop, undefined);
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(attemptsOf(g, 'red', 1).length, 1);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'unknown-failure' });
  assert.match(reason.text, /unknown/);
});

test('a rejecting harness is an unexpected fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(g.harness.calls.length, 1, 'never retried');
  assert.equal(g.rec.state, 'fault');
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault', 'the record is marked on disk');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-human');
  assert.match(end.error, /harness exploded/);
  assert.ok(neededHuman(g), 'the ticket goes to needs-human');
});

test('a fault whose terminal comment also fails is still recorded as a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.match(end.error, /harness exploded/);
  assert.ok(neededHuman(g), 'the label is still attempted');
});

test('a harness rejecting with an empty error is still a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error() } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.ok(end.error, 'ticket_end carries a non-empty error');
});

test('a CrashError propagates untouched', async (t) => {
  const crash = new interpreter.CrashError('injected crash');
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: crash } } });
  await assert.rejects(interpreter.runExecution(g.options), (err) => err === crash);

  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'active');
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'issue'), 'no label change and no comment');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('blocked after still-green stops', async (t) => {
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'implementer/1/still-green/1': { files: {}, response: { ...golden.redResponse, claim: 'blocked', notes: 'The tests cannot fail first.' } },
  } });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.gh.comments.length, 1);
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  stopReason(g, { phase: 'still-green', ordinal: 2, outcome: 'blocked', rule: 'blocked', comment: false });
});

test('blocked after test-fix stops', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': { files: {}, response: { ...golden.greenResponse, claim: 'blocked', notes: 'The test is wrong.' } },
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 3, 'red, green and test-fix');
  assert.equal(g.gh.comments.length, 1);
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  assert.equal(actionEvent(g, 'test-fix', 2)?.rule, 'blocked', 'the Green Check after test-fix still runs');
  stopReason(g, { phase: 'test-fix', ordinal: 2, outcome: 'blocked', rule: 'blocked', comment: false });
});

test('requireTestPass false is recorded on every event and does not block advance', async (t) => {
  const g = await greenSetup(t, { 'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) }, 'fake', 'real');
  g.flow.ticket.vertices.implementer.options = { requireTestPass: false };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  const check = actionEvent(g, 'green', 2);
  assert.equal(check.signals.checks.find((c) => c.name === 'test').passed, false, 'the failing Green Check is recorded');
  assert.equal(check.direction, 'advance');
  assert.ok(!tddTrace(g).some((e) => e.phase === 'test-fix'), 'a relaxed Green Check needs no recovery');
  assert.ok(golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').some((s) => s.startsWith('feat:')));
  const visit = g.readEvents().filter((e) => e.type === 'action' && e.procedure === 'tdd');
  assert.ok(visit.length > 0);
  for (const e of visit) assert.equal(e.requireTestPass, false, `${e.phase}/${e.ordinal}`);
});

test('a persona edit between green and test-fix does not reach the test-fix call', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
  });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'green') writeFileSync(g.personaPath, '# edited mid-visit\n');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  assert.equal(g.harness.calls.length, 3);
  assert.equal(g.harness.calls[2].personaBytes, golden.PERSONA, 'test-fix gets the bytes pinned at Visit entry');
  assert.equal(g.harness.calls[2].personaHash, g.harness.calls[1].personaHash);
});
