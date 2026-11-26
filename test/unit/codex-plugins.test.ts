import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as codexPlugins from '../../lib/harnesses/codex-plugins.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The acceptance check of a listed plugin's parts (#481 Q3 C, with the folder check), over a layout of a made-up
// Harness: the check holds no Harness's names or paths, only what the layout it is given says (owner, "consistent and
// aligned"; #535 moves it unchanged once a second Harness calls it).

const LAYOUT: codexPlugins.PluginLayout = {
  manifest: join('.kit-plugin', 'kit.json'),
  parts: {
    widgets: { key: 'widgets', files: [] },
    gadgets: { key: 'gadgetServers', files: ['.gadgets.json', join('gadgets', 'gadgets.json')] },
  },
  descriptive: ['name', 'version', 'description'],
};

// A plugin folder whose manifest holds `keys`, beside `files`; with `keys` null it holds no manifest.
function pluginFolder(t: TestContext, keys: string[] | null, files: string[] = []) {
  const directory = tempDirectory.tempDirectory(t, 'gg-plugin-');
  if (keys !== null) {
    mkdirSync(dirname(join(directory, LAYOUT.manifest)), { recursive: true });
    writeFileSync(join(directory, LAYOUT.manifest), JSON.stringify(Object.fromEntries(keys.map((key) => [key, key]))));
  }
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), '{}');
  }
  return directory;
}

const sorted = ({ parts, refused }: codexPlugins.Acceptance) => ({
  parts: [...parts].sort(),
  refused: [...refused].sort(),
});

test('a part its manifest declares is found by its key, and refused when the set does not admit it', (t) => {
  const directory = pluginFolder(t, ['name', 'widgets', 'gadgetServers']);
  assert.deepEqual(sorted(codexPlugins.acceptance(directory, LAYOUT, ['widgets'])), {
    parts: ['gadgets', 'widgets'],
    refused: ['gadgets'],
  });
});

test('descriptive keys bring no part', (t) => {
  const directory = pluginFolder(t, ['name', 'version', 'description', 'widgets']);
  assert.deepEqual(sorted(codexPlugins.acceptance(directory, LAYOUT, ['widgets'])), {
    parts: ['widgets'],
    refused: [],
  });
});

test('a part its folder holds is found by its file whatever the manifest says', (t) => {
  const atTop = pluginFolder(t, ['name', 'widgets'], ['.gadgets.json']);
  const nested = pluginFolder(t, ['name', 'widgets'], [join('gadgets', 'gadgets.json')]);
  assert.deepEqual(sorted(codexPlugins.acceptance(atTop, LAYOUT, ['widgets'])).refused, ['gadgets']);
  assert.deepEqual(sorted(codexPlugins.acceptance(nested, LAYOUT, ['widgets'])).refused, ['gadgets']);
});

// A working key no recording shows fails closed (Q3: a deny-list of known keys would fail open).
test('a manifest key the layout does not know is a part refused by its own name', (t) => {
  const directory = pluginFolder(t, ['name', 'widgets', 'sprockets']);
  assert.deepEqual(sorted(codexPlugins.acceptance(directory, LAYOUT, ['widgets'])), {
    parts: ['sprockets', 'widgets'],
    refused: ['sprockets'],
  });
});

test('a folder with no manifest is refused as manifest', (t) => {
  const directory = pluginFolder(t, null, ['README.md']);
  assert.deepEqual(codexPlugins.acceptance(directory, LAYOUT, ['widgets']).refused, ['manifest']);
});
