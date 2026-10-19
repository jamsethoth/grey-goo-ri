import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// git reports paths with symlinks, junctions and Windows 8.3 names resolved, so a path gg was given compares equal to
// git's only in this form. A path that does not exist yet keeps its missing tail on its nearest existing ancestor.
export function canonical(p) {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonical(parent), basename(abs));
  }
}

// Windows paths are case-insensitive, so equality must not hinge on how a caller cased the path.
export const pathKey = (p) => (process.platform === 'win32' ? canonical(p).toLowerCase() : canonical(p));
