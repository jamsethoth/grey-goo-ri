import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as github from '../../lib/github.mjs';
import * as integrity from '../../lib/integrity.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, fixture, seedExecution, markerOf, holdLock, ticketResult, failComment,
  endsOf, loadTicket, dirtyTicket, failHoldLabel,
} from '../support/run.mjs';

test('a seeded hold label failure is finished on the next Run', async (t) => {
  const { f } = await dirtyTicket(t, true);
  const failing = failHoldLabel(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  const mid = await loadTicket(f);
  assert.deepEqual(record.openIntents(mid).filter((e) => ['comment', 'label'].includes(e.action)).map((e) => e.action), ['label']);
  assert.equal(endsOf(f, mid.execution).length, 0);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is reused');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
  const final = await loadTicket(f);
  assert.equal(final.execution, mid.execution);
  assert.deepEqual(record.openIntents(final).filter((e) => ['comment', 'label'].includes(e.action)), []);
  assert.equal(final.state, 'held');
  assert.equal(endsOf(f, final.execution).length, 1);
});

test('a pending hold is not marked held', async (t) => {
  for (const pending of ['comment', 'label']) {
    for (const seeded of [false, true]) {
      const { f } = await dirtyTicket(t, seeded);
      const failing = pending === 'comment' ? failComment(f) : failHoldLabel(f);
      assert.equal(run.runExitCode(await run.runTarget(f.options)), 1, `${pending}, seeded ${seeded}`);
      const mid = await loadTicket(f);
      assert.equal(mid.terminalStop?.held, true, `${pending}, seeded ${seeded}: the hold is decided`);
      assert.notEqual(mid.state, 'held', `${pending}, seeded ${seeded}: a hold whose ${pending} is pending is not held`);
      failing.on = false;
      assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
      assert.equal((await loadTicket(f)).state, 'held', `${pending}, seeded ${seeded}: held once it lands`);
    }
  }
});

test('human override abandons a pending hold before any label cleanup', async (t) => {
  for (const cleanupFails of [false, true]) {
    const { f, seededRec } = await dirtyTicket(t, true);
    const before = await integrity.snapshot(f.worktree, f.options.git);
    const failing = failComment(f);
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
    const mid = await loadTicket(f);
    const [holdComment] = record.openIntents(mid).filter((e) => e.action === 'comment');
    failing.on = false;
    f.gh.labels.add(NEEDS_HUMAN);
    const inner = f.gh.gh;
    const states = [];
    let failEdit = cleanupFails;
    github.setGh(async (args, cwd, input) => {
      if (args[0] === 'issue' && args[1] === 'edit') {
        states.push(JSON.parse(f.loadRow()).terminalStop?.abandoned);
        if (failEdit) {
          f.gh.calls.push({ args, cwd, input });
          throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
        }
      }
      return inner(args, cwd, input);
    });

    let results = await run.runTarget(f.options);
    if (cleanupFails) {
      assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
      const pending = await loadTicket(f);
      assert.equal(pending.terminalStop?.abandoned, true, 'the abandonment is decided durably');
      assert.equal(pending.state, 'active', 'its final state lands with ticket_end');
      assert.equal(endsOf(f, mid.execution).length, 0, 'the abandonment has not landed');
      failEdit = false;
      results = await run.runTarget(f.options);
    }
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.equal(ticketResult(results).outcome, 'abandoned');
    assert.ok(states.length && states.every((s) => s === true), `abandoned before any label cleanup: ${JSON.stringify(states)}`);
    assert.deepEqual(f.comments(), [], 'the pending hold comment is not replayed');
    assert.deepEqual(f.labelAdds(), [], 'no label is added');
    assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
    const final = await loadTicket(f);
    assert.equal(final.state, 'abandoned');
    assert.match(final.terminalReason.text, /needs-human/);
    const ends = endsOf(f, final.execution);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'abandoned');
    assert.deepEqual(ends[0].reason, final.terminalReason);
    assert.ok(record.openIntents(final).some((e) => e.marker === holdComment.marker), 'the hold comment intent stays open, never replayed');
    assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seededRec), 'the older intent is kept');
    assert.deepEqual(final.log.filter((e) => e.step === 'intent' && e.action === 'label').map((e) => e.payload),
      [{ ticket: TICKET, add: [], remove: [IN_PROGRESS] }], 'the cleanup is one write-ahead label Action');
    assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
    assert.equal(f.harness.calls.length, 2, 'no agent ran');
  }
});

