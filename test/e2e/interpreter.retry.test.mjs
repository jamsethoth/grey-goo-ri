import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import { loadTicket, contendRepoLock, lockedSetup } from '../support/interpreter.mjs';

test('a git write queued behind another holder of the repo lock checks the human override first', async (t) => {
  await t.test('a queued push', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => { g.gh.labels.add('gg:state:needs-human'); });
    // The green commit's write is the last before the push, whose lock attempt then waits.
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
    assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
  await t.test('a queued push whose commit origin already has', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => golden.sh(g.worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${golden.BRANCH}`));
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the push waited for the lock');
    assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
    assert.equal(counts.push ?? 0, 0, 'the commit is on origin, so it is not pushed again');
    assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'));
  });
  await t.test('a queued commit', async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const lock = contendRepoLock(t, g.commonDir, () => { g.gh.labels.add('gg:state:needs-human'); });
    // The green commit's tree is written; its commit is the next locked write.
    const counts = lockedSetup(g, (verb, n) => { if (verb === 'writeTree' && n === 2) lock.arm(); });
    const result = await interpreter.runExecution(g.options);

    assert.equal(lock.state(), 'released', 'the commit waited for the lock');
    assert.equal(result.outcome, 'abandoned', JSON.stringify(result));
    assert.equal(counts.commitStaged, 1, 'only the red commit was made');
    assert.deepEqual(golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean).length, 1);
    assert.equal((await loadTicket(g)).state, 'abandoned');
  });
});
