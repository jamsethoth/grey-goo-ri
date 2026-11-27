// The Codex recorder's `example` name (#482 Q1 A): the owner allowed one real call each recording of the example's
// first-visit pass, so a call past them starts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as recordCodexExample from '../../scripts/record-codex-example.ts';

test('each model call of the pass is recorded under the next recording, and a fourth is refused', () => {
  assert.deepEqual([0, 1, 2].map(recordCodexExample.nameOf), ['example-red', 'example-green', 'example-review']);
  assert.throws(() => recordCodexExample.nameOf(3), /asked for call 4; the recorder makes 3 \(#482 Q1 A\)/);
});
