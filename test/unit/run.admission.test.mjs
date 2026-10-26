import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as config from '../../lib/config.mjs';
import { pathKey } from '../../lib/paths.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, markerOf, ticketResult, conflict,
  crashBeforeCommit,
} from '../support/run.mjs';

test('gg run runs the Declared Commands of its config, not those of AGENTS.md', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.mainRoot, 'AGENTS.md'), '# repo\n\n## Commands\n\n- test: `agents-md-test`\n');
  const ran = [];
  const { runShell } = f.options.exec;
  f.options.exec = { ...f.options.exec, runShell: (command, opts) => (ran.push(command), runShell(command, opts)) };
  const results = await run.runTarget(f.options);
  assert.equal(ticketResult(results).outcome, 'done', JSON.stringify(results));
  assert.ok(ran.length > 0, 'the Checks ran');
  assert.deepEqual([...new Set(ran)], ['npm test']);
});

test('preflight lists every malformed Declared Command and a missing test, naming the repository Layer', async (t) => {
  const f = fixture(t);
  f.options.config.commands = { Test: 'npm test', lint: '' };
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  const file = join(f.mainRoot, '.agents', 'gg', 'gg.json');
  assert.deepEqual(err?.message.split('\n'), [
    '[main] preflight failed:',
    `${file}: command name "Test" must match [a-z][a-z0-9-]*`,
    `${file}: command lint must be a non-empty single-line string`,
    `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`,
  ]);
  assert.equal(err.exitCode, 1);
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('a standalone ticket under a flow with a plan section is rejected before any effect', async (t) => {
  const f = fixture(t);
  f.options.config.flows['ticket-only'] = structuredClone(f.options.config.flows.default);
  f.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'the standalone ticket is rejected');
  assert.equal(err.exitCode ?? 1, 1, 'the rejection exit code is unchanged');
  assert.match(err.message, /set plan to null on Flow default\b/);
  assert.ok(err.message.includes(join(f.mainRoot, '.agents', 'gg', 'gg.json')), 'the message names the repo Layer file');
  assert.ok(err.message.includes('{"flows":{"default":{"plan":null}}}'), 'the message gives the minimal repo Layer JSON');
  assert.doesNotMatch(err.message, /ticket-only/, 'the advice does not name an unselectable Flow');
  assert.ok(f.gh.calls.length > 0, 'the target was discovered');
  assert.deepEqual(f.gh.calls.filter((c) => !(c.args[0] === 'issue' && c.args[1] === 'view')), [], 'gh recorded only issue view');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.equal(f.loadRow(), undefined, 'no record');
  assert.equal(f.harness.calls.length, 0);
  assert.equal(existsSync(join(f.commonDir, 'gg', 'runs')), false, 'no run directory');
});

test('a standalone Ticket under a Flow without a plan key is accepted', async (t) => {
  const f = fixture(t);
  delete f.options.config.flows.default.plan;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
  assert.equal(f.harness.calls.length, 2, 'both agent Phases ran on the fake Harness');
  const { run: runId } = f.readEvents().find((e) => e.type === 'run_start');
  const resolved = JSON.parse(readFileSync(join(f.commonDir, 'gg', 'runs', runId, 'flow.json'), 'utf8'));
  assert.equal(Object.hasOwn(resolved, 'plan'), false, 'the Resolved Flow has no plan key');
});

test('following standalone Ticket advice in the repo Layer allows the Ticket to run', async (t) => {
  const f = fixture(t);
  f.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  const home = join(f.root, 'home');
  const { commands, ...user } = f.options.config;
  mkdirSync(join(home, '.agents', 'gg'), { recursive: true });
  writeFileSync(join(home, '.agents', 'gg', 'gg.json'), JSON.stringify(user));
  const repoLayer = join(f.mainRoot, '.agents', 'gg', 'gg.json');
  mkdirSync(join(f.mainRoot, '.agents', 'gg'), { recursive: true });
  writeFileSync(repoLayer, JSON.stringify({ commands }));
  f.options.config = config.loadConfig(f.mainRoot, home);

  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'the user Layer initially enables the plan section');
  assert.ok(err.message.includes(repoLayer), 'the advice names the path loadConfig reads');
  const advice = JSON.parse(err.message.split('\n').at(-1));
  assert.deepEqual(advice, { flows: { default: { plan: null } } });
  writeFileSync(repoLayer, JSON.stringify({ ...advice, commands }));
  f.options.config = config.loadConfig(f.mainRoot, home);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
  assert.equal(f.harness.calls.length, 2, 'both agent Phases ran on the fake Harness');
});

test('a ticket reaching done exits 0 and the run events carry the run id and outcome', async (t) => {
  const f = fixture(t);
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  assert.ok(f.gh.labels.has('gg:state:ready-for-qa'));
  const evs = f.readEvents();
  const start = evs.find((e) => e.type === 'run_start');
  const end = evs.find((e) => e.type === 'run_end');
  assert.ok(start && end, 'run_start and run_end are recorded');
  assert.equal(typeof start.run, 'string');
  assert.equal(end.run, start.run);
  assert.deepEqual(end.tickets, [{ ticket: TICKET, outcome: 'done' }], 'run_end carries the Ticket outcome');
  assert.equal(evs.find((e) => e.type === 'ticket_end').run, start.run);
  const runDir = join(f.commonDir, 'gg', 'runs', start.run);
  assert.ok(existsSync(join(runDir, 'flow.json')), 'the Resolved Flow is in the run directory');
  assert.ok(existsSync(join(runDir, 'config-hash.txt')), 'the Config Hash is in the run directory');
  assert.ok(readdirSync(runDir).some((name) => name.endsWith('.log')), 'the run directory has a log file');
});

test('a Ticket in a repository reached through a linked directory reaches done and publishes no local path', async (t) => {
  const f = fixture(t, { linked: true });
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.ok(f.gh.labels.has('gg:state:ready-for-qa'));
  const published = JSON.stringify(f.gh.calls.map(({ args, input }) => [args, input]));
  assert.ok(!published.includes(basename(f.real)), `gh exposes ${basename(f.real)}: ${published}`);
});

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
  assert.equal(f.harness.calls.length, 2, 'no agent started');
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
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.equal(sh(f.worktree, 'diff', '--cached', '--name-only'), staged, 'the staged changes are untouched');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
});
