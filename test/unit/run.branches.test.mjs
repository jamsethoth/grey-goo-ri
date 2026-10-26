import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import { TICKET, BRANCH, IN_PROGRESS, fixture, ticketResult } from '../support/run.mjs';

// An Execution that cannot be admitted, fresh or active, is marked as a fault, never left to retry.
test('sibling discovery failure prevents agent execution: a fresh Ticket', async (t) => {
  const f = fixture(t);
  f.options.git = { ...f.options.git, listWorktrees: async () => { throw new Error('fatal: cannot list worktrees'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(ticketResult(results).error, /cannot list worktrees/);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET))?.state, 'fault');
});

test('sibling discovery failure prevents agent execution: an active Execution', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
  f.options.git = { ...f.options.git, listWorktrees: async () => { throw new Error('fatal: cannot list worktrees'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(ticketResult(results).error, /cannot list worktrees/);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET))?.state, 'fault');
});

test('a fault before the first visit still records its action events', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  f.options.git = { ...f.options.git, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  const actions = f.readEvents().filter((e) => e.type === 'action' && e.ticket === TICKET);
  assert.deepEqual(actions.map((e) => `${e.phase} ${e.ordinal}`), ['fault 1', 'fault 2'], 'the comment and the label each record an Event');
  assert.ok(!f.logs.some((l) => /fault report failed/.test(l)), `no reporting failure is logged: ${JSON.stringify(f.logs)}`);
});
