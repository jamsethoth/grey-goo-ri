import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Every file gg runs from, except lib/harnesses/, the one place a Harness is named.
const files = ['lib', 'bin'].flatMap((dir) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'))
  .filter((f) => !f.startsWith('lib/harnesses/'));
const NAMES = /claude|codex|CLAUDE\.md|\.codex/i;

test('no module outside lib/harnesses names a Harness', () => {
  assert.ok(files.includes('lib/interpreter.mjs') && files.includes('bin/gg.mjs'), `scanned ${files.join(', ')}`);
  const named = files.flatMap((f) => readFileSync(join(root, f), 'utf8').split('\n')
    .flatMap((line, i) => (NAMES.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(named, []);
});
