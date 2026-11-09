import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { headSha, loadTicket, originSha, subjects } from '../support/execution-reads.ts';
import { contendRepoLock, onLockedGit } from '../support/repo-lock-contention.ts';

test('a git write queued behind another holder of the repo lock checks the human override first', async (t) => {
  await t.test('a queued push', async (t) => {
    const fixture = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    const lock = contendRepoLock(fixture, async () => {
      fixture.gh.labels.add('gg:state:needs-human');
    });
    // The green commit's write is the last before the push, whose lock attempt then waits.
    const counts = onLockedGit(fixture, (verb, count) => {
      if (verb === 'commitStaged' && count === 2) lock.arm();
    });
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
    assert.equal(await originSha(fixture), null);
    assert.equal(loadTicket(fixture).state, 'abandoned');
  });
  await t.test('a queued push whose commit origin already has', async (t) => {
    const fixture = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    // Unlocked: the push runs while the contender holds the repo lock.
    const { git } = fixture.options.deps;
    const lock = contendRepoLock(fixture, async () =>
      git.push(fixture.worktree, golden.BRANCH, await git.headSha(fixture.worktree)),
    );
    const counts = onLockedGit(fixture, (verb, count) => {
      if (verb === 'commitStaged' && count === 2) lock.arm();
    });
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'the commit is on origin, so it is not pushed again');
    assert.equal(await originSha(fixture), await headSha(fixture));
  });
  await t.test('a queued commit', async (t) => {
    const fixture = await golden.fixture(t, { integrity: 'real', git: 'fake' });
    const lock = contendRepoLock(fixture, async () => {
      fixture.gh.labels.add('gg:state:needs-human');
    });
    // The green commit's tree is written; its commit is the next locked write.
    const counts = onLockedGit(fixture, (verb, count) => {
      if (verb === 'writeTree' && count === 2) lock.arm();
    });
    const result = await interpreter.runExecution(fixture.options);

    assert.equal(lock.state(), 'released', 'the commit waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.commitStaged, 1, 'only the red commit was made');
    assert.deepEqual((await subjects(fixture)).length, 1);
    assert.equal(loadTicket(fixture).state, 'abandoned');
  });
});
