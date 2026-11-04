import { parseArgs } from 'node:util';

// Argument errors carry `usage` so the CLI prints the usage text with them.
export class UsageError extends Error {
  usage = true;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// The allowed boolean and value flags; anything else is a UsageError.
export interface OptionSpec {
  bools?: string[];
  values?: string[];
}
// The positionals under `_`, then each flag given, by name.
export type ParsedOptions = { _: string[] } & Record<string, unknown>;

export function parseOptions(args: string[], spec: OptionSpec): ParsedOptions {
  const options = Object.fromEntries([
    ...(spec.bools ?? []).map((name) => [name, { type: 'boolean' as const }]),
    ...(spec.values ?? []).map((name) => [name, { type: 'string' as const }]),
  ]);
  try {
    const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true });
    return { _: positionals, ...values };
  } catch (err) {
    const { code, message } = err as { code?: string; message: string };
    // parseArgs names the flag in quotes, e.g. "Option '--plan <value>' argument missing".
    const flag = /'(-[^' ]*)/.exec(message)?.[1] ?? '';
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError(`unknown option ${flag}`);
    if (code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw err;
    throw new UsageError(
      spec.bools?.includes(flag.slice(2)) ? `${flag} does not take a value` : `${flag} needs a value`,
    );
  }
}

export function positiveInteger(value: unknown, what: string): number {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new UsageError(`${what} must be a positive integer, got "${value}"`);
  return Number(value);
}
