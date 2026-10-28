import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, conflict, lastRun, loadTicket,
} from '../support/run.mjs';

test('agent-made dirty state proven by the record is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'red/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  // The red test passes before implementation, so the red Phase fails; the crash comes before its reset.
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  const seeded = await seedExecution(f, { git, exec });
  assert.deepEqual(record.openIntents(seeded).map((e) => e.action), ['reset'], 'the record holds the decided reset');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), "the agent's test is still in the worktree");
  f.options.exec = exec;

  await run.runTarget(f.options);
  assert.equal(sh(f.worktree, 'status', '--porcelain'), '', "the agent's changes are discarded");
  assert.equal(f.harness.calls.length, 2, 'no agent call is repeated');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.notEqual(final.state, 'held', 'the Ticket is not held for its own agent changes');
  assert.equal(final.state, 'needs-human', 'the Ticket runs on to the Terminal of its failed red');
  assert.deepEqual(final.history.map((h) => h.kind), ['red phase failed']);
  assert.deepEqual(record.openIntents(final), []);
});

test('changes made after an interrupted reset are held, not discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'red/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // A human works in the worktree after the crash, on top of what the agent left.
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('human.txt')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('an ignored test added after an interrupted reset is held, not deleted', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'red/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // An ignored file leaves HEAD and the tree as the agent left them, so only the saved ignored files can tell it apart.
  writeFileSync(join(f.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  writeFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'mine\n');
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('a human change staged after an interrupted reset is held, not discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'red/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // Staged, then the working-tree bytes put back: HEAD and the worktree match what the agent left, only the index differs.
  const pkg = join(f.worktree, 'package.json');
  const original = readFileSync(pkg, 'utf8');
  writeFileSync(pkg, '{ "human": true }\n');
  sh(f.worktree, 'add', 'package.json');
  writeFileSync(pkg, original);
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(sh(f.worktree, 'show', ':package.json'), '{ "human": true }', 'the staged human content survives');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('an interrupted reset whose intent predates the index fingerprint is held', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'red/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  const seeded = await seedExecution(f, { git, exec });
  delete record.openIntents(seeded)[0].payload.left.index;
  await record.save(seeded);
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('a Run resumes a partial restore without repeating the agent call', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  // The agent changes an ignored Protected File and adds another: an Integrity Violation, whose rollback restores both.
  Object.assign(responses['red/1/red/1'].files, { '.claude/settings.local.json': '{"agent":true}\n', '.claude/agent.json': '{}\n' });
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  mkdirSync(join(f.worktree, '.claude'));
  writeFileSync(join(f.worktree, '.claude', '.gitignore'), '*\n');
  writeFileSync(join(f.worktree, '.claude', 'settings.local.json'), '{"owner":true}\n');
  let reset = false;
  const git = { ...f.options.git, resetTo: async (...args) => { await f.options.git.resetTo(...args); reset = true; } };
  // Crashed after the extra is removed and the changed file deleted, before its rewrite.
  const crashing = integrity.withGit(git, golden.crashFs(f.worktree, () => reset, { op: 'rm', n: 2, after: true }));
  const seeded = await seedExecution(f, { git, integrity: crashing });
  assert.ok(!existsSync(join(f.worktree, '.claude', 'settings.local.json')), 'the crash came mid-restore');
  assert.deepEqual(record.openIntents(seeded).map((e) => e.action), ['reset']);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 1, 'no agent call is repeated');
  assert.equal(readFileSync(join(f.worktree, '.claude', 'settings.local.json'), 'utf8'), '{"owner":true}\n');
  assert.ok(!existsSync(join(f.worktree, '.claude', 'agent.json')), 'the extra stays removed');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'needs-human', 'the Ticket runs on to the Terminal of its Integrity Violation');
  assert.deepEqual(final.history.map((h) => h.kind), ['integrity violation']);
  const reset1 = final.log.filter((e) => e.action === 'reset').map((e) => e.step);
  assert.deepEqual(reset1, ['intent', 'evidence', 'complete']);
});

// The Events and Terminal Reason of an admission hold `hold`, decided before any agent ran.
async function assertAdmissionHoldEvents(f, results, hold) {
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  const rec = await loadTicket(f);
  assert.equal(rec?.terminalReason?.decidedBy.hold, hold);
  assert.equal(rec.state, 'held');
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.vertex} ${e.phase} ${e.ordinal}` : e.type)),
    ['ticket_start', 'needs-human hold 1', 'needs-human hold 2', 'ticket_end']);
  assert.ok(evs.every((e) => e.execution === rec.execution && e.run === lastRun(f)), 'one Execution and Run throughout');
  assert.equal(evs.at(-1).outcome, 'needs-human');
  assert.deepEqual(evs.at(-1).reason, rec.terminalReason);
  assert.doesNotMatch(rec.terminalReason.text, /re-run|DELETE FROM/, 'the Terminal Reason is one sentence; the advice is in the comment');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
}

test('admission holds emit ticket lifecycle events with their Terminal Reason: a dirty worktree', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  writeFileSync(join(f.worktree, 'notes.txt'), 'mine\n');

  await assertAdmissionHoldEvents(f, await run.runTarget(f.options), 'dirty-worktree');
});

test('admission holds emit ticket lifecycle events with their Terminal Reason: a merge conflict', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  conflict(f.worktree);

  await assertAdmissionHoldEvents(f, await run.runTarget(f.options), 'merge-conflict');
});

test('admission holds emit ticket lifecycle events with their Terminal Reason: a worktree on another branch', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  sh(f.worktree, 'checkout', '-q', '-b', 'ticket/99-other');

  await assertAdmissionHoldEvents(f, await run.runTarget(f.options), 'branch-mismatch');
});
