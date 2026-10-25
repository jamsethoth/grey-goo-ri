import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as gitModule from '../lib/git.mjs';
import * as integrity from '../lib/integrity.mjs';
import { pathKey } from '../lib/paths.mjs';
import * as record from '../lib/record.mjs';
import * as run from '../lib/run.mjs';
import * as golden from './support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, markerOf, ticketResult, conflict,
  crashBeforeCommit,
} from './support/run.mjs';

test('a resumed execution on another Ticket branch or another branch of its Ticket is held before recovery', async (t) => {
  for (const branch of ['ticket/99-another-ticket', `ticket/${TICKET}-another-attempt`]) {
    const f = fixture(t, { labels: [IN_PROGRESS] });
    const seeded = await crashBeforeCommit(f);
    sh(f.worktree, 'checkout', '-q', '-b', branch);
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const before = await integrity.snapshot(f.worktree);
    const implementation = readFileSync(join(f.worktree, 'lib', 'add.mjs'), 'utf8');
    f.gh.calls.length = 0;

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(!f.gh.labels.has(IN_PROGRESS));
    assert.ok(f.comments().some((b) => b.includes(BRANCH) && b.includes(branch)), 'the hold names both branches');
    assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET} is held and cannot resume. Switch the worktree back to \`${BRANCH}\` or remove it.`)
      && b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)), `the hold says how to recover: ${JSON.stringify(f.comments())}`);
    assert.equal(f.harness.calls.length, 2, 'no agent started');
    assert.equal(sh(f.worktree, 'branch', '--show-current'), branch);
    assert.equal(sh(f.worktree, 'rev-parse', branch), head, 'the other branch did not advance');
    assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head, 'the recorded branch did not advance');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and worktree are untouched');
    assert.equal(readFileSync(join(f.worktree, 'lib', 'add.mjs'), 'utf8'), implementation, 'the implementation is kept');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'held');
    assert.equal(final.branch, BRANCH);
    assert.deepEqual(record.openIntents(final), record.openIntents(seeded), 'the intended commit is kept');
  }
});

test('fresh admission refuses another Ticket\'s branch without changing it', async (t) => {
  // ticket/150-* shares ticket 15's digits, so the prefix must end at the number.
  for (const branch of ['ticket/99-other', 'ticket/150-other', 'detached HEAD']) {
    const f = fixture(t);
    await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    if (branch === 'detached HEAD') sh(f.worktree, 'checkout', '-q', '--detach');
    else sh(f.worktree, 'checkout', '-q', '-b', branch);
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const before = await integrity.snapshot(f.worktree);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(f.comments().some((b) => b.includes(branch) && b.includes(`ticket/${TICKET}-*`)),
      `the hold names the actual and required branches: ${JSON.stringify(f.comments())}`);
    assert.ok(f.comments().some((b) => b.includes(`Switch the worktree back to a \`ticket/${TICKET}-*\` branch or remove it, then remove the ${NEEDS_HUMAN} label and re-run gg run ${TICKET}.`)),
      `the hold says how to recover: ${JSON.stringify(f.comments())}`);
    assert.ok(f.comments().every((b) => !b.includes('`detached HEAD`')), 'a detached HEAD is not shown as a branch name');
    const held = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(held?.state, 'held', 'the hold is recorded');
    assert.equal(held.branch, BRANCH, 'the record names the intended branch, never the one found');
    assert.equal(held.worktree, f.worktree);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.worktree, 'branch', '--show-current'), branch === 'detached HEAD' ? '' : branch);
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`), '', 'nothing was pushed');
  }
});

test('fresh admission reuses its Ticket branch after a title change', async (t) => {
  const branch = `ticket/${TICKET}-old-title`;
  const f = fixture(t, { branch, issue: { title: 'A new title' } });
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch, base: 'main' });

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).branch, branch);
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).split('\t')[0], sh(f.worktree, 'rev-parse', 'HEAD'));
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/ticket/${TICKET}-a-new-title`), '', 'no branch from the new title');
});

