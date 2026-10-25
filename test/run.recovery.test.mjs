import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gitModule from '../lib/git.mjs';
import * as github from '../lib/github.mjs';
import * as interpreter from '../lib/interpreter.mjs';
import * as marker from '../lib/marker.mjs';
import * as record from '../lib/record.mjs';
import * as run from '../lib/run.mjs';
import * as golden from './support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, markerOf, ticketResult, conflict, failComment,
  endsOf, lastRun, loadTicket, dirtyTicket,
} from './support/run.mjs';

test('agent-made dirty state proven by the record is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  // The red test passes before implementation, so the red Phase fails; the crash comes before its reset.
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
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
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
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
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('an ignored test added after an interrupted reset is held, not deleted', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // An ignored file leaves HEAD and the tree as the agent left them, so only the saved ignored files can tell it apart.
  writeFileSync(join(f.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  writeFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'mine\n');
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('a human change staged after an interrupted reset is held, not discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
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
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('an interrupted reset whose intent predates the index fingerprint is held', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  const seeded = await seedExecution(f, { git, exec });
  delete record.openIntents(seeded)[0].payload.left.index;
  await record.save(seeded);
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('a Run resumes a partial restore without repeating the agent call', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  // The agent changes an ignored Protected File and adds another: an Integrity Violation, whose rollback restores both.
  Object.assign(responses['implementer/1/red/1'].files, { '.claude/settings.local.json': '{"agent":true}\n', '.claude/agent.json': '{}\n' });
  const f = fixture(t, { responses, labels: [IN_PROGRESS], integrity: 'real' });
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  mkdirSync(join(f.worktree, '.claude'));
  writeFileSync(join(f.worktree, '.claude', '.gitignore'), '*\n');
  writeFileSync(join(f.worktree, '.claude', 'settings.local.json'), '{"owner":true}\n');
  let reset = false;
  const git = { ...gitModule, resetTo: async (...args) => { await gitModule.resetTo(...args); reset = true; } };
  // Crashed after the extra is removed and the changed file deleted, before its rewrite.
  const restore = golden.crashFs(t, f.worktree, () => reset, { op: 'rm', n: 2, after: true });
  const seeded = await seedExecution(f, { git });
  restore();
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

test('an admission failure on an active execution is reported as a fault', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
  let adds = 0;
  f.options.git = { ...gitModule, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full') } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
  assert.match(ticketResult(results).error, /disk full/);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'fault', 'the record is marked, so it is not retried');
  assert.equal(final.execution, seeded.execution);
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'push'), record.openIntents(seeded), 'the earlier intent is kept');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('disk full')), `a comment carries the error: ${JSON.stringify(f.comments())}`);
  assert.match(f.readEvents().find((e) => e.type === 'ticket_end' && e.ticket === TICKET).error, /disk full/);
  assert.ok(f.readEvents().some((e) => e.type === 'ticket_start' && e.run === lastRun(f) && e.execution === seeded.execution));

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is not retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
});

test('a dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  for (const seeded of [false, true]) {
    const { f, seededRec } = await dirtyTicket(t, seeded);
    const agentCalls = f.harness.calls.length;
    const status = sh(f.worktree, 'status', '--porcelain');
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const failing = failComment(f);

    const first = await run.runTarget(f.options);
    assert.equal(run.runExitCode(first), 1, `seeded ${seeded}: ${JSON.stringify(first)}`);
    assert.match(ticketResult(first).error, /HTTP 502/);
    const mid = await loadTicket(f);
    assert.equal(mid?.terminalReason?.decidedBy.hold, 'dirty-worktree', 'the hold is decided durably');
    assert.equal(mid.cursor.vertex, 'needs-human');
    assert.equal(mid.terminalStop?.held, true);
    const [open, ...more] = record.openIntents(mid).filter((e) => e.action === 'comment');
    assert.ok(open && !more.length, 'the hold comment intent stays open');
    assert.deepEqual(record.openIntents(mid).filter((e) => e.action !== 'comment'), seeded ? record.openIntents(seededRec) : [],
      'older intents are unchanged');
    assert.deepEqual(f.comments(), []);
    assert.equal(endsOf(f, mid.execution).length, 0, 'the hold has not landed');
    assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);
    assert.equal(f.gh.labels.has(IN_PROGRESS), seeded, 'a seeded in-progress label is kept until the hold lands');

    failing.on = false;
    const second = await run.runTarget(f.options);
    assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
    const final = await loadTicket(f);
    assert.equal(final.execution, mid.execution);
    assert.equal(final.state, 'held');
    assert.equal(f.comments().length, 1, 'exactly one hold comment');
    assert.ok(f.comments()[0].includes(marker.markerComment(open.marker)), 'the comment carries the original Action Marker');
    assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
    assert.deepEqual(record.openIntents(final).filter((e) => ['comment', 'label'].includes(e.action)), []);
    const ends = endsOf(f, final.execution);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].reason, mid.terminalReason);
    assert.equal(ends[0].run, lastRun(f));
    assert.equal(f.harness.calls.length, agentCalls, 'no agent ran');
    assert.equal(sh(f.worktree, 'status', '--porcelain'), status, 'the worktree is untouched');
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed or reset');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), '', 'nothing was pushed');
  }
});

test('a resumed pending report emits no second ticket_start', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const failing = failComment(f);
  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  failing.on = false;

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const { execution } = await loadTicket(f);
  assert.equal(f.readEvents().filter((e) => e.type === 'ticket_start' && e.execution === execution).length, 1);
  assert.equal(endsOf(f, execution).length, 1);
});

