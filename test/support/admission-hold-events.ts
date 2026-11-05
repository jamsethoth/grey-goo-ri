// What an admission hold leaves: its Events and Terminal Reason, decided before any agent ran.
import assert from 'node:assert/strict';
import type * as admission from '../../lib/admission.ts';
import type * as events from '../../lib/events.ts';
import * as run from '../../lib/run.ts';
import * as executionReads from './execution-reads.ts';
import * as golden from './golden.ts';
import * as runFixture from './run-fixture.ts';

export async function assertAdmissionHoldEvents(
  fixture: runFixture.RunFixture,
  results: admission.TicketResult[],
  hold: string,
): Promise<void> {
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  const executionRecord = await executionReads.loadTicket(fixture);
  assert.equal(executionRecord?.terminalReason?.decidedBy.hold, hold);
  assert.equal(executionRecord.state, 'held');
  const ticketEvents = fixture.readEvents().filter((event) => 'ticket' in event && event.ticket === golden.TICKET);
  assert.deepEqual(
    ticketEvents.map((event) =>
      event.type === 'action' ? `${event.vertex} ${event.action} ${event.recovery}` : event.type,
    ),
    ['ticket_start', 'needs-human hold-comment 0', 'needs-human hold-label 0', 'ticket_end'],
  );
  assert.ok(
    ticketEvents.every(
      (event) =>
        'execution' in event &&
        event.execution === executionRecord.execution &&
        event.run === runFixture.lastRun(fixture),
    ),
    'one Execution and Run throughout',
  );
  const ticketEnd = ticketEvents.at(-1) as events.TicketEndEvent;
  assert.equal(ticketEnd.outcome, 'needs-human');
  assert.deepEqual(ticketEnd.terminalReason, executionRecord.terminalReason);
  assert.doesNotMatch(
    executionRecord.terminalReason?.text ?? '',
    /re-run|DELETE FROM/,
    'the Terminal Reason is one sentence; the advice is in the comment',
  );
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
}