test('resume refuses a recorded branch belonging to another Ticket', async (t) => {
  const branch = 'ticket/99-other';
  for (const existing of [true, false]) {
    const f = fixture(t, { labels: [IN_PROGRESS] });
    if (existing) await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch, base: 'main' });
    const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch, base: 'main' });
    await record.intent(rec, 'seed-intent', 'commit', { message: 'red' });
    assert.equal(record.openIntents(rec).length, 1);
    const worktrees = f.worktrees();
    const before = existing && await integrity.snapshot(f.worktree);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(f.comments().some((b) => b.includes(branch) && b.includes(`ticket/${TICKET}-*`)),
      `the hold names the recorded and required branches: ${JSON.stringify(f.comments())}`);
    assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET} is held and cannot resume.`)
      && b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)), `the hold says how to recover: ${JSON.stringify(f.comments())}`);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(f.worktrees(), worktrees, 'no worktree was created or removed');
    assert.equal(existsSync(f.worktree), existing, 'a missing worktree is not recreated');
    if (existing) {
      assert.equal(sh(f.worktree, 'branch', '--show-current'), branch);
      assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
    } else assert.equal(sh(f.mainRoot, 'branch', '--list', branch), '', 'the foreign branch was not created');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'held');
    assert.equal(final.branch, branch);
    assert.deepEqual(record.openIntents(final), record.openIntents(rec), 'the outstanding intent is kept');
  }
});


test('admission detects an agent overwrite of an idle sibling as an Integrity Violation', async (t) => {
  const other = 'ticket/99-other';
  // A second branch of this same Ticket is another worktree too, not the one being admitted.
  for (const [seeded, siblingRecord, siblingBranch = other] of [[false, false], [false, true], [true, false], [true, true],
    [false, false, `ticket/${TICKET}-other-suffix`]]) {
    const responses = structuredClone(golden.firstVisitResponses);
    const f = fixture(t, { responses, labels: seeded ? [IN_PROGRESS] : [], integrity: 'real' });
    // Outside the configured worktree root, so only git's worktree list can find it.
    const sibling = join(f.root, 'elsewhere', 'ticket-99');
    sh(f.mainRoot, 'worktree', 'add', '-q', '-b', siblingBranch, sibling, 'main');
    if (siblingRecord) {
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: 99, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: sibling, branch: other, base: 'main' }));
    }
    if (seeded) {
      await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    }
    responses['implementer/1/red/1'].files[relative(f.worktree, join(sibling, 'package.json'))] = '{ "overwritten": true }\n';

    const results = await run.runTarget(f.options);
    const label = JSON.stringify({ seeded, siblingRecord, siblingBranch });
    assert.equal(run.runExitCode(results), 2, `${label} ${JSON.stringify(results)}`);
    const red = f.readEvents().find((e) => e.type === 'action' && e.ticket === TICKET && e.phase === 'red' && e.agent);
    assert.equal(red?.outcome, 'integrity-violation', label);
    assert.equal(red.rule, 'integrity-violation');
    assert.ok(red.violations.some((v) => pathKey(v.worktree) === pathKey(sibling) && v.surface === 'tree'), JSON.stringify(red.violations));
    assert.equal(f.harness.calls.length, 1, 'no agent call after the violation');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), '', 'nothing was pushed');
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), f.base, 'the own worktree is back at its baseline head');
    assert.equal(sh(f.worktree, 'status', '--porcelain'), '', 'the own worktree is restored');
  }
});

test('admission excludes non-ticket worktrees and its own, however cased, from sibling assertions', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  // git write-tree refuses an unmerged index, so a snapshot of this worktree would fault.
  const scratch = join(f.root, 'scratch');
  sh(f.mainRoot, 'worktree', 'add', '-q', '-b', 'scratch', scratch, 'main');
  conflict(scratch);
  // Windows paths are case-insensitive: the own worktree, listed in another case, would see its agent's writes as violations.
  if (process.platform === 'win32') {
    f.options.git = { ...gitModule, listWorktrees: async (root) => (await gitModule.listWorktrees(root)).map((w) => ({ ...w, path: w.path.toUpperCase() })) };
  }

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
});

test('sibling discovery failure prevents agent execution', async (t) => {
  for (const seeded of [false, true]) {
    const f = fixture(t, { labels: seeded ? [IN_PROGRESS] : [] });
    if (seeded) {
      await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    }
    f.options.git = { ...gitModule, listWorktrees: async () => { throw new Error('fatal: cannot list worktrees'); } };

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
    assert.match(ticketResult(results).error, /cannot list worktrees/);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    // An Execution that cannot be admitted, fresh or active, is marked as a fault, never left to retry.
    assert.equal((await record.load(f.commonDir, 'ticket', TICKET))?.state, 'fault');
  }
});

test('a resumed execution detached at the recorded SHA is held before recovery', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await crashBeforeCommit(f);
  const head = sh(f.worktree, 'rev-parse', 'HEAD');
  sh(f.worktree, 'checkout', '-q', '--detach', head);
  const before = await integrity.snapshot(f.worktree);
  f.gh.calls.length = 0;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  assert.ok(f.comments().some((b) => b.includes('detached HEAD') && b.includes(BRANCH)), 'the hold names the detached HEAD and recorded branch');
    assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET} is held and cannot resume. Switch the worktree back to \`${BRANCH}\` or remove it.`)
      && b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)), `the hold says how to recover: ${JSON.stringify(f.comments())}`);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.equal(sh(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'HEAD stays detached');
  assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head, 'the recorded branch is untouched');
  assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
  assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'held');
  assert.deepEqual(record.openIntents(final), record.openIntents(seeded));
});

