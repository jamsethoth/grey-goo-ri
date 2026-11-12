import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runContextModule from '../../lib/run-context.ts';
import * as golden from '../support/golden.ts';

test('harnessOf gives null, not undefined, before the first Visit pins an Agent', async (t) => {
  const fixture = await golden.fixture(t);
  const { harness: _harness, ...options } = fixture.options;
  const runContext = runContextModule.createRunContext({ ...options, harnesses: {} });
  assert.equal(fixture.executionRecord.configurationSnapshot, null, 'no Visit has pinned an Agent');
  assert.equal(runContext.harnessOf(), null);
});
