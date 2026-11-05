// git run as a test runs it outside gg, the way a human or another tool would, for the tests whose subject is git
// behaviour. Spawns git, so a test that calls it is medium (docs/testing.md).
import { execFileSync } from 'node:child_process';

// git's trimmed stdout. A last `{ input }` argument is written to git's stdin.
export function sh(cwd: string, ...args: (string | { input: string })[]): string {
  const last = args.at(-1);
  const input = typeof last === 'object' ? last.input : undefined;
  const gitArgs = args.filter((arg): arg is string => typeof arg === 'string');
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', input }).trim();
}
