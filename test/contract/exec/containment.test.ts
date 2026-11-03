import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const WINDOWS_CASE = { timeout: 120_000, skip: process.platform !== 'win32' && 'Windows job objects only' };

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
const pidIn = (file: string) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

// While the shell runs, its job holds the shell, the console host CREATE_NO_WINDOW gave it and the sleeper, all alive,
// so only the console host's name and parent tell it apart.
test('a job names the processes it holds, leaving out the console host of its shell', WINDOWS_CASE, async (t) => {
  const containment = await import('../../../lib/containment.ts');
  const kernel32 = containment.openKernel32();
  assert.ok(kernel32, 'node:ffi is unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'gg-containment-'));
  const pidFile = join(dir, 'sleeper.pid');
  const sleeper = join(dir, 'sleeper.mjs');
  const body = [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.argv[2], String(process.pid));',
    'setInterval(() => {}, 60_000);',
  ];
  writeFileSync(sleeper, body.join(' '));
  const { child, job } = containment.start(kernel32, `"${process.execPath}" "${sleeper}" "${pidFile}"`, undefined);
  assert.ok(job, 'the job was not set up');
  // first in, first out: the processes are gone before their directory is removed
  t.after(async () => {
    job.terminate();
    await job.emptied();
    job.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  child.stdout?.resume();
  child.stderr?.resume();
  while (!pidIn(pidFile)) {
    t.signal.throwIfAborted(); // a sleeper that never starts fails at the case timeout
    await sleep(50);
  }
  assert.equal(job.members().length, 3, 'the shell, its console host and the sleeper');
  const ascending = (left: number, right: number) => left - right;
  assert.deepEqual(job.leftovers(child.pid ?? 0).sort(ascending), [child.pid ?? 0, pidIn(pidFile)].sort(ascending));
});