test('fixing the worktree while a hold comment is pending still finishes the hold', async (t) => {
  for (const seeded of [false, true]) {
    const { f } = await dirtyTicket(t, seeded);
    const agentCalls = f.harness.calls.length;
    const failing = failComment(f);
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
    const mid = await loadTicket(f);
    failing.on = false;
    rmSync(join(f.worktree, 'human.txt'));

    assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'the pending hold finishes, not the Ticket');
    const held = await loadTicket(f);
    assert.equal(held.execution, mid?.execution);
    assert.equal(held.state, 'held');
    assert.equal(f.comments().length, 1);
    assert.equal(endsOf(f, held.execution).length, 1);
    assert.equal(f.harness.calls.length, agentCalls, 'no agent ran');

    f.gh.labels.delete(NEEDS_HUMAN);
    const third = await run.runTarget(f.options);
    if (seeded) {
      assert.equal(ticketResult(third).outcome, 'skipped', 'a held Execution with Visits needs its row deleted');
      assert.equal(f.harness.calls.length, agentCalls);
    } else {
      assert.equal(run.runExitCode(third), 0, JSON.stringify(third));
      assert.notEqual((await loadTicket(f)).execution, mid.execution, 'a fresh hold restarts as a new Execution');
      assert.equal(f.harness.calls.length, 2);
    }
  }
});

test('a landed hold comment with a lost response is not posted twice', async (t) => {
  const { f } = await dirtyTicket(t, false);
  failComment(f, { lost: true });
  // The retry looks for the comment by its marker first, so the hold lands within the Run.
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the marker found it, so it was not posted again');
  assert.equal(f.gh.calls.filter((c) => golden.isCommentPost(c.args)).length, 1);
  const final = await loadTicket(f);
  const comment = final.log.find((e) => e.step === 'intent' && e.action === 'comment');
  assert.deepEqual(final.log.filter((e) => e.marker === comment.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.equal(final.log.find((e) => e.marker === comment.marker && e.step === 'evidence').evidence.id, f.gh.comments[0].id);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'held');
});

test('an ensureWorktree failure without a record is marked and never retried', async (t) => {
  const f = fixture(t);
  let adds = 0;
  f.options.git = { ...gitModule, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.match(ticketResult(results).error, /disk full/);
  const rec = await loadTicket(f);
  assert.equal(rec?.state, 'fault', 'the fault is marked on a record created for it');
  assert.equal(rec.branch, BRANCH);
  assert.equal(rec.worktree, f.worktree);
  assert.ok(f.comments().some((b) => b.includes('disk full')), JSON.stringify(f.comments()));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  assert.ok(!f.labelAdds().includes(IN_PROGRESS), 'in-progress is never set');
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.phase} ${e.ordinal}` : e.type)), ['ticket_start', 'fault 1', 'fault 2', 'ticket_end']);
  assert.ok(evs.every((e) => e.execution === rec.execution));
  assert.match(evs.at(-1).error, /disk full/);
  assert.equal(f.harness.calls.length, 0);

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is never retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
  assert.equal(run.runExitCode(second), 2);
});

test('admission holds emit ticket lifecycle events with their Terminal Reason', async (t) => {
  const ensure = (f) => gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  for (const [hold, arrange] of [
    ['dirty-worktree', async (f) => { await ensure(f); writeFileSync(join(f.worktree, 'notes.txt'), 'mine\n'); }],
    ['merge-conflict', async (f) => { await ensure(f); conflict(f.worktree); }],
    ['branch-mismatch', async (f) => { await ensure(f); sh(f.worktree, 'checkout', '-q', '-b', 'ticket/99-other'); }],
    ['branch-mismatch', async (f) => record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null,
      flow: { name: 'default', entry: 'implementer' }, configHash: 'x', run: 'seed', worktree: f.worktree, branch: 'ticket/99-other', base: 'main' }))],
  ]) {
    const f = fixture(t, { integrity: 'real' });
    await arrange(f);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, `${hold}: ${JSON.stringify(results)}`);
    const rec = await loadTicket(f);
    assert.equal(rec?.terminalReason?.decidedBy.hold, hold);
    assert.equal(rec.state, 'held');
    const evs = f.readEvents().filter((e) => e.ticket === TICKET);
    assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.vertex} ${e.phase} ${e.ordinal}` : e.type)),
      ['ticket_start', 'needs-human hold 1', 'needs-human hold 2', 'ticket_end'], hold);
    assert.ok(evs.every((e) => e.execution === rec.execution && e.run === lastRun(f)), 'one Execution and Run throughout');
    assert.equal(evs.at(-1).outcome, 'needs-human');
    assert.deepEqual(evs.at(-1).reason, rec.terminalReason);
    assert.doesNotMatch(rec.terminalReason.text, /re-run|DELETE FROM/, 'the Terminal Reason is one sentence; the advice is in the comment');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
  }
});

test('a hold label failure leaves its label intent open for the next Run', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const inner = f.gh.gh;
  let failing = true;
  github.setGh(async (args, cwd, input) => {
    if (failing && args[0] === 'issue' && args[1] === 'edit' && args.includes(NEEDS_HUMAN)) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
    }
    return inner(args, cwd, input);
  });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET));
  const mid = await loadTicket(f);
  assert.deepEqual(record.openIntents(mid ?? { log: [] }).map((e) => e.action), ['label'], 'the label intent stays open');
  assert.equal(endsOf(f, mid.execution).length, 0);

  failing = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is reused');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  const final = await loadTicket(f);
  assert.deepEqual(record.openIntents(final), []);
  assert.equal(final.state, 'held');
  assert.equal(endsOf(f, final.execution).length, 1);
});
