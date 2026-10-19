import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as locks from '../lib/locks.mjs';

const contender = fileURLToPath(new URL('./support/lock-contender.mjs', import.meta.url));
const locksModule = new URL('../lib/locks.mjs', import.meta.url);

async function tempCommonDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gg-locks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Spawns a process that holds the lock, resolving with the child once it has printed its handle.
function startHolder(t, args) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      try {
        resolve({ child, exited, report: JSON.parse(out) });
      } catch {}
    });
    child.on('exit', () => reject(new Error(`holder exited before reporting: ${out}`)));
  });
}

test('tryAcquire returns null while the lock is held', async (t) => {
  const commonDir = await tempCommonDir(t);
  const handle = await locks.tryAcquire(commonDir, 'ticket-8');
  assert.ok(handle);
  assert.equal(handle.path, join(commonDir, 'gg', 'locks', 'ticket-8.db'));
  assert.equal(handle.pid, process.pid);
  assert.equal(typeof handle.startedAt, 'string');
  assert.equal(await locks.tryAcquire(commonDir, 'ticket-8'), null);
  await locks.release(handle);
  const again = await locks.tryAcquire(commonDir, 'ticket-8');
  assert.ok(again, 'free after release');
  await locks.release(again);
});

test('tryAcquire returns null while another process holds the lock', async (t) => {
  const commonDir = await tempCommonDir(t);
  const { child, exited, report } = await startHolder(t, [contender, commonDir, 'repo', '60000']);
  assert.ok(report.handle, 'the child holds the lock');
  assert.equal(report.handle.path, join(commonDir, 'gg', 'locks', 'repo.db'));
  assert.equal(await locks.tryAcquire(commonDir, 'repo'), null);
  child.kill();
  await exited;
});

test('a holder that exits without release frees the lock', async (t) => {
  const commonDir = await tempCommonDir(t);
  const script = `import * as locks from ${JSON.stringify(locksModule.href)};
const handle = await locks.tryAcquire(${JSON.stringify(commonDir)}, 'repo');
process.stdout.write(JSON.stringify({ handle }), () => process.exit(0));`;
  const { exited, report } = await startHolder(t, ['--input-type=module', '-e', script]);
  assert.ok(report.handle, 'the child held the lock');
  assert.equal(report.handle.path, join(commonDir, 'gg', 'locks', 'repo.db'));
  await exited;
  // Windows unlocks a terminated process's locks after a delay that depends on system resources.
  const handle = await locks.acquire(commonDir, 'repo', { timeoutMs: 2_000, pollMs: 20 });
  assert.ok(handle);
  await locks.release(handle);
});

test('a killed holder frees the lock', async (t) => {
  const commonDir = await tempCommonDir(t);
  const { child, exited, report } = await startHolder(t, [contender, commonDir, 'repo', '60000']);
  assert.ok(report.handle, 'the child holds the lock');
  assert.equal(report.handle.path, join(commonDir, 'gg', 'locks', 'repo.db'));
  child.kill();
  await exited;
  const handle = await locks.acquire(commonDir, 'repo', { timeoutMs: 2_000, pollMs: 20 });
  assert.ok(handle);
  await locks.release(handle);
});

test('a handle keeps the lock while it is referenced', async (t) => {
  const commonDir = await tempCommonDir(t);
  const handle = await locks.tryAcquire(commonDir, 'repo');
  assert.ok(handle?.db, 'the handle owns the database connection');
  const until = Date.now() + 500;
  while (Date.now() < until) {
    assert.equal(await locks.tryAcquire(commonDir, 'repo'), null);
    await sleep(50);
  }
  await locks.release(handle);
});

test('the lock module needs no experimental flag for node:sqlite', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=24.15');
  const source = await readFile(locksModule, 'utf8');
  assert.match(source, /from 'node:sqlite'/);
});

