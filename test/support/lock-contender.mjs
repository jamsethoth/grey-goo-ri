// Spawned by the locks test: one process contending for a lock, printing its handle or its error as JSON.
import * as locks from '../../lib/locks.mjs';
const [commonDir, name, holdMs] = process.argv.slice(2);
try {
  const handle = await locks.tryAcquire(commonDir, name);
  process.stdout.write(JSON.stringify({ pid: process.pid, handle }));
  if (handle) await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
} catch (err) {
  process.stdout.write(JSON.stringify({ pid: process.pid, error: `${err.code} ${err.message}` }));
}
