// The stream-json lines recorded from Claude Code (test/fixtures/claude/<name>.jsonl, #425), and the line kinds a case
// picks among them: `type/subtype`, or `type` for a line without a subtype.
import { readFileSync } from 'node:fs';

export const lines = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);

const kindOf = (line: string) => {
  const { type, subtype } = JSON.parse(line) as { type: string; subtype?: string };
  return subtype === undefined ? type : `${type}/${subtype}`;
};

// The lines of `recorded` of one of `kinds`, or of none of them.
export const only = (recorded: string[], ...kinds: string[]) => recorded.filter((line) => kinds.includes(kindOf(line)));
export const without = (recorded: string[], ...kinds: string[]) =>
  recorded.filter((line) => !kinds.includes(kindOf(line)));

// `line` with `field` set to `value`.
export const withField = (line: string, field: string, value: unknown) =>
  JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), [field]: value });