test('a resumed execution stopped mid-rebase is held without changing the rebase', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'red', 3), point: 'after-completion' }) });
  const rebase = spawnSync('git', ['rebase', '--exec', 'exit 1', 'main'], { cwd: f.worktree, encoding: 'utf8' });
  assert.equal(rebase.status, 1, rebase.stderr);
  assert.equal(sh(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  const rebasePath = sh(f.worktree, 'rev-parse', '--git-path', 'rebase-merge');
  const todo = readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8');
  const before = await integrity.snapshot(f.worktree);
  const head = sh(f.worktree, 'rev-parse', BRANCH);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
  assert.equal(f.harness.calls.length, 1, 'no agent started');
  assert.deepEqual(await integrity.snapshot(f.worktree), before);
  assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head);
  assert.equal(readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8'), todo, 'the rebase is untouched');
  assert.deepEqual(record.openIntents(await record.load(f.commonDir, 'ticket', TICKET)), record.openIntents(seeded));
});

test('an unexpected branch query failure faults before recovery', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await crashBeforeCommit(f);
  const before = await integrity.snapshot(f.worktree);
  f.options.git = { ...gitModule, runGit: (args, opts) => args[0] === 'symbolic-ref'
    ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: cannot read HEAD' }) : gitModule.runGit(args, opts) };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(ticketResult(results).error, /cannot read HEAD/);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.deepEqual(await integrity.snapshot(f.worktree), before, 'nothing was replayed or discarded');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'fault');
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seeded));
});

test('a fault before the first visit still records its action events', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  f.options.git = { ...gitModule, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  const actions = f.readEvents().filter((e) => e.type === 'action' && e.ticket === TICKET);
  assert.deepEqual(actions.map((e) => `${e.phase} ${e.ordinal}`), ['fault 1', 'fault 2'], 'the comment and the label each record an Event');
  assert.ok(!f.logs.some((l) => /fault report failed/.test(l)), `no reporting failure is logged: ${JSON.stringify(f.logs)}`);
});
