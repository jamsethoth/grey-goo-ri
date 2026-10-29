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
  assert.deepEqual([...new Set(g.activity.map((a) => a.generation))], [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33],
    'one busy generation per Action and per Vertex\'s clean check, rising by two');
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

test('golden: a failed red retries still-green once then fails at needs-human with its work in place', async (t) => {
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
  assert.equal(exhausted.outcome, 'failed');
  assert.equal(exhausted.rule, 'check-exhausted', 'the transition table derives the engine Outcome failed');
  assert.equal(exhausted.direction, 'stop');
  assert.equal(actionEvent(g, 'red', 'red-check').rule, 'check-failed', 'the first failing run retries through still-green');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', `${g.base}..HEAD`), '0', 'no commit on the branch');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '?? test/', "the agent's test stays in the worktree for the human");
  assert.deepEqual(intents(g.rec, 'reset'), [], 'nothing is reset');
  assert.deepEqual(g.rec.history, []);
  assert.deepEqual(record.openIntents(g.rec), []);
  assert.equal(g.readEvents().at(-1).outcome, 'needs-human');

  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'red', visit: 1, action: 'red-check', recovery: 1 });
  assert.equal(reason.outcome, 'failed');
  assert.equal(reason.rule, 'check-exhausted');
  assert.equal(reason.text, 'The tests-fail Check red-check failed with no recovery left (rule check-exhausted).');
  assert.match(g.gh.comments[0].body, /```\nThe new tests did not fail before implementation/, 'the diagnosis is posted fenced');
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

test('an assume-unchanged edit before red is held too, so a rollback cannot reset it away', async (t) => {
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

// An Integrity Violation resets whatever its Agent's access, so a read-only red Vertex starts only on a clean worktree too.
test('a read-only red Vertex is held before unknown changes, so a rollback cannot reset them away', async (t) => {
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
