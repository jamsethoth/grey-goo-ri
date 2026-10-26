import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as integrity from '../../../lib/integrity.mjs';
import * as record from '../../../lib/record.mjs';

const saver = fileURLToPath(new URL('../../support/record-saver.mjs', import.meta.url));

test('readActivity reads a record another process saved', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  const commonDir = join(root, 'own', '.git');
  t.after(() => {
    record.close(commonDir);
    rmSync(root, { recursive: true, force: true });
  });
  const other = join(root, 'other');
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, '2', '3', other], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.deepEqual(exit, { code: 0, err: '' });
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'records are rows, not files');
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: true, generation: 3 });
});
