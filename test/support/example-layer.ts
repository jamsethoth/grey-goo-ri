import { readFileSync } from 'node:fs';
import type * as procedures from '../../lib/procedures.ts';
import * as validate from '../../lib/validate/index.ts';
import type * as validateFlows from '../../lib/validate/flows.ts';
import type * as report from '../../lib/validate/report.ts';

// The example Layer under test/fixtures/example: the Flow `gg init` writes, its schemas and its templates.
export const fixtureText = (name: string) =>
  readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8');

// The example Flow as `gg init` writes it, plus the per-person harness a user Layer adds (P2). It is JSON.parse's
// `any`, so a case may edit any key of it.
export function config() {
  const layer = JSON.parse(fixtureText('gg.json'));
  for (const agent of Object.values<Record<string, unknown>>(layer.agents)) agent.harness = 'fake';
  return layer;
}
export type Layer = ReturnType<typeof config>;

export const SCHEMA_NAMES = ['red.schema.json', 'implement.schema.json', 'review.schema.json'];
// The templates the example names. Its own templates arrive with #120, so each case reads one that names nothing.
export const TEMPLATE_NAMES = [
  'red.md',
  'green.md',
  'fix.md',
  'review.md',
  'recover.md',
  'still-green.md',
  'test-fix.md',
  'blocked.md',
  'pr-body.md',
  'review-comment.md',
];

// The example's schemas, parsed, by file name.
export const schemas = () => Object.fromEntries(SCHEMA_NAMES.map((name) => [name, JSON.parse(fixtureText(name))]));

// The example's templates, each naming nothing, with `changes` in place of one.
export const templates = (changes: Record<string, string> = {}) => ({
  ...Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, `${name}\n`])),
  ...changes,
});

type ResolvedFlow = NonNullable<ReturnType<typeof validateFlows.checkFlow>>;
// The validator's result where every Flow resolved, as each case that reads `flows` expects, with each Procedure in the
// shape lib/procedures.ts gives the Resolved Flow's.
export interface Checked {
  flows: Record<string, Omit<ResolvedFlow, 'procedures'> & { procedures: Record<string, procedures.Procedure> }>;
  errors: report.Problem[];
  warnings: report.Problem[];
}

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
  }) as Checked;
}
