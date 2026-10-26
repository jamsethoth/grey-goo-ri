import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../scripts/run-suite.mjs', import.meta.url));

test('the launcher exits 2 with its usage and runs nothing for an argument outside its closed set', () => {
  const r = spawnSync(process.execPath, [launcher, 'fast', '--import=x'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^usage: node scripts\/run-suite\.mjs \[fast \[boundary \.\.\.\]\]/);
});