test('a pending fault report whose comment lookup fails stays pending and posts no second comment', async (t) => {
  const f = fixture(t);
  f.options.git = { ...f.options.git, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };
  const inner = f.gh.gh;
  let mode = 'crash';
  github.setGh(async (args, cwd, input) => {
    if (mode === 'crash' && golden.isCommentPost(args)) {
      await inner(args, cwd, input);
      throw new interpreter.CrashError('crash after the fault comment landed');
    }
    if (mode === 'lookup' && args[0] === 'api' && /issues\/\d+\/comments$/.test(args.at(-1))) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    }
    return inner(args, cwd, input);
  });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  const [open] = record.openIntents(mid ?? { log: [] }).filter((e) => e.action === 'comment');
  assert.ok(open, 'the landed fault comment waits for its completion');
  assert.equal(f.comments().length, 1);

  mode = 'lookup';
  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 1, JSON.stringify(second));
  assert.match(ticketResult(second).error, /HTTP 502/);
  assert.equal(f.comments().length, 1, 'the stored payload is not posted again');
  const still = await loadTicket(f);
  assert.deepEqual(still.terminalReason, mid.terminalReason, 'the fault keeps its Terminal Reason');
  assert.deepEqual(still.terminalStop, mid.terminalStop);
  assert.equal(endsOf(f, mid.execution).length, 0, 'the fault stays pending');

  mode = null;
  const third = await run.runTarget(f.options);
  assert.equal(run.runExitCode(third), 1, 'a fault exits 1');
  assert.equal(f.comments().length, 1, 'the marker found the landed comment');
  const final = await loadTicket(f);
  assert.deepEqual(final.log.filter((e) => e.marker === open.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'fault');
  assert.equal(endsOf(f, final.execution).length, 1);
  assert.match(endsOf(f, final.execution)[0].error, /disk full/);
});

test('a Terminal saved before ticket_end resumes finalization exactly once', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const db = record.openDb(f.commonDir);
  db.exec("CREATE TRIGGER fail_end BEFORE INSERT ON events WHEN NEW.type = 'ticket_end' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = await loadTicket(f);
  assert.equal(mid?.state, 'active', 'the final state rolled back with its ticket_end');
  assert.equal(mid.terminalStop?.held, true, 'the decided hold waits for the next Run');
  assert.equal(endsOf(f, mid.execution).length, 0);
  db.exec('DROP TRIGGER fail_end');
  const effects = () => f.gh.calls.filter((c) => golden.isCommentPost(c.args) || (c.args[0] === 'issue' && c.args[1] === 'edit')).length;
  const done = effects();

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2);
  assert.equal(ticketResult(second).outcome, 'needs-human', 'not skipped as finished');
  assert.equal(effects(), done, 'no GitHub effect is repeated');
  assert.equal(endsOf(f, mid.execution).length, 1);
  assert.equal(f.comments().length, 1);
});

