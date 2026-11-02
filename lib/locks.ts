import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

export class LockTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`lock ${name} still held after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

// A held lock. `waited` is set by acquire, which says whether another holder had the lock first.
export interface LockHandle {
  path: string;
  pid: number;
  startedAt: string;
  db: DatabaseSync;
  waited?: boolean;
}

// What times a lock's waits: the wall clock at the entry point, a test's own clock in a test.
export interface LockClock {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

// One try at a lock, as `wrapAttempt` sees it.
export interface LockAttempt {
  commonDir: string;
  name: string;
  waited: boolean;
}

export interface AcquireOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const SQLITE_BUSY = 5;

async function take(commonDir: string, name: string): Promise<LockHandle | null> {
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  const path = join(commonDir, 'gg', 'locks', `${name}.db`);
  const connection = new DatabaseSync(path);
  try {
    connection.exec('PRAGMA busy_timeout = 0');
    connection.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    connection.close();
    // SQLITE_BUSY means another connection holds the transaction: the lock is taken, not broken.
    if ((err as { errcode?: unknown }).errcode === SQLITE_BUSY) return null;
    throw err;
  }
  // The handle owns the connection: a collected DatabaseSync closes it and so releases the lock.
  return { path, pid: process.pid, startedAt: new Date().toISOString(), db: connection };
}

export async function release(handle: LockHandle): Promise<void> {
  handle.db.exec('ROLLBACK');
  handle.db.close();
}

// The repo lock covers a fetch in ensureWorktree, so its waits outlast acquire's default.
export const REPO_LOCK_TIMEOUT_MS = 600_000;

// The locks, waiting on `clock` ({ now, sleep }), which times every wait. `wrapAttempt` sees each attempt: it gets
// { commonDir, name, waited } and the attempt, and returns its handle, or null for a lock that is taken. The entry
// point passes neither, so the wall clock times the waits and every attempt runs as it is; a test passes either to
// time, see or contend a lock.
export function createLocks({
  clock = { now: Date.now, sleep },
  wrapAttempt = (_lock, attempt) => attempt(),
}: {
  clock?: LockClock;
  wrapAttempt?: (lock: LockAttempt, attempt: () => Promise<LockHandle | null>) => Promise<LockHandle | null>;
} = {}) {
  const attempt = (commonDir: string, name: string, waited: boolean) =>
    wrapAttempt({ commonDir, name, waited }, () => take(commonDir, name));

  const tryAcquire = (commonDir: string, name: string) => attempt(commonDir, name, false);

  // The handle's `waited` says whether another holder had the lock first.
  async function acquire(
    commonDir: string,
    name: string,
    { timeoutMs = 60_000, pollMs = 50 }: AcquireOptions = {},
  ): Promise<LockHandle> {
    const deadline = clock.now() + timeoutMs;
    for (let waited = false; ; waited = true) {
      const handle = await attempt(commonDir, name, waited);
      if (handle) return Object.assign(handle, { waited });
      if (clock.now() >= deadline) throw new LockTimeoutError(name, timeoutMs);
      await clock.sleep(pollMs);
    }
  }

  async function withLock<T>(
    commonDir: string,
    name: string,
    work: (handle: LockHandle) => T | Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const handle = await acquire(commonDir, name, options);
    try {
      return await work(handle);
    } finally {
      await release(handle);
    }
  }

  return { tryAcquire, acquire, release, withLock, REPO_LOCK_TIMEOUT_MS };
}

// The locks the entry point builds and passes down as `locks` (ADR 0019).
export type Locks = ReturnType<typeof createLocks>;

// The real locks, for callers that take no seam.
export const { tryAcquire, acquire, withLock } = createLocks();
