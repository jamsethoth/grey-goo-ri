// The Terminal Reason every ticket_end carries in full (request 3.3, #23): its four keys, each of its frozen type, and
// a rule identity `{ table, row }` exactly when a table row or one of gg's fixed rows decided the Outcome. A hold, an
// abandonment and a fault decide no Outcome, so their outcome and rule are both null.
import assert from 'node:assert/strict';
import * as eventRead from '../../lib/event-read.ts';
import type * as events from '../../lib/events.ts';

const KEYS = ['decidedBy', 'outcome', 'rule', 'text'];
const ACTION_KEYS = ['vertex', 'visit', 'action', 'recovery'];
const TABLES = ['fixed', 'stopped', 'passed', 'failed'];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === 'string';

// decidedBy is one form: a hold, a State Label or an Action, the first two with an Action's four keys or none (#341).
function assertDecidedBy(decidedBy: unknown, where: string): void {
  assert.ok(isObject(decidedBy), `${where}: decidedBy is an object`);
  const deciders = ['hold', 'label'].filter((key) => Object.hasOwn(decidedBy, key));
  const actionKeys = ACTION_KEYS.filter((key) => Object.hasOwn(decidedBy, key));
  assert.ok(deciders.length <= 1, `${where}: decidedBy names one decider`);
  assert.ok([0, 4].includes(actionKeys.length), `${where}: decidedBy holds an Action's four keys or none`);
  assert.ok(deciders.length + actionKeys.length > 0, `${where}: decidedBy names who decided`);
  assert.deepEqual(Object.keys(decidedBy).sort(), [...deciders, ...actionKeys].sort(), `${where}: decidedBy's keys`);
  if (deciders[0] === 'hold') assert.ok(textOrNull(decidedBy.hold), `${where}: a hold's name`);
  if (deciders[0] === 'label') assert.equal(typeof decidedBy.label, 'string', `${where}: a State Label`);
  if (actionKeys.length) {
    assert.equal(typeof decidedBy.vertex, 'string', `${where}: decidedBy.vertex`);
    assert.ok(decidedBy.visit === null || typeof decidedBy.visit === 'number', `${where}: decidedBy.visit`);
    assert.ok(textOrNull(decidedBy.action), `${where}: decidedBy.action`);
    assert.equal(typeof decidedBy.recovery, 'number', `${where}: decidedBy.recovery`);
  }
}

export function assertFull(terminalReason: unknown, where: string): void {
  assert.ok(isObject(terminalReason), `${where}: a Terminal Reason`);
  assert.deepEqual(Object.keys(terminalReason).sort(), [...KEYS].sort(), `${where}: its keys`);
  assertDecidedBy(terminalReason.decidedBy, where);
  assert.ok(textOrNull(terminalReason.outcome), `${where}: its outcome`);
  assert.equal(typeof terminalReason.text, 'string', `${where}: its text`);
  const { rule } = terminalReason;
  assert.equal(rule === null, terminalReason.outcome === null, `${where}: a rule exactly when an Outcome was decided`);
  if (rule !== null) {
    assert.ok(isObject(rule), `${where}: the rule identity`);
    assert.deepEqual(Object.keys(rule).sort(), ['row', 'table'], `${where}: the rule identity { table, row }`);
    assert.ok(TABLES.includes(rule.table as string), `${where}: the rule's table`);
    assert.ok(rule.row === null || ['string', 'number'].includes(typeof rule.row), `${where}: the rule's row`);
  }
}

// An Execution's ticket_end Events, as the checked read gives them.
export const ticketEnds = (commonDir: string, execution: string): events.TicketEndEvent[] =>
  eventRead
    .executionEvents(commonDir, execution)
    .filter((event): event is events.TicketEndEvent => event.type === 'ticket_end');

// Checks, as the case ends, every ticket_end in the State Database it is given, of every Execution. The checked read
// throws on any row it refuses, so a case that plants a corrupt row removes it before it ends. The case's temp
// directory runs it before its removal, which a failed check does not stop.
export function atCaseEnd(commonDir: string): void {
  for (const event of eventRead.readEvents(commonDir))
    if (event.type === 'ticket_end') assertFull(event.terminalReason, `ticket_end of ${event.execution}`);
}
