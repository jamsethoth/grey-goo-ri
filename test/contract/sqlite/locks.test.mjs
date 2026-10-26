import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as locks from '../../../lib/locks.mjs';

const contender = fileURLToPath(new URL('../../support/lock-contender.mjs', import.meta.url));
const locksModule = new URL('../../../lib/locks.mjs', import.meta.url);

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

// Windows unlocks a terminated process's locks after a delay that depends on system resources, so these wait for the
// lock itself. A lock that is never freed fails at the case timeout, which aborts t.signal and ends the wait.
async function acquireWhenFreed(t, commonDir) {
  for (;;) {
    const handle = await locks.tryAcquire(commonDir, 'repo');
    if (handle) return handle;
    await sleep(20, undefined, { signal: t.signal });
  }
}

test('a holder that exits without release frees the lock', { timeout: 120_000 }, async (t) => {
  const commonDir = await tempCommonDir(t);
  const script = `import * as locks from ${JSON.stringify(locksModule.href)};
const handle = await locks.tryAcquire(${JSON.stringify(commonDir)}, 'repo');
process.stdout.write(JSON.stringify({ handle }), () => process.exit(0));`;
  const { exited, report } = await startHolder(t, ['--input-type=module', '-e', script]);
  assert.ok(report.handle, 'the child held the lock');
  assert.equal(report.handle.path, join(commonDir, 'gg', 'locks', 'repo.db'));
  await exited;
  const handle = await acquireWhenFreed(t, commonDir);
  assert.ok(handle);
  await locks.release(handle);
});

test('a killed holder frees the lock', { timeout: 120_000 }, async (t) => {
  const commonDir = await tempCommonDir(t);
  const { child, exited, report } = await startHolder(t, [contender, commonDir, 'repo', '60000']);
  assert.ok(report.handle, 'the child holds the lock');
  assert.equal(report.handle.path, join(commonDir, 'gg', 'locks', 'repo.db'));
  child.kill();
  await exited;
  const handle = await acquireWhenFreed(t, commonDir);
  assert.ok(handle);
  await locks.release(handle);
});

// Runs an ES module script in a node child started with `flags`, resolving with its exit code, stdout and stderr.
function runScript(flags, script) {
  const child = spawn(process.execPath, [...flags, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

// A lock whose connection only a local variable held would be freed by the first collection; gc() forces one now.
test('a handle keeps the lock while it is referenced', async (t) => {
  const commonDir = await tempCommonDir(t);
  const script = `import * as locks from ${JSON.stringify(locksModule.href)};
const handle = await locks.tryAcquire(${JSON.stringify(commonDir)}, 'repo');
globalThis.gc();
await new Promise((resolve) => setImmediate(resolve));
const second = await locks.tryAcquire(${JSON.stringify(commonDir)}, 'repo');
process.stdout.write(JSON.stringify({ owns: !!handle?.db, second }));
await locks.release(handle);`;
  const { code, out, err } = await runScript(['--expose-gc'], script);
  assert.deepEqual({ code, err }, { code: 0, err: '' });
  assert.deepEqual(JSON.parse(out), { owns: true, second: null }, 'the handle owns the connection, and after a collection the lock is still held');
});

test('the lock module needs no experimental flag for node:sqlite', async (t) => {
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=24.15');
  const commonDir = await tempCommonDir(t);
  const script = `import * as locks from ${JSON.stringify(locksModule.href)};
await locks.release(await locks.tryAcquire(${JSON.stringify(commonDir)}, 'repo'));`;
  const { code, err } = await runScript([], script);
  assert.deepEqual({ code, err }, { code: 0, err: '' }, 'taking a lock in a flagless node prints no ExperimentalWarning');
});

// A clock whose sleeps pass at once, moving its time on and running `during` first.
const clockOf = (during = () => {}) => {
  let now = 0;
  const sleeps = [];
  return { sleeps, now: () => now, sleep: async (ms) => { sleeps.push(ms); await during(); now += ms; } };
};

test('acquire waits for release', async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  const clock = clockOf(() => locks.release(first));
  const second = await locks.acquire(commonDir, 'repo', { timeoutMs: 5_000, pollMs: 20, clock });
  assert.equal(second.waited, true, 'waited for the holder');
  assert.deepEqual(clock.sleeps, [20], 'one poll, after which the holder had released');
  await locks.release(second);
});

test('acquire times out', async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  const clock = clockOf();
  await assert.rejects(locks.acquire(commonDir, 'repo', { timeoutMs: 150, pollMs: 50, clock }), (err) => {
    assert.ok(err instanceof locks.LockTimeoutError);
    return true;
  });
  assert.deepEqual(clock.sleeps, [50, 50, 50], 'polled until the deadline');
  await locks.release(first);
});

test('withLock forwards its acquisition timeout without invoking the callback', { timeout: 10_000 }, async (t) => {
  const commonDir = await tempCommonDir(t);
  const first = await locks.acquire(commonDir, 'repo');
  let ran = false;
  await assert.rejects(locks.withLock(commonDir, 'repo', async () => { ran = true; }, { timeoutMs: 150, pollMs: 20, clock: clockOf() }),
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

// Simultaneous BEGIN EXCLUSIVE can hand every contender SQLITE_BUSY (ADR 0008), so no owner is a valid outcome; the lock
// must then be free, not wedged. Repeating the race is lock-stress.mjs's job, not the suite's.
test('contending processes never throw and grant at most one owner', { timeout: 120_000 }, async (t) => {
  const commonDir = await tempCommonDir(t);
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
  assert.deepEqual(outputs.filter((o) => o.error), [], 'no contender throws');
  const won = outputs.filter((o) => o.handle).length;
  assert.ok(won <= 1, `at most one owner, got ${won}`);
  const handle = await acquireWhenFreed(t, commonDir);
  assert.ok(handle, 'the lock is free once every contender has exited');
  await locks.release(handle);
});

test('the stress loop counts a run as clean only on exit 0 with a # fail 0 summary', async () => {
  const stress = await import('../../support/lock-stress.mjs');
  const tap = '# tests 6\n# pass 6\n# fail 0\n';
  assert.equal(stress.passed(0, null, tap), true);
  assert.equal(stress.passed(1, null, ''), false, 'an empty-output failure is not clean');
  assert.equal(stress.passed(0, null, ''), false, 'no summary is not clean');
  assert.equal(stress.passed(1, null, tap), false, 'a non-zero exit is not clean');
  assert.equal(stress.passed(null, 'SIGTERM', tap), false, 'a signal is not clean');
  assert.equal(stress.passed(0, null, '# pass 0\n# fail 0\n'), false, 'a run with no passing tests is not clean');
});
