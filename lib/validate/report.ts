// The validator's findings, one report passed to each part that checks, and the value tests every part shares.

import * as labels from '../labels.ts';
import * as referencePaths from '../reference-paths.ts';

export const PROBLEM_CODES = ['H7'] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

// `at` is the key gg doctor and admission print and tests read, so it keeps the short name the rules otherwise deny.
export interface Problem {
  code?: ProblemCode;
  // eslint-disable-next-line id-denylist -- the persisted key of every error and warning
  at: string;
  message: string;
}
// eslint-disable-next-line id-denylist -- builds the Problem's persisted key
const problemAt = (location: string, message: string): Problem => ({ at: location, message });
// Errors fail admission and gg doctor; warnings only print.
export interface Report {
  errors: Problem[];
  warnings: Problem[];
}
export const newReport = (): Report => ({ errors: [], warnings: [] });

export function error(report: Report, location: string, message: string) {
  report.errors.push(problemAt(location, message));
}
export function warn(report: Report, location: string, message: string) {
  report.warnings.push(problemAt(location, message));
}
export function unknownKeys(report: Report, value: Record<string, unknown>, keys: readonly string[], location: string) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) error(report, location, `unknown key ${JSON.stringify(key)}`);
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
  if (!valid) error(report, location, `${what} ${JSON.stringify(name)} ${rule}`);
  return valid;
}
export const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
export const entries = (value: unknown) => (referencePaths.isRecord(value) ? Object.entries(value) : []);
export const unique = <T>(list: T[]) => [...new Set(list)];
// What a Procedure's Outcomes and Claim tokens may not be named.
export const isReserved = (name: string) =>
  name === 'failed' || (labels.END_STATES as string[]).includes(name) || name.startsWith('harness-');
export const RESERVED = 'is reserved for the engine: failed, an end name or harness-*';