test('acquire waits for release', async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  setTimeout(() => locks.release(first), 150);
  const started = Date.now();
  const second = await locks.acquire(commonDir, 'repo', { timeoutMs: 5_000, pollMs: 20 });
  assert.ok(second);
  assert.ok(Date.now() - started >= 100, 'waited for the holder');
  await locks.release(second);
});

test('acquire times out', async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  await assert.rejects(locks.acquire(commonDir, 'repo', { timeoutMs: 150, pollMs: 20 }), (err) => {
    assert.ok(err instanceof locks.LockTimeoutError);
    return true;
  });
  await locks.release(first);
});

test('withLock forwards its acquisition timeout without invoking the callback', { timeout: 10_000 }, async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  let ran = false;
  await assert.rejects(locks.withLock(commonDir, 'repo', async () => { ran = true; }, { timeoutMs: 150, pollMs: 20 }),
    (err) => err instanceof locks.LockTimeoutError && err.message.includes('150ms'));
  assert.equal(ran, false, 'the callback never runs without the lock');
  await locks.release(first);
});

test('withLock releases on throw', async (t) => {
  const commonDir = await tempCommonDir(t);
  await assert.rejects(locks.withLock(commonDir, 'epic-1', async () => {
    assert.equal(await locks.tryAcquire(commonDir, 'epic-1'), null, 'held inside fn');
    throw new Error('boom');
  }), /boom/);
  const handle = await locks.tryAcquire(commonDir, 'epic-1');
  assert.ok(handle, 'released after throw');
  await locks.release(handle);
  assert.equal(await locks.withLock(commonDir, 'epic-1', async () => 42), 42);
});

test('contending processes never throw and grant at most one owner', async (t) => {
  const commonDir = await tempCommonDir(t);
  let owners = 0;
  for (let round = 0; round < 5; round++) {
    const children = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, [contender, commonDir, 'repo', 'barrier'], { stdio: ['pipe', 'pipe', 'inherit'] });
      t.after(() => child.kill());
      const exited = new Promise((resolve) => child.on('exit', resolve));
      return { child, exited, lines: createInterface({ input: child.stdout })[Symbol.asyncIterator]() };
    });
    // Every contender has started before any tries, and the owner holds until every contender has reported.
    await Promise.all(children.map(({ lines }) => lines.next()));
    for (const { child } of children) child.stdin.write('go\n');
    const outputs = await Promise.all(children.map(async ({ lines }) => JSON.parse((await lines.next()).value)));
    for (const { child } of children) child.stdin.end();
    await Promise.all(children.map(({ exited }) => exited));
    const errors = outputs.filter((o) => o.error);
    assert.deepEqual(errors, [], `round ${round}: no contender throws`);
    const won = outputs.filter((o) => o.handle).length;
    assert.ok(won <= 1, `round ${round}: at most one owner, got ${won}`);
    owners += won;
    if (won === 0) {
      // Simultaneous BEGIN EXCLUSIVE can hand every contender SQLITE_BUSY (ADR 0008); the lock must then be free, not wedged.
      const handle = await locks.tryAcquire(commonDir, 'repo');
      assert.ok(handle, `round ${round}: nobody won, so the lock is free`);
      await locks.release(handle);
    }
  }
  assert.ok(owners >= 1, 'some round had an owner');
});

test('the stress loop counts a run as clean only on exit 0 with a # fail 0 summary', async () => {
  const stress = await import('./support/lock-stress.mjs');
  const tap = '# tests 6\n# pass 6\n# fail 0\n';
  assert.equal(stress.passed(0, null, tap), true);
  assert.equal(stress.passed(1, null, ''), false, 'an empty-output failure is not clean');
  assert.equal(stress.passed(0, null, ''), false, 'no summary is not clean');
  assert.equal(stress.passed(1, null, tap), false, 'a non-zero exit is not clean');
  assert.equal(stress.passed(null, 'SIGTERM', tap), false, 'a signal is not clean');
  assert.equal(stress.passed(0, null, '# pass 0\n# fail 0\n'), false, 'a run with no passing tests is not clean');
});
