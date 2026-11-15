// The Terminal Reason every ticket_end carries in full (request 3.3, #23): its four keys, and a rule identity
// `{ table, row }` exactly when a table row or one of gg's fixed rows decided the Outcome. A hold, an abandonment and a
// fault decide no Outcome, so their outcome and rule are both null.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as stateDatabase from '../../lib/state-database.ts';

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

// Each ticket_end a State Database holds, read as saved: a case that corrupts other rows still has its ticket_end read.
export function ticketEnds(commonDir: string): { execution: string; terminalReason: unknown }[] {
  const rows = stateDatabase
    .open(commonDir)
    .prepare("SELECT json FROM events WHERE type = 'ticket_end' ORDER BY id")
    .all() as { json: string }[];
  return rows.map(({ json }) => JSON.parse(json) as { execution: string; terminalReason: unknown });
}

// Every ticket_end in the State Database carries a full Terminal Reason.
export function assertEveryTicketEnd(commonDir: string): void {
  for (const { execution, terminalReason } of ticketEnds(commonDir))
    assertFull(terminalReason, `ticket_end of ${execution}`);
}

// Checks, as the case ends, every ticket_end in the State Database it is given. Called before the case's temp directory
// is made, so the check runs before the directory goes. Returns the setter for that State Database's directory.
export function atCaseEnd(t: TestContext): (commonDir: string) => void {
  const checked: { commonDir?: string } = {};
  t.after(() => checked.commonDir && assertEveryTicketEnd(checked.commonDir));
  return (commonDir) => {
    checked.commonDir = commonDir;
  };
}
