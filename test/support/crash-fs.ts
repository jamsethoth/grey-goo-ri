// An fs that crashes a restore partway, for the cases that crash a rollback.
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';

// The fs a restore uses (integrity.createIntegrity's), crashing the `op` (rm or writeFile) on `path`, relative to
// `root`, once `active()` holds, after the call has run when `after` is set. By path rather than by count, so a further
// call before it leaves the crash where it was.
export function crashFs(
  root: string,
  active: () => boolean,
  { op, path, after = false }: { op: 'rm' | 'writeFile'; path: string; after?: boolean },
) {
  const real = fsPromises[op] as (target: unknown, ...rest: unknown[]) => Promise<void>;
  return {
    ...fsPromises,
    [op]: async (target: unknown, ...rest: unknown[]) => {
      if (!active() || String(target) !== join(root, path)) return real(target, ...rest);
      if (after) await real(target, ...rest);
      throw new interpreter.CrashError(`crash at ${op} ${path}`);
    },
  };
}
