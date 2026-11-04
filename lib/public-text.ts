// Redaction of the local directories in text gg publishes: commit messages, comments, PR bodies and Check output.
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as paths from './paths.ts';

// Errors, agent prose and Check output can all contain local directories; redact before hashing public bodies.
export function publicText(given: unknown, directories: (string | null | undefined)[] = []): string {
  // Configuration such as an unset model or effort arrives as null and renders as it always has.
  let text = String(given);
  const boundary = /(?<![\p{L}\p{N}_./\\~-])/u.source;
  const start = /(?<!\[local\])(?:file:\/\/\/?)?/.source;
  // A percent escape after the directory continues its last name, as a letter does.
  const end = /(?![\p{L}\p{N}_~-]|\.[\p{L}\p{N}_-]|%[0-9a-fA-F]{2})/u.source;
  // git and tools report canonical paths while gg was handed linked or 8.3 spellings, so both forms are masked.
  const masked = [...directories, homedir(), tmpdir(), fileURLToPath(new URL('../', import.meta.url))]
    .flatMap((path) => (path && isAbsolute(path) ? [path, paths.canonical(path)] : [path]))
    .map((path) =>
      path
        ?.replaceAll('\\', '/')
        .replace(/^\/\/\?\/UNC\//i, '//')
        .replace(/^\/\/\?\//, '')
        .replace(/\/+$/, ''),
    )
    .filter((path): path is string => !!path && path.length > 3 && path !== posix.parse(path).root)
    .filter((path) => path !== win32.parse(path).root)
    .flatMap((path) => {
      const windows = /^(?:[a-z]:\/|\/\/)/i.test(path);
      const aliases = [path];
      if (/^[a-z]:\//i.test(path)) aliases.push(`/?/${path}`, `/${path[0]}${path.slice(2)}`);
      if (path.startsWith('//')) aliases.push(`//?/UNC/${path.slice(2)}`, `file:${path}`);
      if (path.startsWith('/var/')) aliases.push(`/private${path}`);
      return aliases.map((alias) => ({ path: alias, windows, single: /^\/[^/]+$/.test(path) }));
    })
    .sort((first, second) => second.path.length - first.path.length);
  for (const { path, windows, single } of masked) {
    const folded = windows || process.platform === 'win32';
    // Short roots need boundaries; longer roots also occur inside flags such as -I/home/alice/inc.
    const directory = path
      .split('/')
      .map((part) => [...part].map((char) => pathChar(char, folded)).join(''))
      .join(/[\\/]+/.source);
    const pattern = (single ? boundary : '') + start + directory + end;
    text = text.replace(new RegExp(pattern, folded ? 'giu' : 'gu'), '[local]');
  }
  return text;
}

// File URLs, encodeURI and encodeURIComponent each escape a different set of characters, so any character an encoder
// may escape also matches its UTF-8 percent escape in either hex case; an escaped separator (%2F) is not matched.
// The case-insensitive flag folds literal letters only, so a folded match also takes the escapes of the other case.
// shortcut: an 8.3 alias is masked only when gg was given it; a known long path does not also mask its alias.
function pathChar(char: string, folded: boolean): string {
  const literal = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // pathToFileURL escapes ~, which 8.3 names such as RUNNER~1 contain.
  if (/[\w.-]/.test(char)) return literal;
  const forms = folded ? [...new Set([char, char.toLowerCase(), char.toUpperCase()])] : [char];
  const escaped = forms.map((form) =>
    [...new TextEncoder().encode(form)]
      .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
      .join('')
      .replace(/[a-f]/g, (hex) => `[${hex}${hex.toUpperCase()}]`),
  );
  return `(?:${[literal, ...escaped].join('|')})`;
}

export type Redact = (text: string) => string;

export const publicTextFor =
  ({ worktree, commonDir, cwd }: { worktree?: string | null; commonDir?: string | null; cwd?: string | null }) =>
  (text: unknown): string =>
    publicText(text, [worktree, commonDir, cwd]);

export function publicTail(given: unknown, redact: Redact = publicText, limit = 3000): string {
  const text = redact(String(given ?? ''));
  const cut = text.length - limit;
  if (cut <= 0) return text;
  // A newline that ends the text has no line after it to keep, so the tail falls back to characters.
  const newline = text.indexOf('\n', cut - 1);
  return newline >= 0 && newline < text.length - 1 ? text.slice(newline + 1) : text.slice(-limit);
}
