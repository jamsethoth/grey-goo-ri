import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as config from '../../lib/config.mjs';
import * as run from '../../lib/run.mjs';
import { TICKET, fixture, loadTicket, ticketResult } from '../support/run.mjs';

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
  assert.equal(await loadTicket(f), null, 'no record');
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
