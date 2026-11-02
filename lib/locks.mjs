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

async function take(commonDir, name) {
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

export async function release(handle) {
  handle.db.exec('ROLLBACK');
  handle.db.close();
}

// The repo lock covers a fetch in ensureWorktree, so its waits outlast acquire's default.
export const REPO_LOCK_TIMEOUT_MS = 600_000;

// The locks, waiting on `clock` ({ now, sleep }), which times every wait. `wrapAttempt` sees each attempt: it gets
// { commonDir, name, waited } and the attempt, and returns its handle, or null for a lock that is taken. The entry point
// passes neither, so the wall clock times the waits and every attempt runs as it is; a test passes either to time,
// see or contend a lock.
export function createLocks({ clock = { now: Date.now, sleep }, wrapAttempt = (_lock, attempt) => attempt() } = {}) {
  const attempt = (commonDir, name, waited) => wrapAttempt({ commonDir, name, waited }, () => take(commonDir, name));

  const tryAcquire = (commonDir, name) => attempt(commonDir, name, false);

  // The handle's `waited` says whether another holder had the lock first.
  async function acquire(commonDir, name, { timeoutMs = 60_000, pollMs = 50 } = {}) {
    const deadline = clock.now() + timeoutMs;
    for (let waited = false; ; waited = true) {
      const handle = await attempt(commonDir, name, waited);
      if (handle) return Object.assign(handle, { waited });
      if (clock.now() >= deadline) throw new LockTimeoutError(name, timeoutMs);
      await clock.sleep(pollMs);
    }
  }

  async function withLock(commonDir, name, fn, options = {}) {
    const handle = await acquire(commonDir, name, options);
    try {
      return await fn(handle);
    } finally {
      await release(handle);
    }
  }

  return { tryAcquire, acquire, release, withLock, REPO_LOCK_TIMEOUT_MS };
}

// The real locks, for callers that take no seam.
export const { tryAcquire, acquire, withLock } = createLocks();
