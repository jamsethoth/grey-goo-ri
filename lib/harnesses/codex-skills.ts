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

// The skills an Agent declares, each a folder of the user's skills folder, and every one not found there (D2 A).
export function declared(skillsFolder: string, names: unknown) {
  const asked = Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  const lookedUp = asked.map((name) => [name, skillAt(join(skillsFolder, name))] as const);
  return {
    skills: lookedUp.flatMap(([, skill]) => skill ?? []),
    errors: lookedUp.flatMap(([name, skill]) => (skill ? [] : [`skill ${name} is not in ${skillsFolder}`])),
  };
}

// A skill whose agents/openai.yaml sets policy.allow_implicit_invocation false is one Codex leaves out of its own
// list and uses only when asked for by name (#481 D7 A).
// shortcut: the flow form (policy: {allow_implicit_invocation: false}) and a deeper key of the same name are not told
// apart; read them once a skill uses one.
// A content line starts with neither a blank nor '#', so no line reads as both kinds and the read stays linear.
const REQUEST_ONLY =
  /^policy:[ \t]*(#.*)?\r?\n(?:(?:[ \t]+[^\s#].*|[ \t]*(#.*)?)\r?\n)*?[ \t]+allow_implicit_invocation:[ \t]*false\b/m;

function requestOnly(directory: string): boolean {
  const file = join(directory, 'agents', 'openai.yaml');
  return existsSync(file) && REQUEST_ONLY.test(readFileSync(file, 'utf8'));
}

const NAMED_ONLY = ' (use only when the task names this skill)';

// Every skill in a folder of skill folders, each name after `prefix`; none when the folder is missing. A skill Codex
// uses only on request is left out of a bundled folder (D7 A), but listed with a marker saying so in a listed
// plugin's (`plugin`), since its Agent names the plugin (D8 C). A declared skill is named by its Agent, so skillAt
// reads it whatever its policy.
export function skillsIn(root: string, prefix = '', plugin = false): Skill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(root, entry.name);
      const skill = skillAt(directory, prefix);
      if (!skill || !requestOnly(directory)) return skill ?? [];
      return plugin ? { ...skill, description: skill.description + NAMED_ONLY } : [];
    });
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
