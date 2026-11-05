import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { actionMarker, intents, writeAheadSteps } from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';
import * as harnessRuns from '../support/harness-runs.ts';

test('a completed call with an integrity violation still rolls back under its own marker', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  harnessRuns.afterEachCall(fixture, () => {
    gitShell.sh(fixture.worktree, 'add', '-A');
    gitShell.sh(fixture.worktree, 'commit', '-q', '-m', 'agent commit');
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
    fixture.base,
    'the branch is back at the baseline head',
  );
  assert.deepEqual(writeAheadSteps(fixture.executionRecord, actionMarker(fixture, 'red', 'red')), [
    'intent',
    'evidence',
    'complete',
  ]);
  const [reset] = intents(fixture.executionRecord, 'reset');
  // An Action of its own, keeping the Attempt.
  assert.equal(reset!.actionMarker, actionMarker(fixture, 'red', 'reset'));
  assert.deepEqual(writeAheadSteps(fixture.executionRecord, reset!.actionMarker), ['intent', 'evidence', 'complete']);
});
