import { parseArgs } from 'node:util';

// Argument errors carry `usage` so the CLI prints the usage text with them.
export class UsageError extends Error { usage = true; }

// `spec` = { bools, values }: the allowed boolean and value flags; anything else is a UsageError.
export function parseOpts(args, spec) {
  const options = Object.fromEntries([...(spec.bools ?? []).map((name) => [name, { type: 'boolean' }]), ...(spec.values ?? []).map((name) => [name, { type: 'string' }])]);
  try {
    const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true });
    return { _: positionals, ...values };
  } catch (e) {
    // parseArgs names the flag in quotes, e.g. "Option '--plan <value>' argument missing".
    const flag = /'(-[^' ]*)/.exec(e.message)?.[1];
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError(`unknown option ${flag}`);
    if (e.code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw e;
    throw new UsageError(spec.bools?.includes(flag.slice(2)) ? `${flag} does not take a value` : `${flag} needs a value`);
  }
}

export function positiveInt(value, what) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new UsageError(`${what} must be a positive integer, got "${value}"`);
  return Number(value);
}
