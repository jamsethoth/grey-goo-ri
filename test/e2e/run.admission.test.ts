import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as admission from '../../lib/admission.ts';
import * as paths from '../../lib/paths.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

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

test('unknown dirty state is held with the diff stat', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  const edited = '{ "scripts": { "test": "node --test" }, "human": true }\n';
  writeFileSync(join(fixture.worktree, 'package.json'), edited);
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'my notes\n');
  const status = gitShell.sh(fixture.worktree, 'status', '--porcelain');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.ok(
    fixture.comments().some((body) => body.includes('package.json')),
    `a comment carries the diff stat: ${JSON.stringify(fixture.comments())}`,
  );
  const advice =
    `Commit, stash or remove these changes in the worktree, then remove the ${NEEDS_HUMAN_LABEL} label and re-run ` +
    `gg run ${TICKET}.`;
  assert.ok(fixture.comments().some((body) => body.includes(advice)));
  assert.ok(fixture.comments().every((body) => !body.includes(fixture.root)));
  assert.equal(readFileSync(join(fixture.worktree, 'package.json'), 'utf8'), edited, 'the edit is untouched');
  assert.equal(
    readFileSync(join(fixture.worktree, 'notes.txt'), 'utf8'),
    'my notes\n',
    'the untracked file is untouched',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), status);
  const held = executionReads.loadTicket(fixture, TICKET);
  assert.equal(held?.state, 'held', 'the hold is recorded');
  assert.equal(runFixture.endsOf(fixture, held.execution).length, 1, 'the hold landed');
  gitShell.sh(fixture.worktree, 'restore', 'package.json');
  rmSync(join(fixture.worktree, 'notes.txt'));
  fixture.gh.labels.delete(NEEDS_HUMAN_LABEL);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0, 'following the advice starts the Ticket');
});

function assertConflictHeld(
  fixture: RunFixture,
  results: admission.TicketResult[],
  before: ReturnType<typeof runFixture.conflict>,
) {
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.ok(
    fixture.comments().some((body) => body.includes('conflict.txt')),
    `a comment carries the diff stat: ${JSON.stringify(fixture.comments())}`,
  );
  assert.ok(
    fixture
      .comments()
      .some(
        (body) =>
          body.includes('merge conflict') && body.includes('Resolve and commit the conflicted paths in the worktree'),
      ),
  );
  assert.ok(fixture.comments().every((body) => !body.includes(fixture.root)));
  assert.equal(gitShell.sh(fixture.worktree, 'ls-files', '-u'), before.unmerged, 'the unmerged index is untouched');
  assert.equal(
    readFileSync(join(fixture.worktree, 'conflict.txt'), 'utf8'),
    before.bytes,
    'the conflicted file is untouched',
  );
}

test('a merge conflict at ticket start is held with the diff stat', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real' });
  await addWorktree(fixture);
  const before = runFixture.conflict(fixture.worktree);

  assertConflictHeld(fixture, await run.runTarget(fixture.options), before);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  writeFileSync(join(fixture.worktree, 'conflict.txt'), 'resolved\n');
  gitShell.sh(fixture.worktree, 'add', 'conflict.txt');
  gitShell.sh(fixture.worktree, 'commit', '-q', '-m', 'resolve conflict');
  fixture.gh.labels.delete(NEEDS_HUMAN_LABEL);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0, 'following the advice starts the Ticket');
});

// The hold's comment says how to inspect the held record and delete its row; the Terminal Reason does not.
async function assertHeldRecordAdvice(fixture: RunFixture) {
  assert.ok(
    fixture
      .comments()
      .some((body) => body.includes(`Execution Record ticket-${TICKET} is held`) && body.includes('SQLite client')),
  );
  const inspect =
    'Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite ' +
    'client.';
  assert.ok(fixture.comments().some((body) => body.includes(inspect)));
  assert.ok(
    fixture.comments().some((body) => body.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)),
  );
  assert.equal(
    paths.pathKey((await fixture.options.deps.git.repoInfo(fixture.worktree)).gitCommonDir),
    paths.pathKey(fixture.commonDir),
    'the linked worktree uses the main checkout State Database',
  );
  assert.ok(existsSync(join(fixture.mainRoot, '.git', 'gg', 'gg.db')));
  const held = executionReads.loadTicket(fixture, TICKET);
  assert.equal(held.state, 'held');
  assert.doesNotMatch(
    held.terminalReason?.text as string,
    /DELETE FROM|SQLite/,
    'the recovery advice is in the comment, not the Terminal Reason',
  );
}

test('dirty hold advice explains how a held Execution Record can be inspected and restarted', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  await addWorktree(fixture);
  fixture.options.cwd = fixture.worktree;
  record.save(unvisitedExecution.unvisitedExecution(fixture, { run: 'seed' }));
  writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n');
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  await assertHeldRecordAdvice(fixture);
  rmSync(join(fixture.worktree, 'human.txt'));
  fixture.gh.labels.delete(NEEDS_HUMAN_LABEL);
  assert.equal(
    runFixture.ticketResult(await run.runTarget(fixture.options))?.outcome,
    'skipped',
    'removing the label alone cannot resume a finished record',
  );
  const statement = fixture
    .comments()
    .join('\n')
    .match(/`(DELETE FROM records WHERE kind = 'ticket' AND n = \d+;)`/)?.[1] as string;
  stateDatabase.open(fixture.commonDir).exec(statement);
  assert.equal(
    run.runExitCode(await run.runTarget(fixture.options)),
    0,
    'deleting only the held row allows a fresh Execution',
  );
});

test('a merge conflict in the worktree of a resumed execution is held, not faulted', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  await runFixture.crashBeforePush(fixture);
  const before = runFixture.conflict(fixture.worktree);

  assertConflictHeld(fixture, await run.runTarget(fixture.options), before);
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.equal(executionReads.loadTicket(fixture, TICKET).state, 'held');
});

test('a commit interrupted before it landed is admitted and replayed', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL], integrity: 'real', git: 'real' });
  const seeded = await runFixture.crashBeforeCommit(fixture);
  assert.deepEqual(
    writeAhead.openIntents(seeded).map((entry) => entry.effect),
    ['commit'],
    'the record holds the intended commit',
  );
  assert.notEqual(
    gitShell.sh(fixture.worktree, 'status', '--porcelain'),
    '',
    'the staged implementation waits for its commit',
  );

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 2, 'no agent call is repeated');
  assert.equal(executionReads.loadTicket(fixture, TICKET).state, 'ready-for-qa');
  assert.equal(
    gitShell.sh(fixture.worktree, 'status', '--porcelain'),
    '',
    'the replayed commit took the staged changes',
  );
  assert.notEqual(
    gitShell.sh(fixture.worktree, 'ls-tree', 'HEAD', 'lib/add.mjs'),
    '',
    'the implementation is committed',
  );
});

test('a commit interrupted before it landed is held once a human changed the worktree', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL], integrity: 'real', git: 'real' });
  await runFixture.crashBeforeCommit(fixture);
  writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n');
  const staged = gitShell.sh(fixture.worktree, 'diff', '--cached', '--name-only');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.equal(readFileSync(join(fixture.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.equal(
    gitShell.sh(fixture.worktree, 'diff', '--cached', '--name-only'),
    staged,
    'the staged changes are untouched',
  );
  assert.equal(executionReads.loadTicket(fixture, TICKET).state, 'held');
});
