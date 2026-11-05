import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as failingGit from '../support/failing-git.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;

// An Execution that cannot be admitted, fresh or active, is marked as a fault, never left to retry.
test('sibling discovery failure prevents agent execution: a fresh Ticket', async (t) => {
  const fixture = runFixture.fixture(t);
  failingGit.failGitVerb(fixture, 'listWorktrees', 'fatal: cannot list worktrees');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(runFixture.ticketResult(results)?.error as string, /cannot list worktrees/);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.equal((await record.load(fixture.commonDir, 'ticket', TICKET))?.state, 'fault');
});

test('sibling discovery failure prevents agent execution: an active Execution', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [executionContext.IN_PROGRESS_LABEL] });
  const { mainRoot, worktree } = fixture;
  await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  await record.save(unvisitedExecution.unvisitedExecution(fixture));
  failingGit.failGitVerb(fixture, 'listWorktrees', 'fatal: cannot list worktrees');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(runFixture.ticketResult(results)?.error as string, /cannot list worktrees/);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.equal((await record.load(fixture.commonDir, 'ticket', TICKET))?.state, 'fault');
});

test('a fault before the first visit still records its action events', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [executionContext.IN_PROGRESS_LABEL] });
  await record.save(unvisitedExecution.unvisitedExecution(fixture));
  failingGit.failGitVerb(fixture, 'ensureWorktree', 'worktree add failed\nfatal: disk full');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1);
  const actions = fixture
    .readEvents()
    .filter((event): event is events.ActionEvent => event.type === 'action' && event.ticket === TICKET);
  assert.deepEqual(
    actions.map((event) => event.action),
    ['fault-comment', 'fault-label'],
    'the comment and the label each record an Event',
  );
  assert.ok(
    !fixture.logs.some((line) => /fault report failed/.test(line)),
    `no reporting failure is logged: ${JSON.stringify(fixture.logs)}`,
  );
});
