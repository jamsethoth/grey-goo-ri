// Another gg process holding one of the locks, for the cases that contend with it. Spawns a process, so a test that
// calls it is medium (docs/testing.md).
import type { TestContext } from 'node:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONTENDER = fileURLToPath(new URL('./lock-contender.ts', import.meta.url));

export interface LockHolder {
  child: ChildProcess;
  exited: Promise<unknown>;
  report: { pid?: number; handle: { path: string; pid: number; startedAt: string } | null };
  // Kills the holder, which releases the lock, and resolves once it has exited.
  release: () => Promise<unknown>;
}

// Spawns `node args`, a process that takes a lock and prints its report as JSON, resolving once it has reported and
// failing if it exited first. The case's end kills it, after the cleanups registered before it.
export function startHolder(t: TestContext, args: string[]): Promise<LockHolder> {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const release = () => {
    child.kill();
    return exited;
  };
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
      try {
        resolve({ child, exited, report: JSON.parse(output), release });
      } catch {}
    });
    child.on('exit', () => reject(new Error(`holder exited before reporting: ${output}`)));
  });
}

// A process holding the lock `name`; it fails if the process did not get the lock. By default it holds longer than any
// case, so only the case releases it.
export async function holdLock(t: TestContext, commonDir: string, name: string, holdMs = 600_000) {
  const holder = await startHolder(t, [CONTENDER, commonDir, name, String(holdMs)]);
  if (!holder.report.handle) throw new Error(`holder did not get the lock: ${JSON.stringify(holder.report)}`);
  return holder;
}
