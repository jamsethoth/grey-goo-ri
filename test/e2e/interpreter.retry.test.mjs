import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { headSha, loadTicket, originSha, subjects } from '../support/execution-reads.ts';
import { contendRepoLock, onLockedGit } from '../support/repo-lock-contention.ts';

test('a git write queued behind another holder of the repo lock checks the human override first', async (t) => {
  await t.test('a queued push', async (t) => {
    const g = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    const lock = contendRepoLock(g, () => {
      g.gh.labels.add('gg:state:needs-human');
    });
    // The green commit's write is the last before the push, whose lock attempt then waits.
    const counts = onLockedGit(g, (verb, n) => {
      if (verb === 'commitStaged' && n === 2) lock.arm();
    });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
    assert.equal(await originSha(g), null);
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
  await t.test('a queued push whose commit origin already has', async (t) => {
    const g = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    // Unlocked: the push runs while the contender holds the repo lock.
    const { git } = g.options.deps;
    const lock = contendRepoLock(g, async () => git.push(g.worktree, golden.BRANCH, await git.headSha(g.worktree)));
    const counts = onLockedGit(g, (verb, n) => {
      if (verb === 'commitStaged' && n === 2) lock.arm();
    });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'the commit is on origin, so it is not pushed again');
    assert.equal(await originSha(g), await headSha(g));
  });
  await t.test('a queued commit', async (t) => {
    const g = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    const lock = contendRepoLock(g, () => {
      g.gh.labels.add('gg:state:needs-human');
    });
    // The green commit's tree is written; its commit is the next locked write.
    const counts = onLockedGit(g, (verb, n) => {
      if (verb === 'writeTree' && n === 2) lock.arm();
    });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the commit waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.commitStaged, 1, 'only the red commit was made');
    assert.deepEqual((await subjects(g)).length, 1);
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
});
