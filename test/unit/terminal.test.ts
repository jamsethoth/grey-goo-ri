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

test("an Execution's run stop is its first Action Event whose class reaches the run", () => {
  const event = (action: string, failureClass: string | null, agent = false) => ({
    type: 'action',
    action,
    agent,
    failureClass,
  });
  const harnessAuth = event('red', 'auth', true);
  const remoteAuth = event('push', 'auth');
  const permission = event('push', 'permission');
  assert.equal(
    terminal.runStopEvent([event('red-check', null), harnessAuth, remoteAuth]),
    harnessAuth,
    'a Harness auth',
  );
  assert.equal(terminal.runStopEvent([permission, remoteAuth, { type: 'ticket_end' }]), remoteAuth, 'a remote auth');
  assert.equal(terminal.runStopEvent([permission]), null, 'a permission failure faults only its Ticket');
  assert.equal(terminal.runStopEvent([]), null, 'none');
});
