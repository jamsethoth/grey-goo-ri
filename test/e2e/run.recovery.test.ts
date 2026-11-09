import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as admissionHoldEvents from '../support/admission-hold-events.ts';
import * as golden from '../support/golden.ts';
import * as executionContext from '../support/execution-context.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as crashFs from '../support/crash-fs.ts';
import * as resetInterruption from '../support/reset-interruption.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
type RunFixture = runFixture.RunFixture;

const addWorktree = (fixture: RunFixture) =>
  fixture.options.deps.git.ensureWorktree({
    mainRoot: fixture.mainRoot,
    path: fixture.worktree,
    branch: BRANCH,
    base: 'main',
  });

// An Execution whose red wrote a Protected File, an Integrity Violation, and whose reset crashed before it ran.
async function interruptedReset(t: TestContext) {
  const responses = structuredClone(golden.firstVisitResponses);
  (responses['red/1/red/1']?.files as Record<string, string>)['.agents/injected.json'] = '{}\n';
  const fixture = runFixture.fixture(t, { responses, labels: [IN_PROGRESS_LABEL], integrity: 'real', git: 'real' });
  const git = resetInterruption.crashingReset(fixture.options.deps.git);
  const seeded = await runFixture.seedExecution(fixture, { git });
  return { fixture, seeded };
}
const agentTestKept = (fixture: RunFixture) => existsSync(join(fixture.worktree, 'test', 'add.test.mjs'));

test('agent-made dirty state proven by the record is discarded', async (t) => {
  const { fixture, seeded } = await interruptedReset(t);
  assert.deepEqual(
    writeAhead.openIntents(seeded).map((entry) => entry.effect),
    ['reset'],
    'the record holds the decided reset',
  );
  assert.ok(agentTestKept(fixture), "the agent's test is still in the worktree");

  await run.runTarget(fixture.options);
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), '', "the agent's changes are discarded");
  assert.equal(fixture.harness.calls.length, 1, 'no agent call is repeated');
  const final = executionReads.loadTicket(fixture, TICKET);
  assert.notEqual(final.state, 'held', 'the Ticket is not held for its own agent changes');
  assert.equal(final.state, 'needs-human', 'the Ticket runs on to the Terminal of its Integrity Violation');
  assert.deepEqual(
    final.history.map((item) => item.kind),
    ['integrity violation'],
  );
  assert.deepEqual(writeAhead.openIntents(final), []);
});

test('changes made after an interrupted reset are held, not discarded', async (t) => {
  const { fixture } = await interruptedReset(t);
  // A human works in the worktree after the crash, on top of what the agent left.
  writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(fixture.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(agentTestKept(fixture), 'nothing was discarded');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.ok(
    fixture.comments().some((body) => body.includes('human.txt')),
    `a comment carries the diff stat: ${JSON.stringify(fixture.comments())}`,
  );
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded red');
});

test('an ignored test added after an interrupted reset is held, not deleted', async (t) => {
  const { fixture } = await interruptedReset(t);
  // An ignored file leaves HEAD and the tree as the agent left them, so only the saved ignored files can tell it apart.
  writeFileSync(join(fixture.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  writeFileSync(join(fixture.worktree, 'test', 'human.test.mjs'), 'mine\n');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(
    readFileSync(join(fixture.worktree, 'test', 'human.test.mjs'), 'utf8'),
    'mine\n',
    'the human file is untouched',
  );
  assert.ok(agentTestKept(fixture), 'nothing was discarded');
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded red');
});

test('a human change staged after an interrupted reset is held, not discarded', async (t) => {
  const { fixture } = await interruptedReset(t);
  // Staged, then the working-tree bytes put back: HEAD and the worktree match what the agent left, only the index
  // differs.
  const pkg = join(fixture.worktree, 'package.json');
  const original = readFileSync(pkg, 'utf8');
  writeFileSync(pkg, '{ "human": true }\n');
  gitShell.sh(fixture.worktree, 'add', 'package.json');
  writeFileSync(pkg, original);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(
    gitShell.sh(fixture.worktree, 'show', ':package.json'),
    '{ "human": true }',
    'the staged human content survives',
  );
  assert.ok(agentTestKept(fixture), 'nothing was discarded');
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded red');
});

test('an interrupted reset whose intent predates the index fingerprint is held', async (t) => {
  const { fixture, seeded } = await interruptedReset(t);
  delete (writeAhead.openIntents(seeded)[0]?.payload as { left: { index?: string } }).left.index;
  record.save(seeded);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.ok(agentTestKept(fixture), 'nothing was discarded');
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded red');
});

test('a Run resumes a partial restore without repeating the agent call', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  // The agent changes an ignored Protected File and adds another: an Integrity Violation, whose rollback restores both.
  Object.assign(responses['red/1/red/1']?.files as Record<string, string>, {
    '.claude/settings.local.json': '{"agent":true}\n',
    '.claude/agent.json': '{}\n',
  });
  const fixture = runFixture.fixture(t, { responses, labels: [IN_PROGRESS_LABEL], integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  mkdirSync(join(fixture.worktree, '.claude'));
  writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
  writeFileSync(join(fixture.worktree, '.claude', 'settings.local.json'), '{"owner":true}\n');
  const noted = resetInterruption.notedReset(fixture.options.deps.git);
  // Crashed after the extra is removed and the changed file deleted, before its rewrite.
  const crashing = integrity.createIntegrity(
    noted.git,
    crashFs.crashFs(fixture.worktree, noted.reset, { op: 'rm', path: '.claude/settings.local.json', after: true }),
  );
  const seeded = await runFixture.seedExecution(fixture, { git: noted.git, integrity: crashing });
  assert.ok(!existsSync(join(fixture.worktree, '.claude', 'settings.local.json')), 'the crash came mid-restore');
  assert.deepEqual(
    writeAhead.openIntents(seeded).map((entry) => entry.effect),
    ['reset'],
  );

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 1, 'no agent call is repeated');
  assert.equal(readFileSync(join(fixture.worktree, '.claude', 'settings.local.json'), 'utf8'), '{"owner":true}\n');
  assert.ok(!existsSync(join(fixture.worktree, '.claude', 'agent.json')), 'the extra stays removed');
  const final = executionReads.loadTicket(fixture, TICKET);
  assert.equal(final.state, 'needs-human', 'the Ticket runs on to the Terminal of its Integrity Violation');
  assert.deepEqual(
    final.history.map((item) => item.kind),
    ['integrity violation'],
  );
  const resetSteps = final.writeAheadLog.filter((entry) => entry.effect === 'reset').map((entry) => entry.step);
  assert.deepEqual(resetSteps, ['intent', 'evidence', 'complete']);
});

test('admission holds emit ticket lifecycle events with their Terminal Reason: a dirty worktree', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'mine\n');

  await admissionHoldEvents.assertAdmissionHoldEvents(fixture, await run.runTarget(fixture.options), 'dirty-worktree');
});

test('admission holds emit ticket lifecycle events with their Terminal Reason: a merge conflict', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  runFixture.conflict(fixture.worktree);

  await admissionHoldEvents.assertAdmissionHoldEvents(fixture, await run.runTarget(fixture.options), 'merge-conflict');
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('admission holds emit ticket lifecycle events with their Terminal Reason: a worktree on another branch', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  gitShell.sh(fixture.worktree, 'checkout', '-q', '-b', 'ticket/99-other');

  await admissionHoldEvents.assertAdmissionHoldEvents(fixture, await run.runTarget(fixture.options), 'branch-mismatch');
});
