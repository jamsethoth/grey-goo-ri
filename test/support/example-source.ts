import { readFileSync } from 'node:fs';
import * as referencePaths from '../../lib/reference-paths.ts';
import * as validate from '../../lib/validate/index.ts';
import type * as report from '../../lib/validate/report.ts';

// The example Source under test/fixtures/example: the Flow `gg init` writes, its schemas and its templates.
export const fixtureText = (name: string) =>
  readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8');

// The example's own type, which tsc reads from its file; Node never loads it, since a type is erased (ADR 0018).
type Example = typeof import('../fixtures/example/gg.json', { with: { type: 'json' } });

// The example Flow as `gg init` writes it, plus the per-person harness a user Source adds (P2), typed as the example
// file, so a read is checked and an edit out of the example's shape goes through putAt (#358).
export function config(): Example {
  const source = JSON.parse(fixtureText('gg.json')) as Example;
  for (const agent of Object.values(source.agents)) agent.harness = 'fake';
  return source;
}
export type Source = ReturnType<typeof config>;

export const SCHEMA_NAMES = ['red.schema.json', 'implement.schema.json', 'review.schema.json'];
// The templates the example names.
export const TEMPLATE_NAMES = [
  'red.md',
  'green.md',
  'fix.md',
  'review.md',
  'recover.md',
  'tests-fail-recovery.md',
  'command-recovery.md',
  'blocked.md',
  'pr-body.md',
  'review-comment.md',
];
export const PERSONA_NAMES = ['implementer.md', 'reviewer.md'];
// Every file `gg init` writes: gg.json and the files it names.
export const WRITTEN_NAMES = ['gg.json', ...SCHEMA_NAMES, ...TEMPLATE_NAMES, ...PERSONA_NAMES];

// The example's test paths, the only list of them: today's `testPaths` default that gg init writes.
export const TEST_GLOBS = (JSON.parse(fixtureText('gg.json')) as { testPaths: string[] }).testPaths;

// The example's schemas, parsed, by file name.
export const schemas = () =>
  Object.fromEntries(SCHEMA_NAMES.map((name) => [name, JSON.parse(fixtureText(name)) as referencePaths.SchemaNode]));

// Puts `value` at `path` in a parsed fixture, or removes the key when `value` is undefined: a case edits a fixture
// into any shape, the strict subset's or not, through objects and lists it checks, with no `any`. A list's item is
// named by its index.
export function putAt(fixture: unknown, path: string[], value?: unknown) {
  const parent = path
    .slice(0, -1)
    .reduce<unknown>(
      (node, key) =>
        referencePaths.isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined,
      fixture,
    );
  if (!referencePaths.isRecord(parent) && !Array.isArray(parent))
    throw new Error(`no object or list at ${path.join('.')}`);
  const edited = parent as Record<string, unknown>;
  const key = path.at(-1)!;
  if (value === undefined) delete edited[key];
  else edited[key] = value;
}

// The example's own templates, by file name.
export const exampleTemplates = () => Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, fixtureText(name)]));

// The example's templates, each naming nothing, with `changes` in place of one: a case about one rule reads no other.
export const templates = (changes: Record<string, string> = {}) => ({
  ...Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, `${name}\n`])),
  ...changes,
});

// Which rule fired where: what a case about a rule asserts, leaving the sentence to the cases about its wording.
export type FiredRule = Pick<report.Problem, 'at' | 'code'>;
export const firedRules = (problems: report.Problem[]): FiredRule[] =>
  // eslint-disable-next-line id-denylist -- a Problem's key is at
  problems.map(({ at, code }) => ({ at, code }));
// ...and, for a Procedure's problem found at a Vertex, the Flow and Vertex whose inputs exposed it.
export const firedAtVertices = (problems: report.Problem[]) =>
  firedRules(problems).map((fired, index) => {
    const { params } = problems[index];
    return { ...fired, ...(params && 'flow' in params && { flow: params.flow, vertex: params.vertex }) };
  });

const schemaReader = (files: Record<string, referencePaths.SchemaNode>) => (name: string) => {
  if (!Object.hasOwn(files, name)) throw new Error('no such file');
  return files[name];
};

// Validates `source` with `harnesses` registered in place of the fake alone: a case about what a Harness declares.
export const checkOn = (source: Source, harnesses: Record<string, unknown>) =>
  validate.validate(source, { harnesses, readSchema: schemaReader(schemas()) });

// Validates `source` with the fake harness registered, reading schemas and templates from the files given.
export function check(source: Source, files = schemas(), templateFiles?: Record<string, string>) {
  return validate.validate(source, {
    harnesses: { fake: {} },
    readSchema: schemaReader(files),
    ...(templateFiles && {
      readTemplate: (name: string) => {
        if (!Object.hasOwn(templateFiles, name)) throw new Error('no such file');
        return templateFiles[name] as string;
      },
    }),
  });
}
