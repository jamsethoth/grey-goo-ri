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
  'null-value',
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
  'await-approval-not-last',
  'await-approval-with-agent',
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
  'repeated-decision',
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
  // What gg doctor reads from GitHub beside the configuration.
  'repository-labels-missing',
  'repository-labels-unread',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

// A Procedure's problem found while typing it at a Vertex: the Flow and Vertex whose inputs exposed it.
interface AtVertex {
  flow?: string;
  vertex?: string;
}
// A reference path that does not type, and the template that names it, if one does.
type Reference = { path: unknown; template?: string } & AtVertex;
type RuleField = { field: string } & AtVertex;
// A harness's owner: a declared Agent, or the Vertex whose own Agent keys set it.
type HarnessOwner = { agent: string; vertex?: undefined } | { vertex: string; agent?: undefined };
// A Rule Table by the name its sentence gives it, <procedure>.<table>.
type RuleTable = { table: string } & AtVertex;
// A row as an index of its table, as `at` writes it.
type RuleRow = RuleTable & { row: number; outcome: string };
// The values each code's sentence names, as Ajv's params are typed by keyword, even where `at` spells one too; a code
// missing here names none. A label that only places the problem inside the value at `at` (`allOf[n]:`, `pick:`,
// `where "f":`, `agent X's harness`) is not repeated here. inherited-name's guard is #174's to replace, so it takes
// none yet.
interface ProblemParams {
  'required-key-missing': { key: string; id?: unknown; field?: unknown; values?: string[] };
  'unknown-key': { key: string };
  'invalid-name': { name?: unknown };
  'reserved-name': { name: string };
  'unknown-vertex': { vertex: unknown };
  'unknown-end': { end: unknown };
  'undeclared-procedure': { procedure: unknown };
  'harness-unregistered': HarnessOwner & { harness: string };
  'harness-unset': HarnessOwner;
  'undeclared-agent': { agent: unknown };
  'unknown-permission-intent': { access: unknown };
  'unused-agent': { agent: string };
  'vertex-needs-agent': { procedure: string };
  'vertex-takes-no-agent': { procedure: string };
  'check-after-effect': { id?: unknown; effect: string; effectId?: unknown };
  'claim-enum-mismatch': { schema: string; enum?: string[]; tokens: string[] };
  'file-not-named': { key: string };
  'pr-ready-without-checks': { token: string };
  'repeated-action-id': { id: string };
  'undeclared-check': { check: unknown };
  'undeclared-command': { id?: unknown; command: unknown };
  'unknown-action-kind': { kind: unknown };
  'unknown-check-kind': { kind: unknown };
  'schema-not-strict': { schema: string; reason: string };
  'schema-unreadable': { schema: string; reason: string };
  'template-unreadable': { template: string; reason: string } & AtVertex;
  'malformed-reference': Reference;
  'not-a-list-of-objects': Reference & { type: unknown };
  'not-a-list-of-strings': Reference & { type: unknown };
  'reference-into-list': Reference & { list: string };
  'source-types-differ': { sources: unknown[] };
  'undefined-reference': Reference & { missing: string };
  'unknown-item-field': { field: unknown } & AtVertex;
  'condition-value-mismatch': { field: unknown; value?: unknown; values?: string[] };
  'invalid-condition-field': { field: unknown; type: unknown };
  'invalid-rule-condition': RuleField;
  'invalid-rule-field': RuleField & { type: unknown };
  'never-firing-row': RuleRow;
  'overlapping-rows': {
    rows: [number, number];
    earlier: [number, number][];
    more: number;
    from: number | null;
    fields: string[];
    example: Record<string, unknown>;
    conditions: { row: number; when: Record<string, unknown> }[];
  } & RuleTable;
  'rule-condition-mismatch': RuleField & { condition: unknown; type: unknown };
  'rule-table-too-large': RuleTable & { work: number; limit: number; largest: [string, number][] };
  'undeclared-rule-field': RuleTable & { fields: string[] };
  'unreachable-row': RuleRow;
  'commit-without-check': { vertex: string; token: string };
  'not-a-list': { table?: string };
  'table-never-applies': { table: string };
  'optional-input-unsure': { input: string; vertex: string };
  'required-input-unsure': { input: string; vertex: string };
  'unreachable-vertex': { vertex: string };
  'repository-labels-missing': { labels: string[] };
  'repository-labels-unread': { reason: string };
  'exhausted-loop': { loop: string[] };
  'pr-ready-skippable': { outcome: string };
  'unbounded-cycle': { cycle: string[] };
  'unrouted-outcome': { outcome: string };
  'write-without-commit': { vertex: string; procedure: string };
}
type ParamsOf<C extends ProblemCode> = C extends keyof ProblemParams ? ProblemParams[C] : never;
// What follows a code: its sentence, then its params where it takes any, which may be left out only when every key of
// them is optional.
type Detail<C extends ProblemCode> = [ParamsOf<C>] extends [never]
  ? [message: string]
  : object extends ParamsOf<C>
    ? [message: string, params?: ParamsOf<C>]
    : [message: string, params: ParamsOf<C>];

