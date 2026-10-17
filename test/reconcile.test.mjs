import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as marker from '../lib/marker.mjs';
import * as reconcile from '../lib/reconcile.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';

// A failed red Phase whose reset is interrupted by a crash at `when`: before the reset, or after it.
async function crashedFailedRed(t, when) {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = g.options.git;
  g.options.git = { ...git, resetTo: async (...args) => {
    if (when === 'after reset') await git.resetTo(...args);
    throw new interpreter.CrashError('crash');
  } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  g.loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  return g;
}

const resetEntries = (rec) => rec.log.filter((e) => e.action === 'reset').map((e) => e.step);

test('a crash after the reset of a failed red keeps its History item exactly once', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  assert.deepEqual(g.loaded.history, [], 'the crash came before the History item was saved');
  assert.deepEqual(resetEntries(g.loaded), ['intent']);

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'continue');
  assert.equal(g.loaded.history.length, 1);
  assert.equal(g.loaded.history[0].kind, 'red phase failed');
  assert.match(g.loaded.history[0].text, /did not fail before implementation/);
  assert.deepEqual(resetEntries(g.loaded), ['intent', 'evidence', 'complete']);
  assert.deepEqual(record.openIntents(g.loaded), []);

  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(saved.history, g.loaded.history, 'the History item is persisted');
  assert.equal(await reconcile.resets(saved, { git: g.options.git }), 'continue');
  assert.equal(saved.history.length, 1, 'a second Reconciliation adds nothing');
});

test('a reset whose evidence was saved but not its completion is completed without a second History item', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/still-green/1': { files: {}, response: golden.redResponse } } });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  await interpreter.runExecution(g.options);
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  rec.log = rec.log.filter((e) => !(e.action === 'reset' && e.step === 'complete'));

  assert.equal(await reconcile.resets(rec, { git: g.options.git }), 'continue');
  assert.equal(rec.history.length, 1);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
});

test('a crash before the reset holds the Execution and discards nothing', async (t) => {
  const g = await crashedFailedRed(t, 'before reset');
  const dirty = golden.sh(g.worktree, 'status', '--porcelain');
  assert.notEqual(dirty, '', 'the agent changes are still in the worktree');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), dirty, 'nothing is discarded at resume');
  assert.deepEqual(g.loaded.history, []);
  assert.equal(record.openIntents(g.loaded)[0].payload.history.kind, 'red phase failed', 'the reason waits in the open intent');
});

test('an assume-unchanged edit left at the baseline does not prove the reset done', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  golden.sh(g.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(g.worktree, tracked), 'a hidden agent edit\n');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'git status cannot see it');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.deepEqual(g.loaded.history, []);
  assert.deepEqual(resetEntries(g.loaded), ['intent']);
});

