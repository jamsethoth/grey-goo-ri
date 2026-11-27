// What scripts/record-codex.ts commits of a call (#479, owner Q4 A): the local paths, the user's name, email addresses,
// keys and tokens replaced wherever they appear, the name before addresses, where scripts/cli-recording.ts replaces
// addresses first (until #534 moves this recorder onto it); the account's ids and the repository URL replaced by key;
// and a session file trimmed of OpenAI's base instructions, encrypted reasoning, and the developer messages' text,
// which lists the user's own skills and plugins.
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

// The keys whose string value names the account or the machine.
export const ACCOUNT_KEYS = /account_id|user_id|^email$|repository_url|installation_id|^creator_/i;
// The gg checkout the recorder runs from, which the job listing names (lib/containment-gate.ts).
const CHECKOUT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TRIMMED_KEYS = new Set(['base_instructions', 'encrypted_content']);

// The user's name as a pattern: anywhere, or with `wholeName` only where it is not joined to a word.
const nameRule = (name: string, wholeName: boolean): [RegExp, string] => [
  new RegExp(wholeName ? `(?<![\\w-])${name}(?![\\w-])` : name, 'gi'),
  '<user>',
];

// The text replacements: as written, with forward slashes, JSON-escaped, as Git Bash writes a path, and as a
// directory name made of it. `wholeName`, for the privacy test's check of committed text alone, matches the user's
// name only where it is not joined to letters, digits, `_` or `-`: Ubuntu CI's `runner` is inside Codex's own
// `codex-command-runner.exe`, which the recorder, on that machine, would redact. A null `username` reads no name: the
// privacy test's scan under CI, where nothing is recorded (owner D1 A).
export function redactorOf(
  base: string,
  { username = userInfo().username, wholeName = false }: { username?: string | null; wholeName?: boolean } = {},
) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A path's separators as any run of slashes or backslashes: written, forward, or escaped once or more (a -c value
  // that quotes a path, saved in a JSON argv, then in an error line); as Git Bash writes it; and as a directory name.
  const forms = (path: string) => {
    const separated = path.split(/[\\/]/).map(escape).join('[\\\\/]+');
    const bash = separated.replace(/^([A-Za-z]):/, (_whole, drive: string) => `/${drive.toLowerCase()}`);
    return [separated, bash, escape(path.replace(/[^A-Za-z0-9]/g, '-'))];
  };
  const pairs: [RegExp, string][] = [
    ...forms(base).map((form): [RegExp, string] => [new RegExp(form, 'gi'), '<recording>']),
    ...forms(CHECKOUT).map((form): [RegExp, string] => [new RegExp(form, 'gi'), '<gg>']),
    ...forms(homedir()).map((form): [RegExp, string] => [new RegExp(form, 'gi'), '<home>']),
    ...(username === null ? [] : [nameRule(escape(username), wholeName)]),
    [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>'],
    [/sk-[\w-]{16,}/g, 'sk-<redacted>'],
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  ];
  return (text: string) =>
    pairs.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim()) ?? '';

// A developer message's text, or a tool list, reduced to what names it.
function trimmedItem(item: Record<string, unknown>): Record<string, unknown> | null {
  if (item.type === 'message' && item.role === 'developer' && Array.isArray(item.content))
    return {
      ...item,
      content: item.content.map((part: unknown) =>
        typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
          ? { ...part, text: `<trimmed developer text, ${part.text.length} characters: ${firstLine(part.text)}>` }
          : part,
      ),
    };
  if (item.type === 'additional_tools') return { ...item, tools: toolNames(item.tools) };
  return null;
}

// The names of a tool list, nested namespaces as name[members].
export function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: unknown) => {
    if (typeof tool !== 'object' || tool === null || !('name' in tool) || typeof tool.name !== 'string') return [];
    const members = 'tools' in tool ? toolNames(tool.tools) : [];
    return [members.length ? `${tool.name}[${members.join(',')}]` : tool.name];
  });
}

// A parsed value with the trims and the by-key redactions applied, at any depth.
export function trimmed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trimmed);
  if (typeof value !== 'object' || value === null) return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(trimmedItem(item) ?? item).map(([key, child]) => {
      if (TRIMMED_KEYS.has(key) && child != null) return [key, '<trimmed>'];
      if (ACCOUNT_KEYS.test(key) && typeof child === 'string') return [key, '<redacted>'];
      return [key, trimmed(child)];
    }),
  );
}

// A JSON line trimmed and redacted, or a line that is not JSON redacted as it came.
export function committedLine(line: string, redact: (text: string) => string) {
  try {
    const parsed: unknown = JSON.parse(line);
    return redact(JSON.stringify(trimmed(parsed)));
  } catch {
    return redact(line);
  }
}
