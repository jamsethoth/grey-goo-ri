// The git pathspecs a listing's `within` limits it to, for lib/git.ts alone.
import type * as integrity from './integrity.ts';

// `within` limits a listing to { paths, globs, exclude }: `paths` match a path or anything under it,
// case-insensitively on Windows, which reads .AGENTS/ as .agents/; `globs` and `exclude` are globs that ignore case
// everywhere, as Test Immutability does (a plain :(glob) ignores it on Windows for some pathspec lists only). Without
// the trailing slash a directory symlink, a blob at the bare path, still matches. An array is the pathspecs a reset
// intent saved before #144.
export function pathspecs(within: integrity.Within | undefined) {
  if (!within) return [];
  if (Array.isArray(within)) return within.length ? ['--', ...within] : [];
  const { paths: literal = [], globs = [], exclude = [] } = within;
  const bare = literal.map((path) => path.replace(/\/+$/, ''));
  const included = [
    ...(process.platform === 'win32' ? bare.map((path) => `:(icase)${path}`) : bare),
    ...globs.map((glob) => `:(glob,icase)${glob}`),
  ];
  const combined = [
    ...(exclude.length && !included.length ? ['.'] : included),
    ...exclude.map((glob) => `:(exclude,glob,icase)${glob}`),
  ];
  return combined.length ? ['--', ...combined] : [];
}
