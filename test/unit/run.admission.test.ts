import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as run from '../../lib/run.ts';
import * as runFixture from '../support/run-fixture.ts';

const { TICKET } = runFixture;
type PreflightError = Error & { exitCode?: number };

test('gg run runs the Declared Commands of its config, not those of AGENTS.md', async (t) => {
  const fixture = runFixture.fixture(t);
  writeFileSync(join(fixture.mainRoot, 'AGENTS.md'), '# repo\n\n## Commands\n\n- test: `agents-md-test`\n');
  const ran: string[] = [];
  const { runShell } = fixture.options.deps.exec;
  fixture.options.deps.exec = {
    ...fixture.options.deps.exec,
    runShell: (command, options) => {
      ran.push(command);
      return runShell(command, options);
    },
  };
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  assert.ok(ran.length > 0, 'the Checks ran');
  assert.deepEqual([...new Set(ran)], ['npm test']);
});

test('preflight lists every malformed Declared Command and a missing test, naming the repository Layer', async (t) => {
  const fixture = runFixture.fixture(t);
  fixture.options.config.commands = { Test: 'npm test', lint: '' };
  const file = join(fixture.mainRoot, '.agents', 'gg', 'gg.json');
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      `${file}: command name "Test" must match [a-z][a-z0-9-]*`,
      `${file}: command lint must be a non-empty single-line string`,
      `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`,
      'error: procedures.tests-fail.actions[1]: Check red-check names command "test", ' +
        'which the repository Layer does not declare',
      'error: procedures.implement.actions[1]: Check test names command "test", ' +
        'which the repository Layer does not declare',
      'error: procedures.fix.actions[1]: Check test names command "test", ' +
        'which the repository Layer does not declare',
      'error: procedures.publish.actions[0]: Check test names command "test", ' +
        'which the repository Layer does not declare',
    ]);
    assert.equal(err.exitCode, 1);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
});

// Epic planning is not built (X2b, X2d): a Flow's plan is required and null, so admission rejects any other, as gg
// doctor does.
test('a Flow with a plan section fails admission before any effect', async (t) => {
  const fixture = runFixture.fixture(t);
  fixture.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  await assert.rejects(run.runTarget(fixture.options), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: flows.default.plan: plan must be null until Epic planning is built',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
  assert.equal(existsSync(join(fixture.commonDir, 'gg', 'runs')), false, 'no run directory');
});

test('a Flow without a plan key fails admission before any effect', async (t) => {
  const fixture = runFixture.fixture(t);
  delete (fixture.options.config.flows.default as { plan?: unknown }).plan;
  await assert.rejects(run.runTarget(fixture.options), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: flows.default: plan is required: null when the Flow has no Epic-level planning',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
});

test("an Agent's access outside the Permission Intents fails admission before any effect", async (t) => {
  const fixture = runFixture.fixture(t);
  fixture.options.config.agents.implementer.access = 'read-write';
  await assert.rejects(run.runTarget(fixture.options), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: agents.implementer.access: access "read-write" is not a Permission Intent: read-only or workspace-write',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
});

test('a ticket reaching done exits 0 and the run events carry the run id and outcome', async (t) => {
  const fixture = runFixture.fixture(t);
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0);
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
  const runEvents = fixture.readEvents();
  const start = runEvents.find((event) => event.type === 'run_start');
  const end = runEvents.find((event): event is events.RunEndEvent => event.type === 'run_end');
  assert.ok(start && end, 'run_start and run_end are recorded');
  assert.equal(typeof start.run, 'string');
  assert.equal(end.run, start.run);
  assert.deepEqual(end.tickets, [{ ticket: TICKET, outcome: 'ready-for-qa' }], 'run_end carries the Ticket outcome');
  assert.equal(runEvents.find((event) => event.type === 'ticket_end')?.run, start.run);
  const runDir = join(fixture.commonDir, 'gg', 'runs', start.run);
  assert.ok(existsSync(join(runDir, 'flow.json')), 'the Resolved Flow is in the run directory');
  assert.ok(existsSync(join(runDir, 'config-hash.txt')), 'the Config Hash is in the run directory');
  assert.ok(
    readdirSync(runDir).some((name) => name.endsWith('.log')),
    'the run directory has a log file',
  );
});

test(
  'a Ticket in a repository reached through a linked ' + 'directory reaches done and publishes no local path',
  async (t) => {
    const fixture = runFixture.fixture(t, { linked: true });
    const results = await run.runTarget(fixture.options);
    assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
    assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
    const published = JSON.stringify(fixture.gh.calls.map(({ args, input }) => [args, input]));
    assert.ok(!published.includes(basename(fixture.real)), `gh exposes ${basename(fixture.real)}: ${published}`);
  },
);
