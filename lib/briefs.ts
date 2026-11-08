// Briefs, and the checks on a Structured Response schema and a response. A schema is a Layer file, and stays inside the
// strict subset below, which every Harness accepts (docs/interfaces/harness.md, `run(call)`).

import * as referencePaths from './reference-paths.ts';
import * as publicText from './public-text.ts';
import * as render from './render.ts';
import type * as visit from './visit.ts';

// gg's strict subset: the keywords each type may carry. assertStrict refuses any other keyword or type.
const SUBSET = {
  object: ['type', 'properties', 'required', 'additionalProperties'],
  array: ['type', 'items'],
  string: ['type', 'enum'],
  boolean: ['type'],
  integer: ['type'],
};

const repeated = (list: unknown[]) => list.find((value, i) => list.indexOf(value) !== i);

// A schema node's keywords and type are in the subset, and its enum is a list of distinct strings.
function assertKeywords(schema: Record<string, unknown>, path: string) {
  // A string test first: SUBSET[['string']] would coerce the array to its one element.
  const keywords =
    typeof schema.type === 'string' && Object.hasOwn(SUBSET, schema.type)
      ? SUBSET[schema.type as keyof typeof SUBSET]
      : null;
  const keyword = Object.keys(schema).find((key) => !(keywords ?? ['type']).includes(key));
  if (keyword !== undefined)
    throw new Error(`${path}: keyword ${JSON.stringify(keyword)} is outside the strict subset`);
  if (!keywords)
    throw new Error(`${path}: type ${JSON.stringify(schema.type) ?? '(none)'} is outside the strict subset`);
  if (
    Object.hasOwn(schema, 'enum') &&
    !(Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((value) => typeof value === 'string'))
  ) {
    throw new Error(`${path}: enum must be a non-empty list of strings`);
  }
  const repeatedValue = schema.enum && repeated(schema.enum as unknown[]);
  if (repeatedValue !== undefined) throw new Error(`${path}: enum repeats ${JSON.stringify(repeatedValue)}`);
}

// An object node requires exactly its properties, each reachable by a dotted path, and allows no others.
function assertObject(schema: Record<string, unknown>, path: string) {
  const keys = Object.keys(schema.properties ?? {});
  if (schema.properties !== undefined && !referencePaths.isRecord(schema.properties))
    throw new Error(`${path}: properties must be an object`);
  if (schema.additionalProperties !== false) throw new Error(`${path}: object lacks additionalProperties: false`);
  if (!Array.isArray(schema.required)) throw new Error(`${path}: required must be a list`);
  const required = schema.required as unknown[];
  const repeatedName = repeated(required);
  if (repeatedName !== undefined) throw new Error(`${path}: required repeats ${JSON.stringify(repeatedName)}`);
  const missing = keys.find((key) => !required.includes(key));
  if (missing !== undefined) throw new Error(`${path}: required lacks property ${JSON.stringify(missing)}`);
  const extra = required.find((key) => !keys.includes(key as string));
  if (extra !== undefined) throw new Error(`${path}: required names ${JSON.stringify(extra)}, which is not a property`);
  const unreachable = keys.find((key) => key === '' || key.includes('.'));
  if (unreachable !== undefined)
    throw new Error(`${path}: property name ${JSON.stringify(unreachable)} cannot be reached by a dotted path`);
  const properties = schema.properties as Record<string, unknown>;
  for (const key of keys) assertStrict(properties[key], `${path}.${key}`);
}

export function assertStrict(schema: unknown, path = '(root)') {
  if (!referencePaths.isRecord(schema)) throw new Error(`${path}: schema must be an object`);
  assertKeywords(schema, path);
  if (schema.type === 'array' && schema.items === undefined) throw new Error(`${path}: array lacks items`);
  if (schema.type === 'object') assertObject(schema, path);
  if (schema.type === 'array') assertStrict(schema.items, `${path}[]`);
}

const prefix = (path: string) => (path ? `${path}.` : '');

