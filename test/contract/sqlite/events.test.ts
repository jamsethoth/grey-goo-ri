import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../../../lib/events.ts';
import * as childExit from '../../support/child-exit.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

const appender = fileURLToPath(new URL('../../support/event-appender.ts', import.meta.url));

// Reads the events table directly, as another SQLite client would.
function rows(commonDir: string) {
  const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
  try {
    return db
      .prepare('SELECT id, ts, type, run, execution, ticket, json FROM events ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('two processes append to the same table without loss', async (t) => {
  const dir = tempDirectory.tempDirectory(t, 'gg-events-');
  const exits = await Promise.all(
    ['a', 'b'].map((run) =>
      childExit
        .exitOf(spawn(process.execPath, [appender, dir, run, '200'], { stdio: ['ignore', 'ignore', 'pipe'] }))
        .then((exit) => ({ run, ...exit })),
    ),
  );
  assert.deepEqual(exits, [
    { run: 'a', code: 0, err: '' },
    { run: 'b', code: 0, err: '' },
  ]);
  assert.equal(rows(dir).length, 400);
  const read = events.readEvents(dir);
  assert.equal(read.length, 400);
  assert.equal(read.filter((event) => event.run === 'a').length, 200);
  assert.equal(read.filter((event) => event.run === 'b').length, 200);
});
