import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as integrity from '../../../lib/integrity.ts';
import * as stateDatabase from '../../../lib/state-database/index.ts';
import * as caseDatabase from '../../support/case-database.ts';
import * as childExit from '../../support/child-exit.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const saver = fileURLToPath(new URL('../../support/record-saver.ts', import.meta.url));

// Each adapter of the database a Run is handed (#367): the real State Database, and the failing wrapper with no hook.
const ADAPTERS: [string, (t: TestContext) => stateDatabase.StateDatabase][] = [
  ['the real State Database', () => stateDatabase],
  ['the failing wrapper', (t) => caseDatabase.caseDatabase(t)],
];

// A case that waits for another process to exit: one that never does fails at this bound.
const CASE = { timeout: 120_000 };

for (const [name, databaseOf] of ADAPTERS)
  test(`readActivity reads a record another process saved, through ${name}`, CASE, async (t) => {
    const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'own', '.git'));
    const commonDir = join(root, 'own', '.git');
    stateDatabase.create(commonDir);
    const other = join(root, 'other');
    const child = spawn(process.execPath, [saver, commonDir, '2', '3', other], { stdio: ['ignore', 'ignore', 'pipe'] });
    // At the case's timeout, before the after hooks: removing the directory throws while the child holds it open.
    t.signal.addEventListener('abort', () => child.kill());
    const exit = await childExit.exitOf(child);
    assert.deepEqual(exit, { code: 0, err: '' });
    assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'records are rows, not files');
    assert.deepEqual(await integrity.readActivity(commonDir, other, databaseOf(t)), { busy: true, generation: 3 });
  });
