// What every recorder of an Agent CLI does the same way (#480): the names it records chosen with the chain of calls
// that continue one another checked, the text a value fills into, the environment a nested CLI starts with, the
// redaction of what it commits, the stand-in API server some calls run against, the temporary directory its
// repositories live in, and a call's saved files. How a call starts, and what its CLI's output means, stays each
// recorder's.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scenario or a command a recorder can name; a scenario that continues another needs it recorded before it.
export interface Named {
  name: string;
}

// The scenarios and commands `names` chose, in order (no name: every one), or the error and usage a recorder prints:
// a name it does not know, --help, or a scenario whose `continuesOf` is not chosen too.
export function chosenOf<Scenario extends Named, Command extends Named>(
  names: string[],
  recordable: {
    scenarios: Scenario[];
    commands: Command[];
    continuesOf: (scenario: Scenario) => string | undefined;
    usage: string;
  },
): { scenarios: Scenario[]; commands: Command[] } | { error: string } {
  const { scenarios, commands, continuesOf, usage } = recordable;
  const known = [...scenarios, ...commands].map(({ name }) => name);
  const unknown = names.filter((name) => name !== '--help' && !known.includes(name));
  if (unknown.length) return { error: `unknown name: ${unknown.join(', ')}\n${usage}` };
  if (names.includes('--help')) return { error: usage };
  const chose = <Recorded extends Named>(recorded: Recorded[]) =>
    recorded.filter(({ name }) => !names.length || names.includes(name));
  const chosen = { scenarios: chose(scenarios), commands: chose(commands) };
  const missing = chosen.scenarios.flatMap((scenario) => {
    const continued = continuesOf(scenario);
    return continued === undefined || chosen.scenarios.some(({ name }) => name === continued)
      ? []
      : [`${scenario.name} continues ${continued}`];
  });
  return missing.length ? { error: `${missing.join('; ')}\n${usage}` } : chosen;
}

// `text` with each {key} that `values` holds replaced by its value; an unknown key stays as written.
export const fill = (text: string, values: Record<string, string>): string =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

// The environment a nested CLI starts with: this process's, less every variable `inherited` matches (the session's
// own, which the CLI would read as its parent's), with `env` over it.
export function environmentOf(inherited: RegExp, env: Record<string, string>): Record<string, string> {
  const kept = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !inherited.test(entry[0]),
  );
  return { ...Object.fromEntries(kept), ...env };
}

// What a recorder replaces in the text it commits: each path, as written, with either slash, escaped in JSON once or
// more, as Git Bash writes it and as a directory name made of it, by its label; each of `patterns`, a recorder's own
// keys and tokens, and then email addresses, each before the name, so a name inside a key or an address cannot break
// its match, an address's part before `@` taking the whole name even when it holds a space; and the user's name
// wherever it appears.
export function redactorOf(redacted: {
  paths: [string, string][];
  username: string;
  patterns?: [RegExp, string][];
}): (text: string) => string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A path's separators as any run of slashes or backslashes, since a tool result's JSON nested in a stream line
  // escapes it twice; its drive as Git Bash writes it; and the path as a directory name.
  const forms = (path: string) => {
    const separated = path
      .split(/[\\/]+/)
      .map(escape)
      .join('[\\\\/]+');
    const bash = separated.replace(/^([A-Za-z]):/, (_whole, drive: string) => `/${drive.toLowerCase()}`);
    return [separated, bash, escape(path.replace(/[^A-Za-z0-9]/g, '-'))];
  };
  const pairs: [RegExp, string][] = [
    ...redacted.paths.flatMap(([path, label]) =>
      forms(path).map((form): [RegExp, string] => [new RegExp(form, 'gi'), label]),
    ),
    ...(redacted.patterns ?? []),
    [new RegExp(`(?:${escape(redacted.username)}|[\\w.+-])+@[\\w-]+(?:\\.[\\w-]+)+`, 'gi'), '<email>'],
    [new RegExp(escape(redacted.username), 'gi'), '<user>'],
  ];
  // No pass rewrites a label an earlier pass wrote, so a username equal to a label's text (`user`, `home`) leaves it
  // whole. shortcut: a replacement is written as is, without `$1` groups; none of today's patterns uses one.
  const labels = [...new Set(pairs.flatMap(([, replacement]) => replacement.match(/<[^<>]+>/g) ?? []))];
  const inLabel = (text: string, start: number, end: number) =>
    labels.some((label) => {
      for (let found = text.indexOf(label); found !== -1; found = text.indexOf(label, found + 1))
        if (found <= start && end <= found + label.length) return true;
      return false;
    });
  return (text) =>
    pairs.reduce(
      (redactedText, [pattern, replacement]) =>
        redactedText.replace(pattern, (match: string, ...rest: unknown[]) => {
          const start = rest.find((arg) => typeof arg === 'number') as number;
          return inLabel(redactedText, start, start + match.length) ? match : replacement;
        }),
      text,
    );
}

// An answer of the stand-in API server.
export interface StandInAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// A stand-in for a CLI's API on localhost: each request answered by `answer` from its path, or 404 when it gives null,
// and each kept as `<method> <path> <status>`.
export async function startStandIn(answer: (path: string) => StandInAnswer | null): Promise<{
  url: string;
  requests: string[];
  close: () => void;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const answered = answer(path);
      requests.push(`${request.method} ${path} ${answered?.status ?? 404}`);
      if (answered) response.writeHead(answered.status, answered.headers).end(answered.body);
      else response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

// A fresh temporary directory named from `prefix`, by its real path, which a recorder leaves for a person to read.
export const temporary = (prefix: string): string => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

// A call's saved files in `output`: <name>.jsonl, its lines, and <name>.json, its meta, each redacted.
export function save(
  output: string,
  name: string,
  recorded: { redact: (text: string) => string; lines: string[]; meta: object },
): void {
  const text = recorded.lines.map(recorded.redact).join('\n');
  writeFileSync(join(output, `${name}.jsonl`), text && `${text}\n`);
  writeFileSync(join(output, `${name}.json`), `${recorded.redact(JSON.stringify(recorded.meta, null, 2))}\n`);
}
