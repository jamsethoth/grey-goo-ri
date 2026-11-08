import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as visit from '../../lib/visit.ts';
import * as visitScope from '../../lib/visit-scope.ts';

const signal: visit.CheckSignal = { id: 'test', kind: 'command', state: 'passed', tree: 't1' };
const run: visit.CheckRun = { output: 'ok', reason: null, failure: null, recoverable: false };
const state = { checks: new Map([['test', signal]]), runs: new Map([['test', run]]) };

// The validator admits only Check ids the Procedure declares, and every Check runs before an effect reads it, so a
// result that is missing is a broken record, and the error names the Action rather than a property of undefined.
test('a saved Check result is read by its Action id, and a missing one is named', () => {
  assert.equal(visitScope.checkSignal(state, 'test'), signal);
  assert.equal(visitScope.checkRun(state, 'test'), run);
  assert.throws(() => visitScope.checkSignal(state, 'constructor'), /Check "constructor" has no saved result/);
  assert.throws(() => visitScope.checkRun(state, '__proto__'), /Check "__proto__" has no saved run/);
});
