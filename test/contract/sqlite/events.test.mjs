import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../../../lib/events.mjs';
import * as record from '../../../lib/record.mjs';

const appender = fileURLToPath(new URL('../../support/event-appender.mjs', import.meta.url));

// The State Database is closed before the directory is removed, as Windows requires.
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-events-'));
  t.after(() => {
    record.close(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Reads the events table directly, as another SQLite client would.
function rows(commonDir) {
  const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
  try {
    return db.prepare('SELECT id, ts, type, run, execution, ticket, json FROM events ORDER BY id').all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('two processes append to the same table without loss', async (t) => {
  const dir = tempDir(t);
  const exits = await Promise.all(['a', 'b'].map((run) => new Promise((resolve) => {
    const child = spawn(process.execPath, [appender, dir, run, '200'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ run, code, err }));
  })));
  assert.deepEqual(exits, [{ run: 'a', code: 0, err: '' }, { run: 'b', code: 0, err: '' }]);
  assert.equal(rows(dir).length, 400);
  const read = events.readEvents(dir);
  assert.equal(read.length, 400);
  assert.equal(read.filter((e) => e.run === 'a').length, 200);
  assert.equal(read.filter((e) => e.run === 'b').length, 200);
});
