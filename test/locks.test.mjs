import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as locks from '../lib/locks.mjs';

async function tempCommonDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gg-locks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

test('tryAcquire returns null while the lock is held', async (t) => {
  const commonDir = await tempCommonDir(t);
  const handle = await locks.tryAcquire(commonDir, 'ticket-8');
  assert.ok(handle);
  const held = JSON.parse(await readFile(join(commonDir, 'gg', 'locks', 'ticket-8.lock'), 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.equal(typeof held.startedAt, 'string');
  assert.equal(await locks.tryAcquire(commonDir, 'ticket-8'), null);
  await locks.release(handle);
  const again = await locks.tryAcquire(commonDir, 'ticket-8');
  assert.ok(again, 'free after release');
  await locks.release(again);
});

test('a lock with a dead pid is taken over', async (t) => {
  const commonDir = await tempCommonDir(t);
  const pid = deadPid();
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  await writeFile(join(commonDir, 'gg', 'locks', 'ticket-8.lock'), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  const handle = await locks.tryAcquire(commonDir, 'ticket-8');
  assert.ok(handle);
  assert.equal(handle.takenOverFrom, pid);
  const held = JSON.parse(await readFile(join(commonDir, 'gg', 'locks', 'ticket-8.lock'), 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.equal(held.takenOverFrom, pid);
  await locks.release(handle);
});

test('concurrent takeovers of a dead lock grant exactly one owner', async (t) => {
  const commonDir = await tempCommonDir(t);
  const pid = deadPid();
  const path = join(commonDir, 'gg', 'locks', 'repo.lock');
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  for (let round = 0; round < 20; round++) {
    await writeFile(path, JSON.stringify({ pid, startedAt: `round ${round}` }));
    const handles = (await Promise.all(Array.from({ length: 8 }, () => locks.tryAcquire(commonDir, 'repo')))).filter(Boolean);
    assert.equal(handles.length, 1, `round ${round}: one owner`);
    const held = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(held.startedAt, handles[0].startedAt, `round ${round}: the file names the owner`);
    await locks.release(handles[0]);
  }
});

test('a lock left half-written by an interrupted holder is taken over', async (t) => {
  const commonDir = await tempCommonDir(t);
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  for (const partial of ['', '{"pid":']) {
    await writeFile(join(commonDir, 'gg', 'locks', 'repo.lock'), partial);
    const handle = await locks.acquire(commonDir, 'repo', { timeoutMs: 500, pollMs: 20 });
    assert.equal(handle.takenOverFrom, null);
    await locks.release(handle);
  }
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
