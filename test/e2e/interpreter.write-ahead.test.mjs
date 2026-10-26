import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import { intents, steps, actionMarker } from '../support/interpreter.mjs';

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
