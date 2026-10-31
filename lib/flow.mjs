import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The Resolved Flow the validator gave admission, and its Config Hash, in the Run's directory.
export function writeResolved(runDir, resolved, hash) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'flow.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  writeFileSync(join(runDir, 'config-hash.txt'), `${hash}\n`);
}