test('an ignored test added after an interrupted reset holds the restore and is kept', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  writeFileSync(join(g.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  mkdirSync(join(g.worktree, 'test'), { recursive: true });
  writeFileSync(join(g.worktree, 'test', 'human.test.mjs'), 'mine\n');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.equal(readFileSync(join(g.worktree, 'test', 'human.test.mjs'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.deepEqual(resetEntries(g.loaded), ['intent']);
});

test('a failed HEAD read after the reset of a failed red leaves the History item to Reconciliation, once', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = g.options.git;
  let reset = false;
  g.options.git = { ...git,
    resetTo: async (...args) => { await git.resetTo(...args); reset = true; },
    headSha: async (cwd) => { if (reset) throw new interpreter.CrashError('head read failed'); return git.headSha(cwd); } };
  await assert.rejects(interpreter.runExecution(g.options), /head read failed/);

  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(loaded.history, [], 'no History item is saved without the reset evidence');
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(loaded.history.length, 1);
});

test('a crash between the reset and the Protected File restore of an integrity violation is finished by Reconciliation', async (t) => {
  const g = await golden.setup(t);
  mkdirSync(join(g.worktree, '.claude'), { recursive: true });
  writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(g.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') writeFileSync(local, '{"agent":true}\n');
    return out;
  };
  const git = g.options.git;
  g.options.git = { ...git, resetTo: async (...args) => {
    await git.resetTo(...args);
    throw new interpreter.CrashError('crash');
  } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  assert.equal(readFileSync(local, 'utf8'), '{"agent":true}\n', 'the crash came before the restore');

  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', "the owner's bytes come back from the saved intent");
  assert.equal(loaded.history[0].kind, 'integrity violation');
  assert.deepEqual(record.openIntents(loaded), []);
});

// T18: crash-and-resume golden traces. Each side-effect Action of the one-Vertex Flow is crashed at one of three points
// by runExecution's test-only crashAt, then resumed by a second runExecution on a freshly loaded record.
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const markerOf = (rec, vertex, visit, phase, ordinal) =>
  marker.formatMarker({ execution: rec.execution, vertex, visit, phase, ordinal, run: rec.run, attempt: 1 });
const stepsOf = (rec, m) => rec.log.filter((e) => e.marker === m).map((e) => e.step);
const commitMessages = (g) => golden.sh(g.worktree, 'log', '--format=%B%x00', `${g.base}..HEAD`).split('\0').map((m) => m.trim()).filter(Boolean);
const remoteSha = (g) => golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0] || null;
const withMarker = (bodies, m) => bodies.filter((b) => b.includes(marker.markerComment(m)));
const loadTicket = (g) => record.load(g.commonDir, 'ticket', golden.TICKET);

const EFFECTS = {
  commit: {
    at: ['implementer', 1, 'green', 3],
    happened: (g, m) => commitMessages(g).some((b) => b.includes(marker.markerTrailer(m))),
  },
  push: {
    at: ['implementer', 1, 'green', 4],
    happened: (g) => remoteSha(g) === golden.sh(g.worktree, 'rev-parse', 'HEAD'),
  },
  'PR upsert': {
    at: ['implementer', 1, 'green', 5],
    happened: (g, m) => !!g.gh.pr()?.body.includes(marker.markerComment(m)),
  },
  comment: {
    at: ['done', 1, 'done', 2],
    happened: (g, m) => withMarker(g.gh.comments.map((c) => c.body), m).length > 0,
  },
};

const POINTS = {
  'before-effect': { name: (a) => `golden: crash before the ${a} effect resumes by redoing it`, happened: false, steps: ['intent'] },
  'after-effect': { name: (a) => `golden: crash after the ${a} effect resumes by completing it`, happened: true, steps: ['intent'] },
  'after-completion': { name: (a) => `golden: crash after ${a} completion resumes past it`, happened: true, steps: ['intent', 'evidence', 'complete'] },
};

// Runs the golden Execution until crashAt fires at `point` of the Action at `at`, and returns the freshly loaded record.
async function crashed(g, at, point) {
  const m = markerOf(g.rec, ...at);
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point } }),
    (err) => err instanceof interpreter.CrashError);
  return { m, loaded: await loadTicket(g) };
}

