import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as effectActions from '../../lib/effect-actions.ts';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import { actionEvent, intents } from '../support/execution-reads.ts';
import { runFirstVisit, tddTrace, terminalReasonOf } from '../support/golden-run.ts';
import * as firstVisit from '../support/first-visit.ts';
import * as gitShell from '../support/git-shell.ts';
import * as keys from '../support/keys.ts';
import * as suiteRuns from '../support/suite-runs.ts';

type Commit = writeAhead.WriteAheadEntry & { payload: effectActions.CommitPayload };
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const RED_RECOVERY = keys.responseKey('red', 1, 'recover', 1);
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);

test('commits match the recorded intent tree', async (t) => {
  const fixture = await runFirstVisit(t, { git: 'real' });
  const commits = intents(fixture.executionRecord, 'commit');
  assert.equal(commits.length, 2);
  const shaOf = (commit: { actionMarker: string }) =>
    fixture.executionRecord.writeAheadLog.find(
      (entry) => entry.actionMarker === commit.actionMarker && entry.step === 'evidence',
    )!.evidence!.sha as string;
  const [testCommit, featCommit] = commits as Commit[];
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', `${shaOf(testCommit)}^{tree}`), testCommit.payload.tree);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', `${shaOf(testCommit)}^`), testCommit.payload.parent);
  assert.equal(
    gitShell.sh(fixture.worktree, 'log', '-1', '--format=%B', shaOf(testCommit)).trim(),
    testCommit.payload.message.trim(),
  );
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', `${shaOf(featCommit)}^{tree}`), featCommit.payload.tree);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', `${shaOf(featCommit)}^`), featCommit.payload.parent);
  assert.equal(
    gitShell.sh(fixture.worktree, 'log', '-1', '--format=%B', shaOf(featCommit)).trim(),
    featCommit.payload.message.trim(),
  );
  assert.equal(testCommit.payload.parent, fixture.base);
  const red = gitShell.sh(fixture.worktree, 'ls-tree', '-r', '--name-only', testCommit.payload.tree);
  assert.ok(red.includes('test/add.test.mjs'), red);
  assert.ok(!red.includes('lib/add.mjs'), 'the test commit holds only the tests');
});

test('activity brackets every launched process', async (t) => {
  const fixture = await runFirstVisit(t, { integrity: 'real', git: 'real' });
  assert.deepEqual(
    [...new Set(fixture.activity.map((seen) => (seen.what as string).split(/[ .]/)[0]))].sort(),
    ['gh', 'git', 'harness', 'test'],
    'harness, test, git and gh calls observed',
  );
  assert.deepEqual(
    fixture.activity.filter((seen) => seen.busy !== true),
    [],
    'every process ran while the worktree was busy',
  );
  assert.deepEqual(
    [...new Set(fixture.activity.map((seen) => seen.generation))],
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33],
    "one busy generation per Action and per Vertex's clean check, rising by two",
  );
  assert.equal(fixture.harness.calls.length, 2);
  assert.equal(fixture.activity.filter((seen) => seen.what === 'harness').length, 2);
  assert.equal(fixture.executionRecord.activity.busy, false);
});

test('a green call that changes the committed test is an integrity violation', async (t) => {
  const responses = firstVisit.firstVisitWith();
  responses[GREEN_CALL].files!['test/add.test.mjs'] = "import { add } from '../lib/add.mjs';\n// weakened\n";
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'needs-human');
  const greenCall = fixture
    .readEvents()
    .find(
      (event): event is events.ActionEvent =>
        event.type === 'action' && event.vertex === 'green' && event.action === 'green',
    )!;
  assert.equal(greenCall.outcome, 'integrity-violation');
  assert.equal(greenCall.direction, 'stop');
  assert.deepEqual(greenCall.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] },
  ]);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-list', '--count', 'HEAD'), '2', 'no feat commit after the violation');
});

