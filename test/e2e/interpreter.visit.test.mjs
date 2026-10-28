import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import { firstVisit, intents, steps, actionMarker, terminalReasonOf, tddTrace, actionEvent } from '../support/interpreter.mjs';

test('commits match the recorded intent tree', async (t) => {
  const g = await firstVisit(t, { git: 'real' });
  const commits = intents(g.rec, 'commit');
  assert.equal(commits.length, 2);
  const shaOf = (c) => g.rec.log.find((e) => e.marker === c.marker && e.step === 'evidence').evidence.sha;
  const [testCommit, featCommit] = commits;
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${shaOf(testCommit)}^{tree}`), testCommit.payload.tree);
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${shaOf(testCommit)}^`), testCommit.payload.parent);
  assert.equal(golden.sh(g.worktree, 'log', '-1', '--format=%B', shaOf(testCommit)).trim(), testCommit.payload.message.trim());
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${shaOf(featCommit)}^{tree}`), featCommit.payload.tree);
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${shaOf(featCommit)}^`), featCommit.payload.parent);
  assert.equal(golden.sh(g.worktree, 'log', '-1', '--format=%B', shaOf(featCommit)).trim(), featCommit.payload.message.trim());
  assert.equal(testCommit.payload.parent, g.base);
  const red = golden.sh(g.worktree, 'ls-tree', '-r', '--name-only', testCommit.payload.tree);
  assert.ok(red.includes('test/add.test.mjs'), red);
  assert.ok(!red.includes('lib/add.mjs'), 'the test commit holds only the tests');
});

test('activity brackets every launched process', async (t) => {
  const g = await firstVisit(t, { integrity: 'real' });
  assert.deepEqual([...new Set(g.activity.map((a) => a.what.split(/[ .]/)[0]))].sort(), ['gh', 'git', 'harness', 'test'],
    'harness, test, git and gh calls observed');
  assert.deepEqual(g.activity.filter((a) => a.busy !== true), [], 'every process ran while the worktree was busy');
  assert.deepEqual([...new Set(g.activity.map((a) => a.generation))], [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27],
    'one busy generation per Action and per write Vertex\'s clean check, rising by two');
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.activity.filter((a) => a.what === 'harness').length, 2);
  assert.equal(g.rec.activity.busy, false);
});

test('a green call that changes the committed test is an integrity violation', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'].files['test/add.test.mjs'] = "import { add } from '../lib/add.mjs';\n// weakened\n";
  const g = await golden.setup(t, { responses, integrity: 'real' });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'needs-human');
  const greenCheck = g.readEvents().find((e) => e.type === 'action' && e.vertex === 'green' && e.action === 'test');
  assert.equal(greenCheck.outcome, 'integrity-violation');
  assert.equal(greenCheck.direction, 'stop');
  assert.deepEqual(greenCheck.violations, ['test/add.test.mjs']);
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', 'HEAD'), '2', 'no feat commit after the violation');
});

test('golden: a failed red retries still-green once then stops at needs-human with history', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses, integrity: 'real' });
  // The new test passes before any implementation exists, both times.
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.action}/${e.recovery}`), ['red/0', 'red-check/0', 'red/1', 'red-check/1']);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'still-green resumes the red session');
  const exhausted = actionEvent(g, 'red', 'red-check', 1);
  assert.equal(exhausted.outcome, 'red-failed');
  assert.equal(exhausted.rule, 'check-exhausted', 'the transition table derives red-failed');
  assert.equal(exhausted.direction, 'stop');
  assert.equal(actionEvent(g, 'red', 'red-check').rule, 'check-failed', 'the first failing run retries through still-green');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', `${g.base}..HEAD`), '0', 'no commit on the branch');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the worktree is clean at the baseline head');
  assert.equal(g.rec.history.length, 1);
  assert.equal(g.rec.history[0].kind, 'red phase failed');
  assert.match(g.rec.history[0].text, /did not fail before implementation/);

  // The reset is a write-ahead side effect whose intent carries the baseline and the History item.
  const [reset] = intents(g.rec, 'reset');
  assert.equal(reset.marker, actionMarker(g, 'red', 'red-check', 1));
  assert.deepEqual(Object.keys(reset.payload).sort(), ['baseline', 'history', 'left', 'untracked']);
  assert.equal(reset.payload.baseline, g.base);
  assert.deepEqual(reset.payload.history, g.rec.history[0]);
  assert.equal(reset.payload.left.head, g.base, 'the intent saves the worktree the agent left, so admission can prove it');
  assert.match(reset.payload.left.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(reset.payload.untracked.files, {}, 'the rollback set of the first red call is saved too');
  assert.deepEqual(steps(g.rec, reset.marker), ['intent', 'evidence', 'complete']);
  assert.deepEqual(record.openIntents(g.rec), []);
  assert.equal(g.readEvents().at(-1).outcome, 'needs-human');

  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'red', visit: 1, action: 'red-check', recovery: 1 });
  assert.equal(reason.outcome, 'red-failed');
  assert.equal(reason.rule, 'check-exhausted');
  assert.equal(reason.text, "The red phase failed the Red Check (rule check-exhausted) and the agent's changes were discarded.");
  assert.match(g.gh.comments[0].body, /```\nThe new tests did not fail before implementation/, 'the diagnosis is posted fenced');
});

test('a failed red rollback removes an ignored test file the red call added', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].files['test/extra.test.mjs'] = 'extra';
  responses['red/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses, integrity: 'real' });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), 'test/extra.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'red', 'red-check', 1).outcome, 'red-failed');
  assert.ok(!existsSync(join(g.worktree, 'test', 'extra.test.mjs')), 'the ignored test the red call added is removed');
});

test('uncommitted changes before red are held at needs-human and nothing is deleted', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  writeFileSync(join(g.worktree, tracked), 'a human edit\n');
  writeFileSync(join(g.worktree, 'notes.txt'), 'untracked human work\n');
  const before = golden.sh(g.worktree, 'status', '--porcelain', '--untracked-files=all');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain', '--untracked-files=all'), before, 'every pre-existing change survives');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(g.rec.history.at(-1)?.kind, 'held');
  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.equal(reason.outcome, null);
  assert.equal(reason.rule, null);
  assert.match(reason.text, /uncommitted changes before red/);
});

test('an assume-unchanged edit before red is held too, so a failed red cannot reset it away', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses, integrity: 'real' });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  golden.sh(g.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(g.worktree, tracked), 'a hidden human edit\n');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(readFileSync(join(g.worktree, tracked), 'utf8'), 'a hidden human edit\n');
});

// A failed red resets whatever its Agent's access, so a read-only red Vertex starts only on a clean worktree too.
test('a read-only red Vertex is held before unknown changes, so a failed red cannot reset them away', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].files = {};
  responses['red/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses, integrity: 'real' });
  g.flow.ticket.vertices.red.agent.access = 'read-only';
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  writeFileSync(join(g.worktree, tracked), 'a human edit\n');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(readFileSync(join(g.worktree, tracked), 'utf8'), 'a human edit\n');
});
