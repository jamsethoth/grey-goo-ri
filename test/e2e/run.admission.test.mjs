import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathKey } from '../../lib/paths.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, markerOf, ticketResult, conflict,
  crashBeforeCommit,
} from '../support/run.mjs';

test('unknown dirty state is held with the diff stat', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const edited = '{ "scripts": { "test": "node --test" }, "human": true }\n';
  writeFileSync(join(f.worktree, 'package.json'), edited);
  writeFileSync(join(f.worktree, 'notes.txt'), 'my notes\n');
  const status = sh(f.worktree, 'status', '--porcelain');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('package.json')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.ok(f.comments().some((b) => b.includes(`Commit, stash or remove these changes in the worktree, then remove the ${NEEDS_HUMAN} label and re-run gg run ${TICKET}.`)));
  assert.ok(f.comments().every((b) => !b.includes(f.root)));
  assert.equal(readFileSync(join(f.worktree, 'package.json'), 'utf8'), edited, 'the edit is untouched');
  assert.equal(readFileSync(join(f.worktree, 'notes.txt'), 'utf8'), 'my notes\n', 'the untracked file is untouched');
  assert.equal(sh(f.worktree, 'status', '--porcelain'), status);
  const held = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(held?.state, 'held', 'the hold is recorded');
  assert.equal(f.readEvents().filter((e) => e.type === 'ticket_end' && e.execution === held.execution).length, 1, 'the hold landed');
  sh(f.worktree, 'restore', 'package.json');
  rmSync(join(f.worktree, 'notes.txt'));
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'following the advice starts the Ticket');
});

function assertConflictHeld(f, results, before) {
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('conflict.txt')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.ok(f.comments().some((b) => b.includes('merge conflict') && b.includes('Resolve and commit the conflicted paths in the worktree')));
  assert.ok(f.comments().every((b) => !b.includes(f.root)));
  assert.equal(sh(f.worktree, 'ls-files', '-u'), before.unmerged, 'the unmerged index is untouched');
  assert.equal(readFileSync(join(f.worktree, 'conflict.txt'), 'utf8'), before.bytes, 'the conflicted file is untouched');
}

test('a merge conflict at ticket start is held with the diff stat', async (t) => {
  const f = fixture(t, { git: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const before = conflict(f.worktree);

  assertConflictHeld(f, await run.runTarget(f.options), before);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  writeFileSync(join(f.worktree, 'conflict.txt'), 'resolved\n');
  sh(f.worktree, 'add', 'conflict.txt');
  sh(f.worktree, 'commit', '-q', '-m', 'resolve conflict');
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'following the advice starts the Ticket');
});

test('dirty hold advice explains how a held Execution Record can be inspected and restarted', async (t) => {
  const f = fixture(t, { integrity: 'real' });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  f.options.cwd = f.worktree;
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: 'seed', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET} is held`) && b.includes('SQLite client')));
  assert.ok(f.comments().some((b) => b.includes('Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.')));
  assert.ok(f.comments().some((b) => b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)));
  assert.equal(pathKey((await f.options.git.repoInfo(f.worktree)).gitCommonDir), pathKey(f.commonDir), 'the linked worktree uses the main checkout State Database');
  assert.ok(existsSync(join(f.mainRoot, '.git', 'gg', 'gg.db')));
  const held = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(held.state, 'held');
  assert.doesNotMatch(held.terminalReason.text, /DELETE FROM|SQLite/, 'the recovery advice is in the comment, not the Terminal Reason');
  rmSync(join(f.worktree, 'human.txt'));
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(ticketResult(await run.runTarget(f.options)).outcome, 'skipped', 'removing the label alone cannot resume a finished record');
  const statement = f.comments().join('\n').match(/`(DELETE FROM records WHERE kind = 'ticket' AND n = \d+;)`/)[1];
  record.openDb(f.commonDir).exec(statement);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'deleting only the held row allows a fresh Execution');
});

test('a merge conflict in the worktree of a resumed execution is held, not faulted', async (t) => {
  const f = fixture(t, { git: 'real', labels: [IN_PROGRESS] });
  await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
  const before = conflict(f.worktree);

  assertConflictHeld(f, await run.runTarget(f.options), before);
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
});

test('a commit interrupted before it landed is admitted and replayed', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS], integrity: 'real' });
  const seeded = await crashBeforeCommit(f);
  assert.deepEqual(record.openIntents(seeded).map((e) => e.action), ['commit'], 'the record holds the intended commit');
  assert.notEqual(sh(f.worktree, 'status', '--porcelain'), '', 'the staged implementation waits for its commit');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'no agent call is repeated');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'done');
  assert.equal(sh(f.worktree, 'status', '--porcelain'), '', 'the replayed commit took the staged changes');
  assert.notEqual(sh(f.worktree, 'ls-tree', 'HEAD', 'lib/add.mjs'), '', 'the implementation is committed');
});

test('a commit interrupted before it landed is held once a human changed the worktree', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS], integrity: 'real' });
  await crashBeforeCommit(f);
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  const staged = sh(f.worktree, 'diff', '--cached', '--name-only');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.equal(sh(f.worktree, 'diff', '--cached', '--name-only'), staged, 'the staged changes are untouched');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
});