test('golden: a failed red is recovered once then fails at needs-human with its work in place', async (t) => {
  const responses = firstVisit.firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  // The new test passes before any implementation exists, both times.
  suiteRuns.answerAll(fixture, () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }));
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    tddTrace(fixture).map((event) => `${event.action}/${event.recovery}`),
    ['red/0', 'red-check/0', 'red/1', 'red-check/1'],
  );
  assert.equal(fixture.harness.calls.length, 2);
  assert.equal(fixture.harness.calls[1].resume, 'fake-session-1', 'the recovery pass resumes the red session');
  const exhausted = actionEvent(fixture, 'red', 'red-check', 1);
  assert.equal(exhausted!.outcome, 'failed');
  assert.deepEqual(
    exhausted!.rule,
    { table: 'failed', row: null },
    'no failed row and no otherwise: the engine Outcome failed',
  );
  assert.equal(exhausted!.direction, 'stop');
  assert.deepEqual(
    actionEvent(fixture, 'red', 'red-check')!.rule,
    { table: 'fixed', row: 'recover' },
    'the first failing run recovers',
  );
  assert.equal(
    gitShell.sh(fixture.worktree, 'rev-list', '--count', `${fixture.base}..HEAD`),
    '0',
    'no commit on the branch',
  );
  assert.equal(
    gitShell.sh(fixture.worktree, 'status', '--porcelain'),
    '?? test/',
    "the agent's test stays in the worktree for the human",
  );
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), [], 'nothing is reset');
  assert.deepEqual(fixture.executionRecord.history, []);
  assert.deepEqual(writeAhead.openIntents(fixture.executionRecord), []);
  assert.equal((fixture.readEvents().at(-1) as events.TicketEndEvent).outcome, 'needs-human');

  const reason = terminalReasonOf(fixture);
  assert.deepEqual(reason.decidedBy, { vertex: 'red', visit: 1, action: 'red-check', recovery: 1 });
  assert.equal(reason.outcome, 'failed');
  assert.deepEqual(reason.rule, { table: 'failed', row: null });
  assert.equal(reason.text, 'The tests-fail Check red-check failed with no recovery left.');
  assert.match(
    fixture.gh.comments[0].body,
    /```\nThe new tests did not fail before implementation/,
    'the diagnosis is posted fenced',
  );
});

test('an ignored test file already there at the baseline is not a changed test', async (t) => {
  const responses = firstVisit.firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  responses[RED_CALL].files = {};
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  // Build output under a test glob, ignored and left from before the Visit; red writes no test, in either pass.
  writeFileSync(
    resolve(fixture.worktree, gitShell.sh(fixture.worktree, 'rev-parse', '--git-path', 'info/exclude')),
    'test/cache/\n',
  );
  mkdirSync(join(fixture.worktree, 'test', 'cache'), { recursive: true });
  writeFileSync(join(fixture.worktree, 'test', 'cache', 'out.json'), '{}\n');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(fixture, 'red', 'red-check')!.outcome, 'recover', 'no test changed is recoverable (K7)');
  assert.equal(actionEvent(fixture, 'red', 'red-check', 1)!.outcome, 'failed');
  assert.deepEqual(fixture.shells, [], 'no test changed, so the test command never ran');
});

test('an ignored test file already there at the baseline counts once the Visit changes it', async (t) => {
  const responses = firstVisit.firstVisitWith();
  // red rewrites the ignored test file that was there before the Visit, and writes no other.
  responses[RED_CALL].files = { 'test/cache/out.json': '{"changed":true}\n' };
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  writeFileSync(
    resolve(fixture.worktree, gitShell.sh(fixture.worktree, 'rev-parse', '--git-path', 'info/exclude')),
    'test/cache/\n',
  );
  mkdirSync(join(fixture.worktree, 'test', 'cache'), { recursive: true });
  writeFileSync(join(fixture.worktree, 'test', 'cache', 'out.json'), '{}\n');
  await interpreter.runExecution(fixture.options);

  assert.equal(actionEvent(fixture, 'red', 'red-check')!.outcome, 'ok');
  assert.equal(fixture.shells[0].command, 'npm test', 'the changed test made the Red Check run the test command');
});

test('uncommitted changes before red are held at needs-human and nothing is deleted', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const [tracked] = gitShell.sh(fixture.worktree, 'ls-files').split('\n');
  writeFileSync(join(fixture.worktree, tracked!), 'a human edit\n');
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'untracked human work\n');
  const before = gitShell.sh(fixture.worktree, 'status', '--porcelain', '--untracked-files=all');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.equal(
    gitShell.sh(fixture.worktree, 'status', '--porcelain', '--untracked-files=all'),
    before,
    'every pre-existing change survives',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), fixture.base);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(fixture.executionRecord.history.at(-1)?.kind, 'held');
  const reason = terminalReasonOf(fixture);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.equal(reason.outcome, null);
  assert.equal(reason.rule, null);
  assert.match(reason.text, /uncommitted changes before red/);
});

test('an assume-unchanged edit before red is held too, so a rollback cannot reset it away', async (t) => {
  const responses = firstVisit.firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  suiteRuns.answerAll(fixture, () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }));
  const [tracked] = gitShell.sh(fixture.worktree, 'ls-files').split('\n');
  gitShell.sh(fixture.worktree, 'update-index', '--assume-unchanged', tracked!);
  writeFileSync(join(fixture.worktree, tracked!), 'a hidden human edit\n');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(readFileSync(join(fixture.worktree, tracked!), 'utf8'), 'a hidden human edit\n');
});

// An Integrity Violation resets whatever its Agent's access, so a read-only red Vertex starts only on a clean worktree
// too.
test('a read-only red Vertex is held before unknown changes, so a rollback cannot reset them away', async (t) => {
  const responses = firstVisit.firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  responses[RED_CALL].files = {};
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  golden.configure(fixture, (configured) => {
    configured.flows.golden.ticket.vertices.red!.access = 'read-only';
  });
  suiteRuns.answerAll(fixture, () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }));
  const [tracked] = gitShell.sh(fixture.worktree, 'ls-files').split('\n');
  writeFileSync(join(fixture.worktree, tracked!), 'a human edit\n');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(readFileSync(join(fixture.worktree, tracked!), 'utf8'), 'a human edit\n');
});