for (const [action, effect] of Object.entries(EFFECTS)) {
  for (const [point, expect] of Object.entries(POINTS)) {
    test(expect.name(action), async (t) => {
      const g = await golden.setup(t);
      const { m, loaded } = await crashed(g, effect.at, point);
      assert.equal(effect.happened(g, m), expect.happened, `the crash came ${point}`);
      assert.deepEqual(stepsOf(loaded, m), expect.steps, `the log as the crash ${point} left it`);

      const result = await interpreter.runExecution({ ...g.options, record: loaded });
      assert.equal(result.outcome, 'done');
      const final = await loadTicket(g);
      assert.equal(final.state, 'done');
      assert.equal(g.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');

      // One intent, one evidence and one completion per marker.
      for (const e of final.log.filter((x) => x.step === 'intent')) {
        assert.deepEqual(stepsOf(final, e.marker), ['intent', 'evidence', 'complete'], `${e.action} ${e.marker}`);
      }
      const intents = (name) => final.log.filter((e) => e.step === 'intent' && e.action === name);

      const messages = commitMessages(g);
      assert.equal(messages.length, intents('commit').length, 'no duplicate commit');
      for (const e of intents('commit')) {
        assert.equal(messages.filter((b) => b.includes(marker.markerTrailer(e.marker))).length, 1, e.marker);
      }
      assert.equal(remoteSha(g), golden.sh(g.worktree, 'rev-parse', 'HEAD'), 'the remote branch is at the last commit');

      assert.equal(g.gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length, 1, 'exactly one PR');
      const [upsert] = intents('pr-upsert');
      assert.ok(g.gh.pr().body.includes(marker.markerComment(upsert.marker)), 'the PR body carries the marker');
      assert.equal(sha256(g.gh.pr().body), upsert.payload.bodyHash, 'the PR body is the intended one');

      const done = markerOf(g.rec, ...EFFECTS.comment.at);
      const posted = withMarker(g.gh.comments.map((c) => c.body), done);
      assert.equal(posted.length, 1, 'exactly one comment with the marker');
      assert.equal(sha256(posted[0]), final.log.find((e) => e.marker === done && e.step === 'intent').payload.bodyHash);
    });
  }
}

const NEEDS_HUMAN = 'gg:state:needs-human';
const reconcileArgs = (g, rec, flow = g.flow) =>
  ({ record: rec, flow, git: g.options.git, gh: g.options.gh, labelPrefix: 'gg', cwd: g.mainRoot });

test('an amended commit with the marker holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-effect');
  // A human amends the gg commit between the crash and the resume: same marker and parent, different tree.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN), 'the ticket is labelled needs-human');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.ok(existsSync(join(g.worktree, 'notes.txt')));
  assert.equal(remoteSha(g), null, 'nothing is pushed');
  assert.equal(g.harness.calls.length, 2);
});

test('a commit amended after its completion was saved holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-completion');
  // The commit is complete in the record, so no open intent points at it; the amend keeps its marker.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(remoteSha(g), null, 'the amended commit is not published');
  assert.equal(g.harness.calls.length, 2);
});

test('a crash before the commit replays the intended tree, not a human edit', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');

  const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal(result.outcome, 'done');
  const final = await loadTicket(g);
  const { payload } = final.log.find((e) => e.marker === m && e.step === 'intent');
  const { sha } = final.log.find((e) => e.marker === m && e.step === 'evidence').evidence;
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^{tree}`), payload.tree, 'the commit has the intended tree');
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^`), payload.parent, 'and the intended parent');
  assert.equal(readFileSync(join(g.worktree, 'notes.txt'), 'utf8'), 'a human note\n', 'the human edit is kept');
  assert.match(golden.sh(g.worktree, 'status', '--porcelain'), /\?\? notes\.txt/, 'and left uncommitted');
});

test('a branch moved before the commit replay holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(remoteSha(g), null, 'nothing is pushed');
});

test('a branch moved before the push replay holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.push.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(remoteSha(g), null, 'the moved branch is not published');
});

