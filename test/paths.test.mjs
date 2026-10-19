import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real directory and a junction to it: the shape of a symlinked TMPDIR, a junction or a Windows 8.3 name.
function linked(t) {
  const root = mkdtempSync(join(tmpdir(), 'gg-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(join(real, 'sub'), { recursive: true });
  symlinkSync(real, join(root, 'link'), 'junction');
  return { real: realpathSync.native(real), link: join(root, 'link') };
}

test('canonical resolves a linked directory to the path git reports', async (t) => {
  const paths = await import('../lib/paths.mjs');
  const { real, link } = linked(t);
  assert.equal(paths.canonical(join(link, 'sub')), join(real, 'sub'));
  assert.equal(paths.canonical(`${link}/sub/../sub/`), join(real, 'sub'));
});

test('canonical keeps a missing tail on the canonical form of its nearest existing ancestor', async (t) => {
  const paths = await import('../lib/paths.mjs');
  const { real, link } = linked(t);
  assert.equal(paths.canonical(join(link, 'wt', 'ticket-4')), join(real, 'wt', 'ticket-4'));
});

test('pathKey makes two spellings of one directory equal, folding case only on Windows', async (t) => {
  const paths = await import('../lib/paths.mjs');
  const { real, link } = linked(t);
  assert.equal(paths.pathKey(join(link, 'sub')), paths.pathKey(join(real, 'sub')));
  const upper = join(real, 'SUB');
  if (process.platform === 'win32') assert.equal(paths.pathKey(upper), paths.pathKey(join(real, 'sub')));
  else assert.notEqual(paths.pathKey(upper), paths.pathKey(join(real, 'sub')));
});
