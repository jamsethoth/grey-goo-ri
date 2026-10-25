import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the Terminals are their own module', async () => {
  const terminal = await import('../lib/terminal.mjs');
  for (const name of ['hold', 'abandon', 'fault', 'decide', 'terminal']) assert.equal(typeof terminal[name], 'function', name);
});
