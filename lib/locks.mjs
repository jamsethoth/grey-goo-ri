import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

export class LockTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`lock ${name} still held after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
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

async function create(path, data) {
  try {
    await writeFile(path, JSON.stringify(data), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

export async function tryAcquire(commonDir, name) {
  const path = lockPath(commonDir, name);
  await mkdir(join(commonDir, 'gg', 'locks'), { recursive: true });
  const data = { pid: process.pid, startedAt: new Date().toISOString() };
  if (await create(path, data)) return { path, ...data, takenOverFrom: null };
  let holder;
  try {
    holder = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    // Released between our create and read, or half-written by its holder: retry on the next call.
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
  if (alive(holder.pid)) return null;
  await rm(path, { force: true });
  const taken = { ...data, takenOverFrom: holder.pid };
  return (await create(path, taken)) ? { path, ...taken } : null;
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

export function release(handle) {
  return rm(handle.path, { force: true });
}

export async function withLock(commonDir, name, fn) {
  const handle = await acquire(commonDir, name);
  try {
    return await fn();
  } finally {
    await release(handle);
  }
}
