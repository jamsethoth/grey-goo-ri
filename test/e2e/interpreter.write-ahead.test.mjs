import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import { intents, steps, actionMarker, loadTicket } from '../support/interpreter.mjs';

// A wait for state a timer writes: there is no barrier to await on a heartbeat save. A save that never comes fails at
// the case timeout, which aborts signal and ends the wait, so the case's cleanup runs.
async function until(check, signal) {
  while (!(await check())) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('the record carries the last heartbeat of a running call', { timeout: 120_000 }, async (t) => {
  const red = golden.firstVisitResponses['implementer/1/red/1'];
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/red/1': { ...red, hang: true }, 'implementer/1/red/2': red } });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const run = g.harness.run;
  g.harness.run = (call) => {
    const out = run(call);
    if (call.attempt === 1) started();
    return out;
  };
  const execution = interpreter.runExecution({ ...g.options, heartbeatMs: 5 });
  try {
    await running;
    const first = (await loadTicket(g)).heartbeat;
    assert.match(String(first), /^2026-10-15T/, 'the heartbeat is saved with the Attempt intent');
    await g.options.clock.sleep(60_000);
    await until(async () => (await loadTicket(g)).heartbeat !== first, t.signal);
    const beating = await loadTicket(g);
    assert.ok(Date.parse(beating.heartbeat) > Date.parse(first), 'updated while the call runs');
    assert.equal(beating.activity.busy, true, 'a heartbeat leaves the activity as it is');
  } finally {
    // Settled before the case ends either way, so no Execution outlives its temp repo.
    g.harness.cancel();
    await execution.catch(() => {});
  }
  assert.equal((await execution).outcome, 'done');
  assert.equal((await loadTicket(g)).heartbeat, null, 'cleared once the call ends');
});

test('a completed call with an integrity violation still rolls back under its own marker', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    golden.sh(g.worktree, 'add', '-A');
    golden.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.deepEqual(steps(g.rec, actionMarker(g, 'red', 1)), ['intent', 'evidence', 'complete']);
  const [reset] = intents(g.rec, 'reset');
  // After the red Phase's three declared ordinals, keeping the Attempt.
  assert.equal(reset.marker, actionMarker(g, 'red', 4));
  assert.deepEqual(steps(g.rec, reset.marker), ['intent', 'evidence', 'complete']);
});
