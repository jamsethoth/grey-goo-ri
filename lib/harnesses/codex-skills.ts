// The skills list gg writes into a Codex call's prompt, for lib/harnesses/codex.ts alone (#481 D2 A): every call sets
// skills.include_instructions=false, which keeps the user's and the repository's skills out and Codex's own list with
// them, so gg lists the skills a call may use itself, each as Codex's own list gives it: name, description, file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  file: string;
}

const SKILL_FILE = 'SKILL.md';

// A top-level `key: value` line of a SKILL.md's front matter, its quotes taken off; a block scalar (`>` or `|`) or a
// plain value goes on over its indented lines, joined with one space, since the list gives each skill one line.
function frontMatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1]!;
      fields[key] = /^[>|][+-]?$/.test(field[2]!) ? '' : field[2]!.replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return fields;
}

// The skill in `directory`, or undefined when it holds no SKILL.md; its name defaults to the folder's.
export function skillAt(directory: string, prefix = ''): Skill | undefined {
  const file = join(directory, SKILL_FILE);
  if (!existsSync(file)) return undefined;
  const fields = frontMatter(readFileSync(file, 'utf8'));
  return { name: prefix + (fields.name || basename(directory)), description: fields.description ?? '', file };
}

// Every skill in a folder of skill folders, each name after `prefix`; none when the folder is missing.
export function skillsIn(root: string, prefix = ''): Skill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => skillAt(join(root, entry.name), prefix) ?? []);
}

// The prompt text that lists `skills`, or none when there are none.
export const listed = (skills: Skill[]): string =>
  skills.length
    ? [
        '## Skills',
        `A skill is a set of local instructions to follow, stored in a \`${SKILL_FILE}\` file. Below is the list of ` +
          'skills that can be used. When a skill fits the task, open its file and follow it.',
        ...skills.map(({ name, description, file }) => `- ${name}: ${description} (file: ${file})`),
        '',
      ].join('\n')
    : '';
