import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as terminal from '../../lib/terminal.mjs';

const push = { vertex: 'green', visit: 1, action: 'push', recovery: 0 };
const runStop = { row: 'run-stop', rule: { table: 'fixed', row: 'run-stop' }, failureClass: 'auth' };

test('a run stop from a remote Action names the Action, not a harness call', () => {
  assert.equal(
    terminal.stopText(push, 'run-stop', { ...runStop, source: 'push' }),
    'The push at push failed with class auth, which stops the whole run.',
  );
  assert.equal(
    terminal.stopText({ ...push, action: 'review' }, 'needs-human', {
      row: 'run-stopped',
      rule: { table: 'fixed', row: 'run-stopped' },
      failureClass: 'auth',
      source: 'push',
      runStopTicket: 21,
    }),
    'The push of Ticket #21 failed with class auth, which stops the whole run, so this Execution stopped ' +
      'before review.',
  );
  assert.equal(
    terminal.stopText({ ...push, action: 'red' }, 'run-stop', runStop),
    'The harness call at red failed with class auth, which stops the whole run.',
    "a Harness's run stop still names the harness call",
  );
});
