import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as commandShim from '../../lib/command-shim.ts';
import * as storeAlias from '../support/store-alias.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'argvOf resolves a command only on Windows' };
const SHIMS = join(import.meta.dirname, '..', 'fixtures', 'cmd-shim');
const TOO_LONG = join(tmpdir(), ...Array<string>(200).fill('y'.repeat(200)));

test("a Store app's execution alias found first on PATH starts as named", WINDOWS_ONLY, (t) => {
  const later = tempDirectory.tempDirectory(t, 'gg-later-cmd-');
  writeFileSync(join(later, 'pwsh.cmd'), '@echo off\r\n');
  const path = [storeAlias.storeAlias(t), later].join(';');
  const argvOf = () => commandShim.argvOf('pwsh', ['-c', 'exit'], { path });
  assert.doesNotThrow(argvOf, 'the alias, a link, is found before the .cmd');
  assert.deepEqual(argvOf(), { command: 'pwsh', args: ['-c', 'exit'] });
});

test('a PATH entry that cannot be read is skipped, and the npm shim after it is found', WINDOWS_ONLY, () => {
  assert.equal(commandShim.argvOf('argv-printer', [], { path: [TOO_LONG, SHIMS].join(';') }).command, 'node');
});

test('a command named with .cmd behind an unreadable PATH entry does not throw', WINDOWS_ONLY, () => {
  const argvOf = () => commandShim.argvOf('argv-printer.cmd', [], { path: [TOO_LONG, SHIMS].join(';') });
  assert.doesNotThrow(argvOf);
  assert.equal(argvOf().command, 'node');
});
