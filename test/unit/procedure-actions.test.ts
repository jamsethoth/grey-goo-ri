import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedureActions from '../support/procedure-actions.ts';

const procedure = { actions: [{ id: 'green' }, { id: 'test', kind: 'command' }] };

test('actionById finds a Procedure Action by its id, not its index', () => {
  assert.equal(procedureActions.actionById(procedure, 'test'), procedure.actions[1]);
});

test('actionById fails naming the ids a Procedure has when none matches', () => {
  assert.throws(() => procedureActions.actionById(procedure, 'commit'), /no Action commit: green, test/);
});

test('replaceAction puts an Action in the place of the one with its id, dropping that one', () => {
  const edited = { actions: [{ id: 'green' }, { id: 'test', kind: 'command' }, { id: 'commit' }] };
  procedureActions.replaceAction(edited, 'test', { id: 'test' });
  assert.deepEqual(edited.actions, [{ id: 'green' }, { id: 'test' }, { id: 'commit' }]);
});
