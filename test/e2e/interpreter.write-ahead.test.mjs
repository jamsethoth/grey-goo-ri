import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { actionMarker, intents, writeAheadSteps } from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';

test('a completed call with an integrity violation still rolls back under its own marker', async (t) => {
  const g = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    gitShell.sh(g.worktree, 'add', '-A');
    gitShell.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(gitShell.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.deepEqual(writeAheadSteps(g.executionRecord, actionMarker(g, 'red', 'red')), [
    'intent',
    'evidence',
    'complete',
  ]);
  const [reset] = intents(g.executionRecord, 'reset');
  // An Action of its own, keeping the Attempt.
  assert.equal(reset.actionMarker, actionMarker(g, 'red', 'reset'));
  assert.deepEqual(writeAheadSteps(g.executionRecord, reset.actionMarker), ['intent', 'evidence', 'complete']);
});
