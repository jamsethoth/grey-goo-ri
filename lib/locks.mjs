import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

export class LockTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`lock ${name} still held after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

const SQLITE_BUSY = 5;

export async function tryAcquire(commonDir, name) {
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  const path = join(commonDir, 'gg', 'locks', `${name}.db`);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    // SQLITE_BUSY means another connection holds the transaction: the lock is taken, not broken.
    if (err.errcode === SQLITE_BUSY) return null;
    throw err;
  }
  // The handle owns db: a collected DatabaseSync closes its connection and so releases the lock.
  return { path, pid: process.pid, startedAt: new Date().toISOString(), db };
}

export async function acquire(commonDir, name, { timeoutMs = 60_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = await tryAcquire(commonDir, name);
    if (handle) return handle;
    if (Date.now() >= deadline) throw new LockTimeoutError(name, timeoutMs);
    await sleep(pollMs);
  }
}

export async function release(handle) {
  handle.db.exec('ROLLBACK');
  handle.db.close();
}

export async function withLock(commonDir, name, fn) {
  const handle = await acquire(commonDir, name);
  try {
    return await fn();
  } finally {
    await release(handle);
  }
}
