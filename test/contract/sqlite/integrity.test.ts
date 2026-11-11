import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as integrity from '../../../lib/integrity.ts';
import * as stateDatabase from '../../../lib/state-database.ts';
import * as childExit from '../../support/child-exit.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const saver = fileURLToPath(new URL('../../support/record-saver.ts', import.meta.url));

test('readActivity reads a record another process saved', async (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'own', '.git'));
  const commonDir = join(root, 'own', '.git');
  stateDatabase.create(commonDir);
  const other = join(root, 'other');
  const exit = await childExit.exitOf(
    spawn(process.execPath, [saver, commonDir, '2', '3', other], { stdio: ['ignore', 'ignore', 'pipe'] }),
  );
  assert.deepEqual(exit, { code: 0, err: '' });
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'records are rows, not files');
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: true, generation: 3 });
});
