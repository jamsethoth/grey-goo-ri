import { readFileSync } from 'node:fs';
import * as referencePaths from '../../lib/reference-paths.ts';
import * as validate from '../../lib/validate/index.ts';
import type * as report from '../../lib/validate/report.ts';

// The example Layer under test/fixtures/example: the Flow `gg init` writes, its schemas and its templates.
export const fixtureText = (name: string) =>
  readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8');

// The example Flow as `gg init` writes it, plus the per-person harness a user Layer adds (P2). It is an `any`, so a
// case may edit any key of it into a configuration the validator must judge, until its cases edit through putAt (#358).
export function config() {
  const layer: any = JSON.parse(fixtureText('gg.json'));
  for (const agent of Object.values<Record<string, unknown>>(layer.agents)) agent.harness = 'fake';
  return layer;
}
export type Layer = ReturnType<typeof config>;

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
// into any shape, the strict subset's or not, through objects it checks, with no `any`.
export function putAt(fixture: unknown, path: string[], value?: unknown) {
  const parent = path
    .slice(0, -1)
    .reduce<unknown>((node, key) => (referencePaths.isRecord(node) ? node[key] : undefined), fixture);
  if (!referencePaths.isRecord(parent)) throw new Error(`no object at ${path.join('.')}`);
  const key = path.at(-1)!;
  if (value === undefined) delete parent[key];
  else parent[key] = value;
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

// Validates `layer` with the fake harness registered, reading schemas and templates from the files given.
export function check(layer: Layer, files = schemas(), templateFiles?: Record<string, string>) {
  return validate.validate(layer, {
    harnesses: { fake: {} },
    readSchema: (name) => {
      if (!Object.hasOwn(files, name)) throw new Error('no such file');
      return files[name];
    },
    ...(templateFiles && {
      readTemplate: (name: string) => {
        if (!Object.hasOwn(templateFiles, name)) throw new Error('no such file');
        return templateFiles[name] as string;
      },
    }),
  });
}
