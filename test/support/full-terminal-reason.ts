// The Terminal Reason every ticket_end carries in full (request 3.3, #23): its four keys, and a rule identity
// `{ table, row }` exactly when a table row or one of gg's fixed rows decided the Outcome. A hold, an abandonment and a
// fault decide no Outcome, so their outcome and rule are both null.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as eventRead from '../../lib/event-read.ts';
import type * as events from '../../lib/events.ts';

const KEYS = ['decidedBy', 'outcome', 'rule', 'text'];

export function assertFull(terminalReason: unknown, where: string): void {
  assert.ok(terminalReason !== null && typeof terminalReason === 'object', `${where}: a Terminal Reason`);
  const reason = terminalReason as Record<string, unknown>;
  assert.deepEqual(Object.keys(reason).sort(), [...KEYS].sort(), `${where}: its keys`);
  assert.equal(typeof reason.text, 'string', `${where}: its text`);
  assert.equal(reason.rule === null, reason.outcome === null, `${where}: a rule exactly when an Outcome was decided`);
  if (reason.rule !== null) {
    const rule = reason.rule as Record<string, unknown>;
    assert.deepEqual(Object.keys(rule).sort(), ['row', 'table'], `${where}: the rule identity { table, row }`);
  }
}

// An Execution's ticket_end Events, as the checked read gives them: a row a case corrupted on purpose is skipped.
export const ticketEnds = (commonDir: string, execution: string): events.TicketEndEvent[] =>
  eventRead
    .executionEvents(commonDir, execution, () => {})
    .filter((event): event is events.TicketEndEvent => event.type === 'ticket_end');

// Checks, as the case ends, every ticket_end of the Execution it is given. Called before the case's temp directory is
// made, so the check runs before the directory goes. Returns the setter for the State Database and the Execution.
export function atCaseEnd(t: TestContext): (commonDir: string, execution: string) => void {
  const checked: { commonDir?: string; execution?: string } = {};
  t.after(() => {
    const { commonDir, execution } = checked;
    if (commonDir && execution)
      for (const { terminalReason } of ticketEnds(commonDir, execution))
        assertFull(terminalReason, `ticket_end of ${execution}`);
  });
  return (commonDir, execution) => Object.assign(checked, { commonDir, execution });
}
