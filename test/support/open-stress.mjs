// Stress loop for the State Database's open lock, never run by npm test: `node test/support/open-stress.mjs [rounds]`.
// Each round starts eight processes that create one new database at once; without the open lock about one open in
// 100-200 failed with SQLITE_BUSY, so the default 30 rounds (240 opens) usually catch a regression.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node --test runs support files too; it sets NODE_TEST_CONTEXT, so the loop stays out of npm test.
if (!process.env.NODE_TEST_CONTEXT) {
  const [rounds = 30] = process.argv.slice(2).map(Number);
  const saver = fileURLToPath(new URL('./record-saver.mjs', import.meta.url));
  const saveOnce = (commonDir, ticket) => new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, String(ticket), '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ ticket, code, err }));
  });
  const root = mkdtempSync(join(tmpdir(), 'gg-open-stress-'));
  let failed = 0;
  for (let round = 0; round < rounds; round++) {
    const commonDir = join(root, String(round));
    const bad = (await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((ticket) => saveOnce(commonDir, ticket)))).filter((e) => e.code !== 0);
    const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    db.close();
    if (bad.length || mode !== 'wal') {
      failed++;
      process.stdout.write(`round ${round} failed: journal_mode ${mode}, ${JSON.stringify(bad)}\n`);
    }
  }
  rmSync(root, { recursive: true, force: true });
  console.log(`${rounds - failed}/${rounds} rounds opened in WAL mode without an error (node ${process.version})`);
  process.exitCode = failed ? 1 : 0;
}
