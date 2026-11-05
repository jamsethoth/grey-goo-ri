// Spawned by the locks test: one process contending for a lock, printing its handle or its error as JSON.
// With holdMs 'barrier' it prints ready, tries on the first stdin line and holds until stdin ends,
// so every contender tries while the owner still holds, however slowly the processes start.
// The test runner also loads this file with no arguments, where it does nothing.
import * as locks from '../../lib/locks.ts';

const [commonDir, name, holdMs] = process.argv.slice(2);
if (commonDir && name) {
  const barrier = holdMs === 'barrier';
  const ended = barrier ? new Promise((resolve) => process.stdin.on('end', resolve)) : null;
  if (barrier) {
    const go = new Promise((resolve) => process.stdin.once('data', resolve));
    process.stdin.resume();
    process.stdout.write('ready\n');
    await go;
  }
  try {
    const handle = await locks.tryAcquire(commonDir, name);
    process.stdout.write(JSON.stringify({ pid: process.pid, handle }) + '\n');
    if (handle) await (ended ?? new Promise((resolve) => setTimeout(resolve, Number(holdMs))));
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException;
    process.stdout.write(JSON.stringify({ pid: process.pid, error: `${code} ${message}` }) + '\n');
  }
}
