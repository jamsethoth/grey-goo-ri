import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The defaults Layer still ships its Agents, Procedures and Flow until #121 removes them; the cases for the example gg
// init writes are in test/unit/doctor.test.ts.
test("defaults/gg.json declares the Run's settings", () => {
  const gg = JSON.parse(readFileSync(new URL('../../defaults/gg.json', import.meta.url), 'utf8'));
  assert.equal(gg.maxParallel, 2);
  assert.equal(gg.baseBranch, 'main');
  assert.equal(typeof gg.worktreeRoot, 'string');
  assert.equal(gg.labelPrefix, 'gg');
});