function objectMismatch(schema: referencePaths.SchemaNode, value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
  const properties = schema.properties as Record<string, referencePaths.SchemaNode>;
  for (const key of schema.required as string[]) {
    if (!Object.hasOwn(value, key)) return `${prefix(path)}${key} is missing`;
    const reason = mismatch(properties[key], (value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    if (reason) return reason;
  }
  const extra = Object.keys(value).find((key) => !Object.hasOwn(schema.properties ?? {}, key));
  return extra !== undefined ? `${prefix(path)}${extra} is not in the schema` : null;
}

function arrayMismatch(schema: referencePaths.SchemaNode, value: unknown, path: string) {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (let i = 0; i < value.length; i++) {
    const reason = mismatch(schema.items as referencePaths.SchemaNode, value[i], `${path}[${i}]`);
    if (reason) return reason;
  }
  return null;
}

function mismatch(schema: referencePaths.SchemaNode, value: unknown, path: string): string | null {
  if (schema.type === 'object') return objectMismatch(schema, value, path);
  if (schema.type === 'array') return arrayMismatch(schema, value, path);
  if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} must be an integer`;
  if (typeof value !== schema.type) return `${path} must be a ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${path} must be one of ${schema.enum.join(' | ')}`;
  return null;
}

// The Claim signal, saved with the Visit and the Action Event: every field present, null where it has none.
export function validateResponse(schema: referencePaths.SchemaNode, response: unknown): visit.ClaimSignal {
  if (response == null) return { valid: false, token: null, reason: 'no structured response' };
  const reason = mismatch(schema, response, '');
  return reason
    ? { valid: false, token: null, reason }
    : { valid: true, token: (response as { claim?: string | null }).claim ?? null, reason: null };
}

const quoted = (list: unknown[]) => (list.length ? list.map((value) => JSON.stringify(value)).join(' | ') : '(none)');

// Tokens are matched exactly, so values that differ only in case would be a Claim nobody can route (V1).
export function assertClaimEnum(schema: referencePaths.SchemaNode | undefined, tokens: unknown) {
  const values = schema?.properties?.claim?.enum;
  if (!values) throw new Error('claim: the schema has no claim enum');
  assertStrict(schema.properties?.claim, 'claim');
  if (!Array.isArray(tokens) || !tokens.every((token) => typeof token === 'string')) {
    throw new Error('claim: the declared tokens must be a list of strings');
  }
  for (const list of [values, tokens as string[]]) {
    if (new Set(list.map((value) => value.toLowerCase())).size !== list.length)
      throw new Error(`claim: ${quoted(list)} repeats a value or differs only in case`);
  }
  const missing = tokens.filter((token) => !values.includes(token));
  if (!missing.length && values.length === tokens.length) return;
  const caseOnly = missing.some((token) => values.some((value) => value.toLowerCase() === token.toLowerCase()));
  throw new Error(
    `claim: enum ${quoted(values)} does not equal the declared tokens ${quoted(tokens)}` +
      `${caseOnly ? ' (they differ in case)' : ''}`,
  );
}

// A path steps through arrays implicitly: findings.severity is a list of the severity enum.
export function fieldType(schema: referencePaths.SchemaNode, path: unknown) {
  if (typeof path !== 'string') return { error: referencePaths.parse(path).error };
  try {
    assertStrict(schema);
  } catch (err) {
    return { error: `${JSON.stringify(path)}: the schema is outside the strict subset (${(err as Error).message})` };
  }
  const { type, error } = referencePaths.resolve(schema, path, 'a field of the schema');
  return error ? { error } : type;
}

// The tail of a command's output a Brief quotes, whichever template quotes it and by whichever reference: `output`, or
// a path ending in it, such as `inputs.red.output` (owner, 2026-11-06; amends U1). A section item's field is not cut.
const OUTPUT_LIMIT = 6000;
const quotesOutput = (ref: string) => ref === 'output' || ref.endsWith('.output');

// What a Brief reads beside its template: the Vertex's scope and gg's facts, each a value or a function computed only
// when the Brief names it (U1). `failure` is how a recovery section's Check failed.
export interface BriefContext {
  commands?: Record<string, string>;
  history?: Record<string, unknown>[];
  failure?: string | null;
  [name: string]: unknown;
}
// A recovery Brief's section: its template's text, and the failing Check's fields.
export interface BriefSection {
  text: string;
  [field: string]: unknown;
}

// How a Brief prints a value: the tail of a command's output text, an object as JSON, else the value itself.
function printed(value: unknown, ref: string, item: unknown) {
  if (!item && typeof value === 'string' && quotesOutput(ref))
    return publicText.publicTail(value, String, OUTPUT_LIMIT);
  if (referencePaths.isRecord(value) || (Array.isArray(value) && value.some(referencePaths.isRecord)))
    return JSON.stringify(value, null, 2);
  return value ?? '';
}

// A Brief reads gg's context beside the Vertex's own outputs and `inputs` (the scope a reference reads), and prints an
// object as JSON. A value is computed only when the Brief names it (U1); the interpreter passes the diff and changed
// test files as functions, since they read git. `first` lets a template separate History entries as a join would.
// A recovery Brief section reads its Check's `id`, `kind`, `command` line, `output` and `failure` (`failure.missing`
// when the kind recorded that failure).
// `text` is the template a Layer declares.
export function brief(text: string, { commands = {}, history = [], failure, ...context }: BriefContext) {
  const emit = (value: unknown, { name: ref }: { name: string }, _fenced: boolean, item: unknown) =>
    printed(value, ref, item);
  return render.renderTemplate(
    text,
    {
      ...context,
      failure: failure && { [failure]: true },
      commands: () => Object.entries(commands).map(([key, command]) => ({ name: key, command })),
      history: () => history.map((entry, index) => ({ ...entry, attemptNumber: index + 1, first: index === 0 })),
    },
    emit,
  );
}

// The recovery Brief (T4b): the Procedure's `recover.brief` frame, with a section for each failing Check, each section
// `{ text }` a template and the Check's fields.
export async function recoveryBrief(text: string, context: BriefContext & { sections: BriefSection[] }) {
  const sections = [];
  for (const { text: sectionText, ...check } of context.sections)
    sections.push((await brief(sectionText, { ...context, ...check })).trimEnd());
  return brief(text, { ...context, sections });
}