test('a crash between admission and its hold keeps the decision and its one ticket_start', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const db = record.openDb(f.commonDir);
  // Every save carrying a Terminal stop fails, as if gg died once admission had saved the new record.
  db.exec(`CREATE TRIGGER fail_stop BEFORE UPDATE ON records WHEN NEW.json LIKE '%"terminalStop"%'
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  const first = await run.runTarget(f.options);
  db.exec('DROP TRIGGER fail_stop');
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = await loadTicket(f);
  assert.ok(mid, 'admission saved the record');
  assert.equal(mid.terminalStop, undefined, 'the hold was never saved');
  assert.equal(f.comments().length, 0);

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const starts = f.readEvents().filter((e) => e.type === 'ticket_start' && e.ticket === TICKET);
  assert.deepEqual(starts.map((e) => e.execution), [mid.execution], 'one ticket_start for the Execution');
  const final = await loadTicket(f);
  assert.equal(final.state, 'held');
  assert.equal(final.terminalStop.fresh, true, 'the hold is still the fresh one admission decided');
  const [comment, ...more] = f.comments();
  assert.equal(more.length, 0);
  assert.doesNotMatch(comment, /DELETE FROM records/, 'a fresh hold has no row to delete');
  assert.equal(endsOf(f, mid.execution).length, 1);
});

test('an Interrupted Attempt hold warns before its record is deleted, then and on the next Run', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const real = f.harness.run;
  f.harness.run = async () => {
    f.harness.run = real;
    throw new interpreter.CrashError('gg died during the call');
  };
  await seedExecution(f);
  const warning = /ignored Protected Files such as \.claude\/settings\.local\.json[^]*before deleting the record/;

  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 2, JSON.stringify(first));
  assert.equal((await loadTicket(f)).state, 'held');
  assert.match(f.comments().at(-1) ?? '', warning, 'the hold comment warns');

  await run.runTarget(f.options);
  const skipped = f.logs.findLast((l) => l.includes('skipped')) ?? '';
  assert.match(skipped, warning, 'the held-record skip warns too');
  assert.ok(skipped.search(warning) < skipped.indexOf('DELETE FROM records'), `the warning comes before the delete: ${skipped}`);
});

test('a human needs-human label before the first Visit prevents admission effects', async (t) => {
  for (const dirty of [false, true]) {
    const f = fixture(t, { git: 'real', labels: [IN_PROGRESS, NEEDS_HUMAN] });
    await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
    await record.save(rec);
    if (dirty) writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
    const before = await integrity.snapshot(f.worktree, f.options.git);

    const results = await run.runTarget(f.options);
    assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
    assert.equal(run.runExitCode(results), 2, 'a human needs-human label exits 2');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view'], ['issue', 'edit']], 'only the in-progress label is removed');
    assert.deepEqual([...f.gh.labels], [NEEDS_HUMAN], 'the human hold remains without in-progress');
    assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
    if (dirty) assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'abandoned', 'the label overrides the record before any Visit');
    assert.deepEqual(final.visits, {});
    assert.deepEqual(final.log.map((e) => `${e.step} ${e.action}`), ['intent label', 'evidence label', 'complete label'],
      'the cleanup is one write-ahead Action');
    assert.deepEqual(final.log[0].payload, { ticket: TICKET, add: [], remove: [IN_PROGRESS] });
    const evs = f.readEvents().filter((e) => e.ticket === TICKET);
    assert.deepEqual(evs.map((e) => e.type), ['ticket_start', 'action', 'ticket_end']);
    assert.equal(evs.at(-1).outcome, 'abandoned');
    assert.deepEqual(evs.at(-1).reason, final.terminalReason);
  }
});

test('a human needs-human label prevents admission effects without a readable record', async (t) => {
  for (const corrupt of [false, true]) {
    const f = fixture(t, { labels: [NEEDS_HUMAN] });
    if (corrupt) record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{');
    const row = f.loadRow();

    assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'needs-human exits 2 even without a readable record');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
    assert.equal(f.worktrees(), 1, 'no worktree created');
    assert.equal(f.loadRow(), row, 'the record is untouched');
  }
});

// GitHub matches label names case-insensitively, so a human's own spelling of a State Label is still that label.
const HUMAN_NEEDS_HUMAN = 'GG:State:Needs-Human';
const SHOUTED_IN_PROGRESS = 'GG:STATE:IN-PROGRESS';

test('mixed-case human needs-human wins before any label write', async (t) => {
  for (const inProgress of [SHOUTED_IN_PROGRESS, IN_PROGRESS, null]) {
    const f = fixture(t, { labels: [HUMAN_NEEDS_HUMAN, ...(inProgress ? [inProgress] : [])] });
    await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    const inner = f.gh.gh;
    const states = [];
    github.setGh(async (args, cwd, input) => {
      if (args[0] === 'issue' && args[1] === 'edit') states.push(JSON.parse(f.loadRow()).terminalStop?.abandoned);
      return inner(args, cwd, input);
    });

    const results = await run.runTarget(f.options);
    assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
    assert.equal(run.runExitCode(results), 2);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    const edits = f.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').map((c) => c.args.slice(3));
    assert.deepEqual(edits, inProgress ? [['--remove-label', IN_PROGRESS]] : [], 'only the in-progress label is removed');
    assert.deepEqual(states, inProgress ? [true] : [], 'the record is abandoned before the label write');
    assert.deepEqual(f.comments(), [], 'no comment posted');
    assert.deepEqual([...f.gh.labels], [HUMAN_NEEDS_HUMAN], 'the human hold keeps its spelling');
    assert.equal((await loadTicket(f)).state, 'abandoned');
  }
});

test('mixed-case needs-human skips without a readable record or with a held ticket lock', async (t) => {
  for (const kind of ['missing record', 'corrupt record', 'held lock']) {
    const f = fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
    if (kind === 'corrupt record') record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{');
    const row = f.loadRow();
    const holder = kind === 'held lock' && await holdLock(t, f.commonDir, `ticket-${TICKET}`);
    const results = await run.runTarget(f.options);
    if (holder) await holder.release();
    assert.equal(ticketResult(results).outcome, 'skipped', `${kind}: ${JSON.stringify(results)}`);
    assert.equal(ticketResult(results).state, 'needs-human', kind);
    assert.equal(run.runExitCode(results), 2, kind);
    assert.equal(f.harness.calls.length, 0, `${kind}: no agent started`);
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], `${kind}: no label write or comment`);
    assert.equal(f.worktrees(), 1, `${kind}: no worktree created`);
    assert.equal(f.loadRow(), row, `${kind}: the record is untouched`);
  }
});

test('admission does not re-add differently cased in-progress', async (t) => {
  const f = fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  f.options.config.labelPrefix = 'Gg';
  await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'the Execution resumes at its cursor');
  assert.equal((await loadTicket(f)).state, 'done');
  assert.deepEqual(f.labelAdds(), ['Gg:state:ready-for-qa'], 'in-progress is not added again');
  assert.ok(![...f.gh.labels].some((l) => l.toLowerCase() === IN_PROGRESS), `the Terminal removes it: ${[...f.gh.labels]}`);

  const stuck = fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  stuck.options.config.labelPrefix = 'Gg';
  assert.equal(run.runExitCode(await run.runTarget(stuck.options)), 0);
  assert.ok(stuck.logs.some((l) => l.includes('with no Execution Record behind it')), JSON.stringify(stuck.logs));
  assert.equal(stuck.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(stuck.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no write on a Stuck Ticket');
  assert.equal(stuck.worktrees(), 1, 'no worktree');
  assert.ok(stuck.gh.labels.has(SHOUTED_IN_PROGRESS), 'the State Label is left for Stuck handling');
});

test('an interrupted reset under a human needs-human label is abandoned before anything is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [NEEDS_HUMAN] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  f.options.exec = exec;

  await run.runTarget(f.options);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), "the agent's changes are kept for the human");
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'abandoned', 'the label overrides the record');
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.comments(), [], 'no comment posted');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('a resumed execution still needs its ticket open and unblocked', async (t) => {
  for (const issue of [{ blockedBy: [{ number: 3, state: 'OPEN' }] }, { state: 'CLOSED' }]) {
    const f = fixture(t, { labels: [IN_PROGRESS], issue });
    await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
    const row = f.loadRow();
    await run.runTarget(f.options);
    assert.equal(f.harness.calls.length, 2, `no agent started for ${JSON.stringify(issue)}`);
    assert.equal(f.loadRow(), row, 'the record is not resumed');
    assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /not ready/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  }
});