// A misscoped green ends in replan, whose Terminal posts the diagnosis on the ticket (ordinal 1) and the epic (ordinal 2).
const DIAGNOSIS = 'The ticket asks add to both sum and concatenate.';
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the epic diagnosis comment resumes the same replan Actions`, async (t) => {
    const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
      'implementer/1/green/1': { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: DIAGNOSIS } } } });
    await crashed(g, ['replan', 1, 'replan', 2], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'replan');
    const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.rec.epic);
    assert.equal(onEpic.length, 1, 'exactly one diagnosis on the epic');
    assert.ok(onEpic[0].body.includes(DIAGNOSIS));
    const onTicket = g.gh.comments.filter((c) => c.target === 'issue' && c.number === golden.TICKET);
    assert.equal(onTicket.length, 1);
    assert.ok(onTicket[0].body.includes(DIAGNOSIS));
    assert.ok(g.gh.labels.has('gg:state:needs-replan'), 'the label Action keeps its own payload');
    const final = await loadTicket(g);
    assert.equal(final.state, 'replan');
    for (const e of final.log.filter((x) => x.step === 'intent')) {
      assert.deepEqual(stepsOf(final, e.marker), ['intent', 'evidence', 'complete'], `${e.action} ${e.marker}`);
    }
  });
}

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to needs-human.
async function violating(t) {
  const g = await golden.setup(t);
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') writeFileSync(join(g.worktree, 'CLAUDE.md'), 'an agent edit\n');
    return out;
  };
  return g;
}

const RESUMED = {
  'before-effect': { outcome: 'needs-human', state: 'held' },
  'after-effect': { outcome: 'needs-human', state: 'needs-human' },
  'after-completion': { outcome: 'needs-human', state: 'needs-human' },
};
for (const [point, expect] of Object.entries(RESUMED)) {
  test(`a crash ${point} of an integrity violation rollback does not call the harness again`, async (t) => {
    const g = await violating(t);
    await crashed(g, ['implementer', 1, 'red', 1], point);
    assert.equal(g.harness.calls.length, 1);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, expect.outcome);
    assert.equal(g.harness.calls.length, 1, 'the violating call is not dispatched again');
    const final = await loadTicket(g);
    assert.equal(final.state, expect.state);
    if (point !== 'before-effect') {
      assert.equal(final.terminalReason.rule, 'integrity-violation');
      assert.equal(final.history.filter((h) => h.kind === 'integrity violation').length, 1);
      assert.ok(!existsSync(join(g.worktree, 'CLAUDE.md')), 'the violation stays rolled back');
    }
  });
}

for (const point of ['after-effect', 'after-completion']) {
  test(`a crash ${point} of gg's own needs-human label finishes the Terminal`, async (t) => {
    const g = await violating(t);
    await crashed(g, ['needs-human', 1, 'needs-human', 2], point);
    assert.ok(g.gh.labels.has(NEEDS_HUMAN), 'gg applied the label before the crash');

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(record.openIntents(final), []);
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

// Each Terminal kind crashes at its needs-human label (a fault report's Actions have phase fault), then resumes on a freshly loaded record with the same options.
const CLASSIFIED = {
  held: {
    async crash(g) {
      await crashed(g, EFFECTS.commit.at, 'after-completion');
      g.options.flow = structuredClone(g.flow);
      g.options.flow.ticket.vertices = { builder: g.flow.ticket.vertices.implementer };
      g.options.flow.ticket.entry = 'builder';
      g.options.record = await loadTicket(g);
    },
    check(result, final, end) {
      assert.equal(result.held, true);
      assert.equal(final.state, 'held');
      assert.match(end.reason.text, /implementer/);
    },
  },
  fault: {
    phase: 'fault',
    async crash(g) {
      const run = g.harness.run;
      g.harness.run = async (call) => {
        if (call.phase === 'red') throw new Error('the harness exploded');
        return run(call);
      };
    },
    check(result, final, end) {
      assert.equal(result.fault, true);
      assert.equal(final.state, 'fault');
      assert.equal(end.error, 'the harness exploded');
    },
  },
  'run stop': {
    responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } },
    async crash() {},
    check(result, final) {
      assert.equal(result.runStop?.failureClass, 'auth');
      assert.equal(final.state, 'needs-human');
    },
  },
};
for (const [kind, c] of Object.entries(CLASSIFIED)) {
  for (const point of Object.keys(POINTS)) {
    test(`a crash ${point} of the ${kind} needs-human label keeps the ${kind} classification`, async (t) => {
      const g = await golden.setup(t, c.responses && { responses: c.responses });
      await c.crash(g);
      await crashed(g, ['needs-human', 1, c.phase ?? 'needs-human', 2], point);

      const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
      assert.equal(result.outcome, 'needs-human');
      assert.ok(g.gh.labels.has(NEEDS_HUMAN));
      const ends = g.readEvents().filter((e) => e.type === 'ticket_end');
      assert.equal(ends.length, 1);
      c.check(result, await loadTicket(g), ends[0]);
    });
  }
}

test('a needs-human label overrides a mid-action record', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  g.gh.labels.add(NEEDS_HUMAN);
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'abandon');

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(g.harness.calls.length, 2, 'the Execution is not resumed');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'the intended commit is not made');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.equal(g.gh.pr(), null);
});

