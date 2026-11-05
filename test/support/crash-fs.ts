// An fs that crashes a restore partway, for the cases that crash a rollback.
import fsPromises from 'node:fs/promises';
import * as interpreter from '../../lib/interpreter.ts';

// The fs a restore uses (integrity.createIntegrity's), crashing the `nth` `op` (rm or writeFile) on a path under `root`
// once `active()` holds, after the call has run when `after` is set.
export function crashFs(
  root: string,
  active: () => boolean,
  { op, nth, after = false }: { op: 'rm' | 'writeFile'; nth: number; after?: boolean },
) {
  const calls = { count: 0 };
  const real = fsPromises[op] as (path: unknown, ...rest: unknown[]) => Promise<void>;
  return {
    ...fsPromises,
    [op]: async (path: unknown, ...rest: unknown[]) => {
      if (!active() || !String(path).startsWith(root) || ++calls.count !== nth) return real(path, ...rest);
      if (after) await real(path, ...rest);
      throw new interpreter.CrashError(`crash at ${op} ${nth}`);
    },
  };
}
