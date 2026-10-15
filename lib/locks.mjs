import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

export class LockTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`lock ${name} still held after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

// Windows keeps a removed lock file "delete pending" while another process still reads it, and for those
// few milliseconds opening, linking or removing that name fails with EPERM (EACCES, EBUSY on some volumes).
// The lock is then in flux: retry briefly, and if it never settles report null rather than throw.
export const IN_FLUX = Symbol('lock in flux');
const FLUX_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function settle(fn, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!FLUX_CODES.has(err.code)) throw err;
      await sleep(2 * (i + 1));
    }
  }
  return IN_FLUX;
}

function lockPath(commonDir, name) {
  return join(commonDir, 'gg', 'locks', `${name}.lock`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Written aside then hard-linked into place: link fails on an existing path, so nobody ever sees a partial file.
async function publish(path, data) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || FLUX_CODES.has(err.code)) return false;
    throw err;
  } finally {
    await settle(() => rm(tmp, { force: true }));
  }
}

async function readRaw(path) {
  return settle(async () => {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
}

function holderPid(raw) {
  try {
    const pid = JSON.parse(raw)?.pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function holderAlive(raw) {
  const pid = holderPid(raw);
  return pid !== null && alive(pid);
}

export async function tryAcquire(commonDir, name) {
  const path = lockPath(commonDir, name);
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  const data = { pid: process.pid, startedAt: new Date().toISOString() };
  if (await publish(path, data)) return { path, ...data, takenOverFrom: null };
  // A lock we cannot parse was left by an interrupted holder of an older format: treat it as dead.
  const stale = await readRaw(path);
  if (stale === null || stale === IN_FLUX || holderAlive(stale)) return null;
  // Only one process may replace a given stale content: it must first claim it exclusively. A claim whose
  // claimant died passes to the next index, so a crash mid-takeover never wedges the lock.
  const key = createHash('sha256').update(stale).digest('hex').slice(0, 16);
  let claim;
  for (let k = 0; ; k++) {
    claim = `${path}.${key}.${k}.claim`;
    if (await publish(claim, { pid: process.pid })) break;
    const claimant = await readRaw(claim);
    if (claimant === IN_FLUX || (claimant !== null && holderAlive(claimant))) return null;
  }
  try {
    // A slower contender may claim after an earlier takeover finished; the lock no longer matches what it saw.
    if ((await readRaw(path)) !== stale) return null;
    if ((await settle(() => rm(path, { force: true }))) === IN_FLUX) return null;
    // Between this rm and publish a fresh contender can win with takenOverFrom null; ownership stays
    // exclusive either way, so takenOverFrom is best-effort diagnostics, not a guarantee.
    const taken = { ...data, takenOverFrom: holderPid(stale) };
    return (await publish(path, taken)) ? { path, ...taken } : null;
  } finally {
    await settle(() => rm(claim, { force: true }));
  }
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
  await settle(() => rm(handle.path, { force: true }));
}

export async function withLock(commonDir, name, fn) {
  const handle = await acquire(commonDir, name);
  try {
    return await fn();
  } finally {
    await release(handle);
  }
}