test('a vertex missing from the flow holds the ticket', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'after-completion');
  const flow = structuredClone(g.flow);
  flow.ticket.vertices = { builder: flow.ticket.vertices.implementer };
  flow.ticket.entry = 'builder';

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g), flow));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason, /implementer/);

  await interpreter.runExecution({ ...g.options, flow, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN));
  assert.equal(g.harness.calls.length, 2);
});

const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';

test('a missing transcript starts the phase fresh', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/green/1': { files: { 'lib/add.mjs': 'export const add = () => 0;\n' }, response: golden.greenResponse },
    'implementer/1/test-fix/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: golden.greenResponse } } });
  g.options.exec = {
    runShell: async (command, opts) => {
      const file = join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs');
      if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
      return readFileSync(file, 'utf8').includes('a + b')
        ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
    },
  };
  const run = g.harness.run;
  let crashedOnce = false;
  g.harness.run = async (call) => {
    if (call.phase === 'test-fix' && !crashedOnce) { crashedOnce = true; throw new interpreter.CrashError('crash'); }
    return run(call);
  };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  const loaded = await loadTicket(g);
  assert.equal(loaded.cursor.phase, 'test-fix');
  rmSync(loaded.sessions['implementer/1/green'].transcriptPath);

  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  const call = g.harness.calls[2];
  assert.ok(call.marker.includes(':test-fix:'), call.marker);
  assert.equal(call.resume, null, 'the green Session is not resumed without its transcript');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT), 'the full test-fix Brief, not a nudge');
  assert.ok(g.logs.some((l) => /transcript/.test(l)), `the fresh start is logged: ${JSON.stringify(g.logs)}`);
  assert.equal(result.outcome, 'done');
});

test('bounds survive a restart', async (t) => {
  const review = (findings) => ({ files: {}, response: {
    claim: 'changes', summary: 'The review says changes.', dodMet: true, tddEvidenceOk: true, findings, diagnosis: '' } });
  const finding = (issue) => ({ severity: 'major', file: 'lib/add.mjs', issue, fix: 'Make it right.' });
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'reviewer/1/review/1': review([finding('first problem')]),
    'implementer-fix/1/fix/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' },
      response: { ...golden.greenResponse, summary: 'Address the findings.' } },
    'reviewer/2/review/1': review([finding('second problem')]) } });
  const reviewerPersona = join(g.root, 'personas', 'reviewer.md');
  writeFileSync(reviewerPersona, '# reviewer\nJudge the diff.\n');
  const implementer = g.flow.ticket.vertices.implementer;
  g.flow.ticket.vertices = {
    implementer: { ...implementer, then: 'reviewer' },
    reviewer: { node: { ...structuredClone(implementer.node), persona: reviewerPersona, access: 'read-only' }, procedure: 'review',
      options: {}, route: { ok: 'done', changes: { to: 'implementer-fix', max: 1, exhausted: 'needs-human' } } },
    'implementer-fix': { node: structuredClone(implementer.node), procedure: 'fix', options: {}, then: 'reviewer' },
  };
  const key = 'reviewer->implementer-fix:changes';
  const { loaded } = await crashed(g, ['reviewer', 2, 'review', 3], 'after-completion');
  assert.equal(loaded.traversals[key], 1, 'the Edge is at its Bound');

  const before = g.harness.calls.length;
  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  assert.equal(result.outcome, 'needs-human', 'the changes Edge routes to its exhausted target');
  assert.ok(!g.harness.calls.slice(before).some((c) => c.brief.startsWith('FIX ROUND')), 'no fix call after the restart');
  const final = await loadTicket(g);
  assert.equal(final.traversals[key], 1);
  assert.deepEqual(final.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
});

test('a corrupt record holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const corrupt = '{ "schemaVersion": 1, "log": [';
  const db = record.openDb(g.commonDir);
  db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = ?").run(corrupt, golden.TICKET);
  const err = await loadTicket(g).catch((e) => e);
  assert.ok(err instanceof record.RecordCorruptError, String(err));

  const decided = await reconcile.reconcile(reconcileArgs(g, err));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason, /corrupt/);
  const row = db.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(golden.TICKET);
  assert.equal(row.json, corrupt, 'the corrupt record is never discarded');
});
