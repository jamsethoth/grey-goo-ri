// What every recorder of an Agent CLI does the same way (#480): the names it records chosen with the chain of calls
// that continue one another checked, the text a value fills into, the environment a nested CLI starts with, the
// redaction of what it commits, the stand-in API server some calls run against, the temporary directory its
// repositories live in, and a call's saved files. How a call starts, and what its CLI's output means, stays each
// recorder's.

// A scenario or a command a recorder can name; a scenario that continues another needs it recorded before it.
export interface Named {
  name: string;
}

// The scenarios and commands `names` chose, in order (no name: every one), or the error and usage a recorder prints:
// a name it does not know, --help, or a scenario whose `continuesOf` is not chosen too.
export function chosenOf<Scenario extends Named, Command extends Named>(
  _names: string[],
  _recordable: {
    scenarios: Scenario[];
    commands: Command[];
    continuesOf: (scenario: Scenario) => string | undefined;
    usage: string;
  },
): { scenarios: Scenario[]; commands: Command[] } | { error: string } {
  return { scenarios: [], commands: [] };
}

// `text` with each {key} that `values` holds replaced by its value; an unknown key stays as written.
export const fill = (text: string, _values: Record<string, string>): string => text;

// The environment a nested CLI starts with: this process's, less every variable `inherited` matches (the session's
// own, which the CLI would read as its parent's), with `env` over it.
export function environmentOf(_inherited: RegExp, env: Record<string, string>): Record<string, string> {
  return env;
}

// What a recorder replaces in the text it commits: each path, as written, with either slash, escaped in JSON once or
// more, as Git Bash writes it and as a directory name made of it, by its label; the user's name where it stands whole;
// email addresses; and each of `patterns`, a recorder's own keys and tokens.
export function redactorOf(_redacted: {
  paths: [string, string][];
  username: string;
  patterns?: [RegExp, string][];
}): (text: string) => string {
  return (text) => text;
}

// An answer of the stand-in API server.
export interface StandInAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// A stand-in for a CLI's API on localhost: each request answered by `answer` from its path, or 404 when it gives null,
// and each kept as `<method> <path> <status>`.
export function startStandIn(_answer: (path: string) => StandInAnswer | null): Promise<{
  url: string;
  requests: string[];
  close: () => void;
}> {
  return Promise.resolve({ url: '', requests: [], close: () => {} });
}

// A fresh temporary directory named from `prefix`, by its real path, which a recorder leaves for a person to read.
export const temporary = (_prefix: string): string => '';

// A call's saved files in `output`: <name>.jsonl, its lines, and <name>.json, its meta, each redacted.
export function save(
  _output: string,
  _name: string,
  _recorded: { redact: (text: string) => string; lines: string[]; meta: object },
): void {}
