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

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a Ticket in a repository reached through a linked directory reaches done and publishes no local path', async (t) => {
  const fixture = runFixture.fixture(t, { linked: true });
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
  const published = JSON.stringify(fixture.gh.calls.map(({ args, input }) => [args, input]));
  assert.ok(!published.includes(basename(fixture.real)), `gh exposes ${basename(fixture.real)}: ${published}`);
});
