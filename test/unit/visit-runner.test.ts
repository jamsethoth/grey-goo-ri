import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as attempt from '../../lib/attempt.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as model from '../../lib/model.ts';
import type * as visit from '../../lib/visit.ts';
import type * as visitScope from '../../lib/visit-scope.ts';
import * as visitRunner from '../../lib/visit-runner.ts';
import * as support from '../support/execution-context.ts';
import { loadTicket } from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';

const IDENTITY = { vertex: 'red', visit: 1, procedure: 'tests-fail', action: 'red-check', recovery: 0 };

const tableResolution = (direction: visit.Direction): visit.TableResolution => ({
  outcome: 'ok',
  direction,
  rule: { table: 'passed', row: 0 },
  row: null,
  check: null,
  retryAfterMs: null,
  retryKind: null,
  failureClass: null,
});

// A Visit's saved state with the Procedure runVisit gives it: an agent Action, then two Checks.
function runningVisit(): visitScope.RunningVisit {
  const state: visit.VisitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  const proc: Pick<model.Procedure, 'actions'> = {
    actions: [
      { id: 'red', do: 'agent' },
      { id: 'lint', do: 'check' },
      { id: 'red-check', do: 'check' },
    ],
  };
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  Object.defineProperty(state, 'claimTokens', { value: new Map(), enumerable: false });
  return state as visitScope.RunningVisit;
}

test("a Flow Action's retry is not settled, so a resumed Visit runs the Action again", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const state = runningVisit();
  executionRecord.visitState = state;
  const settle = visitRunner.settleOf(executionRecord, { actionIdentity: IDENTITY, state });
  await attempt.run(context, {
    actionIdentity: IDENTITY,
    busy: false,
    work: async () => null,
    finish: () => ({ resolution: tableResolution('retry') }),
    settle,
  });
  assert.equal(state.settled, null);
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => [event.action, event.direction]),
    [['red-check', 'retry']],
    'its Action Event is still recorded',
  );
  settle(tableResolution('advance'));
  assert.deepEqual(state.settled, { action: 'red-check', recovery: 0, resolution: tableResolution('advance') });
});

test("a held completion's retry clears the held result, and one with none re-runs the Visit's Checks", async (t) => {
  const { executionRecord } = await support.executionContext(t);
  const state = runningVisit();
  const held = {
    action: 'red-check',
    recovery: 0,
    resolution: { ...tableResolution('stop'), row: 'cleanup-unconfirmed' },
  };
  state.settled = held as visit.VisitState['settled'];
  const settle = visitRunner.settleOf(executionRecord, { actionIdentity: IDENTITY, state }, { held: true });
  settle(tableResolution('retry'));
  assert.equal(state.settled, null, 'the next Attempt runs');

  state.settled = held as visit.VisitState['settled'];
  executionRecord.cursor = { vertex: 'red', visit: 1, action: 'red-check', recovery: 0, attempt: 1 };
  executionRecord.attempts = 4;
  settle(null);
  assert.equal(state.settled, null);
  assert.deepEqual(
    executionRecord.cursor,
    { vertex: 'red', visit: 1, action: 'lint', recovery: 0, attempt: 1 },
    'the cursor moves to the first Check, saved in the same write',
  );
  assert.equal(executionRecord.attempts, 5, 'the re-run counts once toward the Action Cap');
});

// A Visit reads what the Config Hash covers from the value carrying that hash, so it pins what was hashed (#369).
test('a Visit pins the Declared Commands, test paths and Config Hash of the value it runs under', async (t) => {
  const fixture = await golden.fixture(t);
  const given = fixture.options.pinned!;
  const commands = { ...given.configuration.commands, lint: 'npm run lint' };
  const testPaths = [...given.configuration.testPaths, 'extra/**'];
  const pinned = { ...given, configuration: { ...given.configuration, commands, testPaths }, hash: 'pinned-hash' };
  await interpreter.runExecution({ ...fixture.options, pinned });
  const snapshot = loadTicket(fixture).configurationSnapshot!;
  assert.deepEqual(snapshot.commands, commands);
  assert.deepEqual(snapshot.testPaths, testPaths);
  assert.equal(snapshot.configHash, 'pinned-hash');
});