// A problem found away from the report: the caller gives it its location.
export type Finding<C extends ProblemCode = ProblemCode> = C extends ProblemCode
  ? { code: C; message: string } & ([ParamsOf<C>] extends [never]
      ? { params?: undefined }
      : object extends ParamsOf<C>
        ? { params?: ParamsOf<C> }
        : { params: ParamsOf<C> })
  : never;

// `at` is the key gg doctor and admission print and tests read, so it keeps the short name the rules otherwise deny. It
// is a plain path in the merged configuration, dotted keys and [index], and '' for the whole of it.
export type Problem<C extends ProblemCode = ProblemCode> = Finding<C> & {
  // eslint-disable-next-line id-denylist -- the location each printed error and warning starts with
  at: string;
};
// Errors fail admission and gg doctor; warnings only print.
export interface Report {
  errors: Problem[];
  warnings: Problem[];
}
export const newReport = (): Report => ({ errors: [], warnings: [] });

// eslint-disable-next-line id-denylist -- builds the Problem's location
const problemAt = (location: string, finding: Finding): Problem => ({ at: location, ...finding });
// A Problem whose sentence names no value has no params, not empty ones.
const findingOf = <C extends ProblemCode>(code: C, [message, params]: Detail<C>) =>
  ({ code, message, ...(Object.keys(params ?? {}).length ? { params } : {}) }) as Finding;

// A required key left out breaks that rule, whichever rule a value there would break, and its params name the key
// beside the values the sentence names.
export function absentOr<C extends ProblemCode>(
  value: unknown,
  key: string,
  code: C,
  ...[message, params]: Detail<C>
): Finding {
  if (value === undefined) return { code: 'required-key-missing', message, params: { ...params, key } };
  return findingOf(code, [message, params] as Detail<C>);
}

export function error<C extends ProblemCode>(report: Report, location: string, code: C, ...detail: Detail<C>) {
  report.errors.push(problemAt(location, findingOf(code, detail)));
}
export function warn<C extends ProblemCode>(report: Report, location: string, code: C, ...detail: Detail<C>) {
  report.warnings.push(problemAt(location, findingOf(code, detail)));
}
// A problem a part found on its own, located where the caller says.
export function errorOf(report: Report, location: string, finding: Finding) {
  report.errors.push(problemAt(location, finding));
}
export function warnOf(report: Report, location: string, finding: Finding) {
  report.warnings.push(problemAt(location, finding));
}
// A printed line ends in its code, as ESLint prints a rule id, so each line keeps the prefix it had.
export const line = (severity: 'error' | 'warning', problem: Problem) =>
  `${severity}: ${problem.at === '' ? '' : `${problem.at}: `}${problem.message} [${problem.code}]`;

export function unknownKeys(report: Report, value: Record<string, unknown>, keys: readonly string[], location: string) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) error(report, location, 'unknown-key', `unknown key ${JSON.stringify(key)}`, { key });
}
// A check reached on two paths reports once. A Procedure's problem found at two Vertices is two: its sentence names
// the Vertex.
export const dedupe = (list: Problem[]) => [
  ...new Map(list.map((problem) => [`${problem.at}\n${problem.message}`, problem])).values(),
];
// The Finding of a reference path that does not resolve (referencePaths.resolve), naming the path.
export function unresolved(
  resolved: Extract<referencePaths.Resolved, { error: string }>,
  path: unknown,
  message = resolved.error,
): Finding {
  if (resolved.code === 'reference-into-list')
    return { code: resolved.code, message, params: { path, list: resolved.list as string } };
  if (resolved.code === 'undefined-reference')
    return { code: resolved.code, message, params: { path, missing: resolved.missing as string } };
  return { code: resolved.code, message, params: { path } };
}

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
  if (!valid) error(report, location, 'invalid-name', `${what} ${JSON.stringify(name)} ${rule}`, { name });
  return valid;
}
export const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
export const entries = (value: unknown) => (referencePaths.isRecord(value) ? Object.entries(value) : []);
export const unique = <T>(list: T[]) => [...new Set(list)];
// What a Procedure's Outcomes and Claim tokens may not be named.
export const isReserved = (name: string) =>
  name === 'failed' || (labels.END_STATES as string[]).includes(name) || name.startsWith('harness-');
const RESERVED = 'is reserved for the engine: failed, an end name or harness-*';
export function checkReserved(report: Report, location: string, what: string, name: string) {
  if (isReserved(name))
    error(report, location, 'reserved-name', `${what} ${JSON.stringify(name)} ${RESERVED}`, { name });
}
