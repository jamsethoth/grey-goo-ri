import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';

const { BRANCH, TICKET } = runFixture;

test('an in-progress ticket with a recoverable record is resumed', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real', labels: [executionContext.IN_PROGRESS_LABEL] });
  // The push of the green commit was intended but never made.
  const seeded = await runFixture.crashBeforePush(fixture);
  assert.equal(seeded.state, 'active');
  assert.deepEqual(
    writeAhead.openIntents(seeded).map((entry) => entry.effect),
    ['push'],
    'the push is the open intent',
  );

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0);
  assert.equal(fixture.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
  const final = (await record.load(fixture.commonDir, 'ticket', TICKET)) as record.ExecutionRecord;
  assert.equal(final.execution, seeded.execution, 'the same Execution is resumed');
  assert.equal(final.state, 'ready-for-qa');
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0],
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
  );
  // The resume's Events belong to this Run; the markers keep the Run that wrote them, so no effect is redone.
  const runEvents = fixture.readEvents();
  const start = runEvents.findIndex((event) => event.type === 'run_start');
  const resumed = runEvents
    .slice(start)
    .filter((event) => ['action', 'ticket_start', 'ticket_end'].includes(event.type)) as (
    events.ActionEvent | events.TicketStartEvent | events.TicketEndEvent
  )[];
  assert.ok(
    resumed.some((event) => event.type === 'action'),
    'the resume records Action Events',
  );
  assert.deepEqual(
    [...new Set(resumed.map((event) => event.run))],
    [(runEvents[start] as events.RunStartEvent).run],
    'every resumed Event carries the new Run id',
  );
  assert.equal(
    fixture.gh.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'create').length,
    1,
    'one PR is opened',
  );
});
