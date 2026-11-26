// The Windows watcher's periodic process snapshot, taken on a thread of its own over its own kernel32: every node:ffi
// call is synchronous, so a slow snapshot on gg's thread would block the clocks that judge the command (#531 D1 A).
// lib/job-watcher.ts starts it as a worker; each message asks for one snapshot.
import { parentPort } from 'node:worker_threads';
import * as containment from './containment.ts';

const kernel32 = containment.openKernel32();
parentPort?.on('message', () => {
  try {
    if (!kernel32) throw new Error('node:ffi is not available to the snapshot thread');
    parentPort?.postMessage({ entries: containment.processes(kernel32) });
  } catch (err) {
    parentPort?.postMessage({ error: (err as Error).message });
  }
});
