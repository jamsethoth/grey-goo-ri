// The validator's findings, one report passed to each part that checks, and the value tests every part shares.

import * as labels from '../labels.ts';
import * as referencePaths from '../reference-paths.ts';

// Which rule a Problem breaks, one code per rule however many sentences name it. Code that needs the kind of problem
// reads this, never the message, whose wording may change. The decisions doc's ids (H7, R12c) stay out of it, so each
// code reads on its own; a comment may cite the id.
export const PROBLEM_CODES = [
  // A required key left out, or a value of the wrong shape, wherever the configuration holds it.
  'empty-list',
  'not-a-boolean',
  'not-a-list',
  'not-a-positive-integer',
  'not-an-object',
  'required-key-missing',
  'unknown-key',
  // Names.
  'inherited-name',
  'invalid-name',
  'reserved-name',
  // Flows, Vertices and routes.
  'exhausted-without-max',
  'human-only-end',
  'malformed-route-target',
  'max-without-exhausted',
  'no-flow-declared',
  'no-vertex-declared',
  'plan-not-null',
  'undeclared-procedure',
  'unknown-end',
  'unknown-vertex',
  // Agents and harnesses.
  'harness-unregistered',
  'harness-unset',
  'undeclared-agent',
  'unknown-permission-intent',
  'unused-agent',
  'vertex-needs-agent',
  'vertex-takes-no-agent',
  // A Procedure's Actions, Claim tokens and settings.
  'agent-action-not-first',
  'check-after-effect',
  'claim-enum-mismatch',
  'claim-tokens-missing',
  'claim-tokens-without-agent-action',
  'commit-type-unnamed',
  'file-not-named',
  'invalid-comment-target',
  'invalid-otherwise',
  'invalid-procedure-access',
  'invalid-reuse',
  'invalid-tests-setting',
  'malformed-claim-token',
  'malformed-recover',
  'needs-agent-action',
  'pr-ready-without-checks',
  'repeated-action-id',
  'second-agent-action',
  'undeclared-check',
  'undeclared-command',
  'unknown-action-kind',
  'unknown-check-kind',
  // Schemas and templates.
  'schema-not-strict',
  'schema-unreadable',
  'template-unreadable',
  // Reference paths and what they read.
  'malformed-reference',
  'not-a-list-of-objects',
  'not-a-list-of-strings',
  'reference-into-list',
  'source-types-differ',
  'undefined-reference',
  'unknown-item-field',
  // A response Check's conditions.
  'condition-value-mismatch',
  'invalid-condition-field',
  'malformed-all-of',
  'malformed-condition',
  'malformed-count',
  // Rule Tables.
  'invalid-rule-condition',
  'invalid-rule-field',
  'malformed-row',
  'never-firing-row',
  'overlapping-rows',
  'rule-condition-mismatch',
  'rule-table-too-large',
  'table-never-applies',
  'undeclared-rule-field',
  'unreachable-row',
  // The graph.
  'commit-without-check',
  'exhausted-loop',
  'optional-input-unsure',
  'pr-ready-skippable',
  'required-input-unsure',
  'unbounded-cycle',
  'unreachable-vertex',
  'unrouted-outcome',
  'write-without-commit',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

// A problem found away from the report: the caller gives it its location.
export interface Finding {
  code: ProblemCode;
  message: string;
}
// A required key left out breaks that rule, whichever rule a value there would break.
export const absentOr = (value: unknown, code: ProblemCode): ProblemCode =>
  value === undefined ? 'required-key-missing' : code;

// `at` is the key gg doctor and admission print and tests read, so it keeps the short name the rules otherwise deny.
export interface Problem extends Finding {
  // eslint-disable-next-line id-denylist -- the location each printed error and warning starts with
  at: string;
}
// eslint-disable-next-line id-denylist -- builds the Problem's location
const problemAt = (location: string, code: ProblemCode, message: string): Problem => ({ at: location, code, message });
// Errors fail admission and gg doctor; warnings only print.
export interface Report {
  errors: Problem[];
  warnings: Problem[];
}
export const newReport = (): Report => ({ errors: [], warnings: [] });

export function error(report: Report, location: string, code: ProblemCode, message: string) {
  report.errors.push(problemAt(location, code, message));
}
export function warn(report: Report, location: string, code: ProblemCode, message: string) {
  report.warnings.push(problemAt(location, code, message));
}
export function unknownKeys(report: Report, value: Record<string, unknown>, keys: readonly string[], location: string) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) error(report, location, 'unknown-key', `unknown key ${JSON.stringify(key)}`);
}
// A check reached on two paths reports once.
export const dedupe = (list: Problem[]) => [
  ...new Map(list.map((problem) => [`${problem.at}\n${problem.message}`, problem])).values(),
];

// A string key only: Object.hasOwn would coerce a list such as ["push"] to the key it spells.
export function hasOwnKey<T extends object>(value: T, key: unknown): key is Extract<keyof T, string>;
export function hasOwnKey(value: unknown, key: unknown): key is string;
export function hasOwnKey(value: unknown, key: unknown) {
  return typeof key === 'string' && referencePaths.isRecord(value) && Object.hasOwn(value, key);
}
export const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
// Every configured name has a character other than whitespace. A carried one has no ":", ".", "/", "--" or whitespace
// at all: the Action Marker and the Await and Decide Labels split on ":", a reference path on ".", an Action's retry
// key joins its parts with "/", the HTML comment a marker rides in on GitHub ends at "-->" or "--!>", and a marker is
// read back only without whitespace. A Procedure name takes the carried form by the same rule (3.3).
export function checkName(
  report: Report,
  location: string,
  name: unknown,
  { what, carried }: { what: string; carried: boolean },
): name is string {
  const valid = carried ? typeof name === 'string' && /^[^\s:./]+$/.test(name) && !name.includes('--') : isName(name);
  const rule = carried
    ? 'must be non-empty with no ":", ".", "/", "--" or whitespace'
    : 'must not be empty or only whitespace';
  if (!valid) error(report, location, 'invalid-name', `${what} ${JSON.stringify(name)} ${rule}`);
  return valid;
}
export const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
export const entries = (value: unknown) => (referencePaths.isRecord(value) ? Object.entries(value) : []);
export const unique = <T>(list: T[]) => [...new Set(list)];
// What a Procedure's Outcomes and Claim tokens may not be named.
export const isReserved = (name: string) =>
  name === 'failed' || (labels.END_STATES as string[]).includes(name) || name.startsWith('harness-');
export const RESERVED = 'is reserved for the engine: failed, an end name or harness-*';
