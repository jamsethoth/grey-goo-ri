import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the retry engine is its own module', async () => {
  const effects = await import('../lib/effects.mjs');
  for (const name of ['sideEffect', 'lookup', 'lockGuard', 'bracket']) assert.equal(typeof effects[name], 'function', name);
});
