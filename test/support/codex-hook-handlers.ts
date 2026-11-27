// The command hooks a Codex launch installs, read back from its `-c hooks={...}` override (#485): each handler's keys
// by event, its strings decoded. Codex takes the override as a TOML inline table, whose basic strings gg writes as JSON
// strings (lib/harnesses/codex.ts, tomlString), so a string decodes with JSON.parse.

export interface HookHandler {
  event: string;
  keys: Record<string, string>;
}

// A handler is an inline table that starts with its type, as the recorded hooks write it (hooks-on).
// A TOML basic string, or a bare value up to the next comma or closing brace.
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^,}\]]+`;
const PAIR = new RegExp(String.raw`([A-Za-z_]+)=(${VALUE})`, 'g');
const HANDLER = new RegExp(String.raw`\{type="command"((?:,[A-Za-z_]+=(?:${VALUE}))*)\}`, 'g');
const EVENT = /([A-Z][A-Za-z]+)=\[\{/g;

const decoded = (value: string) => (value.startsWith('"') ? (JSON.parse(value) as string) : value);

// Every `-c` override argv passes, in order.
export const overrides = (argv: readonly string[]) =>
  argv.flatMap((argument, index) => (argv[index - 1] === '-c' ? [argument] : []));

// The launch's `hooks=` overrides.
export const hooksOverrides = (argv: readonly string[]) =>
  overrides(argv).filter((value) => value.startsWith('hooks='));

// Each command handler of the launch's hooks overrides, with the event it is listed under.
export function hookHandlers(argv: readonly string[]): HookHandler[] {
  return hooksOverrides(argv).flatMap((override) => {
    const events = [...override.matchAll(EVENT)].map((match) => ({ event: match[1]!, offset: match.index }));
    return [...override.matchAll(HANDLER)].map((match) => ({
      event: events.findLast(({ offset }) => offset < match.index)?.event ?? '',
      keys: Object.fromEntries(
        [...`type="command"${match[1]!}`.matchAll(PAIR)].map((pair) => [pair[1]!, decoded(pair[2]!)]),
      ),
    }));
  });
}
