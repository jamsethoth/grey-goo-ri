// How the fake git (test/support/fake-git.ts) reads paths and file contents as git does: .gitignore rules, `within`
// and saved pathspecs, and line diffs.
import * as checks from '../../lib/checks.ts';
import type * as integrity from '../../lib/integrity.ts';

export type Files = Map<string, Buffer>;
type PathTest = (path: string) => boolean;

export const sorted = (list: Iterable<string>): string[] =>
  [...list].sort((left, right) => (left < right ? -1 : Number(left > right)));

const GLOB_PARTS = new Map([
  ['**/', '(?:.*/)?'],
  ['**', '.*'],
  ['*', '[^/]*'],
  ['?', '[^/]'],
]);
const globRe = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((part) => GLOB_PARTS.get(part) ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('')}$`,
  );

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

// A .gitignore line as git reads it: `dir/` matches directories only, a slash elsewhere anchors it to the root, `*` and
// `?` stay within a path segment and `**` crosses them.
// shortcut: only the worktree root's .gitignore, without `!` negation; tests whose ignore rules need more stay on real
// git.
export function ignoreRules(text: string): IgnoreRule[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const dirOnly = line.endsWith('/');
      const body = line.replace(/^\//, '').replace(/\/$/, '');
      return { re: globRe(body), dirOnly, anchored: line.slice(0, -1).includes('/') };
    });
}

export const isIgnored = (rules: IgnoreRule[], path: string): boolean => {
  const parts = path.split('/');
  return rules.some(({ re, dirOnly, anchored }) =>
    parts.some(
      (_, i) =>
        !(dirOnly && i === parts.length - 1) &&
        re.test(anchored ? parts.slice(0, i + 1).join('/') : (parts[i] as string)),
    ),
  );
};

// A saved pathspec: a literal path matches itself and what is under it, `icase` folds case, `glob` is a glob and
// `exclude` removes matches; with only exclusions everything else matches.
function pathspecTest(spec: string): { test: PathTest; exclude: boolean } {
  const [, magic = '', body = ''] = spec.match(/^(?::\(([a-z,]+)\))?(.*)$/) ?? [];
  const words = magic.split(',');
  const fold = words.includes('icase') ? (text: string) => text.toLowerCase() : (text: string) => text;
  const exclude = words.includes('exclude');
  if (words.includes('glob')) {
    const glob = globRe(body);
    return { test: (path) => glob.test(path), exclude };
  }
  if (body === '.') return { test: () => true, exclude };
  return { test: (path) => fold(path) === fold(body) || fold(path).startsWith(`${fold(body)}/`), exclude };
}

function pathspecMatcher(specs: string[]): PathTest {
  const tests = specs.map(pathspecTest);
  const include = tests.filter((spec) => !spec.exclude).map((spec) => spec.test);
  const exclude = tests.filter((spec) => spec.exclude).map((spec) => spec.test);
  return (path) => (!include.length || include.some((test) => test(path))) && !exclude.some((test) => test(path));
}

// `within` as lib/git.ts reads it: { paths, globs, exclude }, where a path matches itself and what is under it, folding
// case on Windows, and with only exclusions everything else matches; or the pathspecs a reset intent saved before #144.
export function withinMatcher(within: integrity.Within | undefined): PathTest {
  if (!within) return () => true;
  if (Array.isArray(within)) return pathspecMatcher(within);
  const fold = process.platform === 'win32' ? (text: string) => text.toLowerCase() : (text: string) => text;
  const under = (within.paths ?? []).map((path) => fold(path.replace(/\/+$/, '')));
  // git reads a glob preflight accepts as its :(glob,icase) pathspec the way the test path matcher does
  // (test/e2e/checks.test.ts shows it), so the fake reads every glob with that matcher.
  const globbed = checks.testPathMatcher(within.globs ?? []);
  const excluded = checks.testPathMatcher(within.exclude ?? []);
  const included = (path: string) =>
    (!under.length && !within.globs?.length) ||
    under.some((base) => fold(path) === base || fold(path).startsWith(`${base}/`)) ||
    globbed(path);
  return (path) => included(path) && !excluded(path);
}

// Lines with their endings, so a missing final newline is a change as it is to git.
export const lines = (content: Buffer): string[] => content.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
export const isBinary = (content: Buffer | undefined): boolean => !!content && content.includes(0);

// The length of the longest common subsequence of two line lists.
export function lcs(first: string[], second: string[]): number {
  const row: number[] = new Array(second.length + 1).fill(0);
  for (const line of first) {
    let diagonal = 0;
    for (let j = 1; j <= second.length; j++) {
      const up = row[j] as number;
      row[j] = line === second[j - 1] ? diagonal + 1 : Math.max(up, row[j - 1] as number);
      diagonal = up;
    }
  }
  return row[second.length] as number;
}

// Paths whose content differs between two file maps, sorted.
export const differing = (from: Files, to: Files): string[] =>
  sorted(new Set([...from.keys(), ...to.keys()])).filter((path) => {
    const [before, after] = [from.get(path), to.get(path)];
    return !(before && after && before.equals(after));
  });

// The patch `git diff base...HEAD` prints for one path: whole files, since the fake keeps no hunks.
export function patchOf(path: string, before: Buffer | undefined, after: Buffer | undefined): string {
  if (isBinary(before) || isBinary(after)) return `diff --git a/${path} b/${path}\nBinary files differ\n`;
  const removed = before ? lines(before).map((line) => `-${line}`) : [];
  const added = after ? lines(after).map((line) => `+${line}`) : [];
  const header = `--- ${before ? `a/${path}` : '/dev/null'}\n+++ ${after ? `b/${path}` : '/dev/null'}\n`;
  return `diff --git a/${path} b/${path}\n${header}${[...removed, ...added].join('')}`;
}

// A minimal line diff's counts, which are git's whatever path its diff takes.
export function statsOf(path: string, before: Buffer | undefined, after: Buffer | undefined) {
  if (isBinary(before) || isBinary(after)) return { path, insertions: null, deletions: null };
  const [removed, added] = [before ? lines(before) : [], after ? lines(after) : []];
  const common = lcs(removed, added);
  return { path, insertions: added.length - common, deletions: removed.length - common };
}
