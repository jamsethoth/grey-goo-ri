// Briefs and Structured Response schemas for every Phase.
// Schemas stay inside the strict subset below, which every Harness accepts (docs/interfaces/harness.md, `run(call)`).

import * as refs from './refs.mjs';
import * as render from './render.mjs';

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const claim = { type: 'string', enum: ['ok', 'blocked', 'misscoped'] };

// Red phase: failing tests only. The orchestrator verifies they fail and commits them.
export const RED_SCHEMA = obj({ claim, summary: str, tests: strs, notes: str, diagnosis: str });

// Green phase, fix rounds, still-green and test-fix: the orchestrator runs the tests and records evidence itself.
export const IMPLEMENT_SCHEMA = obj({
  claim,
  summary: str,
  dod: { type: 'array', items: obj({ item: str, met: { type: 'boolean' }, evidence: str }) },
  qa: obj({ setup: str, steps: { type: 'array', items: obj({ action: str, expected: str }) }, edgeCases: strs, automated: strs, manual: strs }),
  diagnosis: str,
  notes: str,
});

export const REVIEW_SCHEMA = obj({
  claim: { type: 'string', enum: ['ok', 'changes', 'misscoped'] },
  summary: str,
  dodMet: { type: 'boolean' },
  tddEvidenceOk: { type: 'boolean' },
  findings: { type: 'array', items: obj({ severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: str, issue: str, fix: str }) },
  diagnosis: str,
});

// gg's strict subset: the keywords each type may carry. assertStrict refuses any other keyword or type.
const SUBSET = {
  object: ['type', 'properties', 'required', 'additionalProperties'],
  array: ['type', 'items'],
  string: ['type', 'enum'],
  boolean: ['type'],
  integer: ['type'],
};

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const repeated = (list) => list.find((v, i) => list.indexOf(v) !== i);

export function assertStrict(schema, path = '(root)') {
  if (!isRecord(schema)) throw new Error(`${path}: schema must be an object`);
  // A string test first: SUBSET[['string']] would coerce the array to its one element.
  const keywords = typeof schema.type === 'string' && Object.hasOwn(SUBSET, schema.type) ? SUBSET[schema.type] : null;
  const keyword = Object.keys(schema).find((k) => !(keywords ?? ['type']).includes(k));
  if (keyword !== undefined) throw new Error(`${path}: keyword ${JSON.stringify(keyword)} is outside the strict subset`);
  if (!keywords) throw new Error(`${path}: type ${JSON.stringify(schema.type) ?? '(none)'} is outside the strict subset`);
  if (Object.hasOwn(schema, 'enum') && !(Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((v) => typeof v === 'string'))) {
    throw new Error(`${path}: enum must be a non-empty list of strings`);
  }
  const repeatedValue = schema.enum && repeated(schema.enum);
  if (repeatedValue !== undefined) throw new Error(`${path}: enum repeats ${JSON.stringify(repeatedValue)}`);
  if (schema.type === 'array' && schema.items === undefined) throw new Error(`${path}: array lacks items`);
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.properties !== undefined && !isRecord(schema.properties)) throw new Error(`${path}: properties must be an object`);
    if (schema.additionalProperties !== false) throw new Error(`${path}: object lacks additionalProperties: false`);
    if (!Array.isArray(schema.required)) throw new Error(`${path}: required must be a list`);
    const repeatedName = repeated(schema.required);
    if (repeatedName !== undefined) throw new Error(`${path}: required repeats ${JSON.stringify(repeatedName)}`);
    const missing = keys.find((k) => !schema.required.includes(k));
    if (missing !== undefined) throw new Error(`${path}: required lacks property ${JSON.stringify(missing)}`);
    const extra = schema.required.find((k) => !keys.includes(k));
    if (extra !== undefined) throw new Error(`${path}: required names ${JSON.stringify(extra)}, which is not a property`);
    const unreachable = keys.find((k) => k === '' || k.includes('.'));
    if (unreachable !== undefined) throw new Error(`${path}: property name ${JSON.stringify(unreachable)} cannot be reached by a dotted path`);
    for (const k of keys) assertStrict(schema.properties[k], `${path}.${k}`);
  }
  if (schema.type === 'array') assertStrict(schema.items, `${path}[]`);
}

function mismatch(schema, value, path) {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
    for (const k of schema.required) {
      if (!Object.hasOwn(value, k)) return `${path ? `${path}.` : ''}${k} is missing`;
      const reason = mismatch(schema.properties[k], value[k], path ? `${path}.${k}` : k);
      if (reason) return reason;
    }
    const extra = Object.keys(value).find((k) => !Object.hasOwn(schema.properties ?? {}, k));
    return extra !== undefined ? `${path ? `${path}.` : ''}${extra} is not in the schema` : null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const reason = mismatch(schema.items, value[i], `${path}[${i}]`);
      if (reason) return reason;
    }
    return null;
  }
  if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} must be an integer`;
  if (typeof value !== schema.type) return `${path} must be a ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(' | ')}`;
  return null;
}

export function validateResponse(schema, response) {
  if (response == null) return { valid: false, reason: 'no structured response' };
  const reason = mismatch(schema, response, '');
  return reason ? { valid: false, reason } : { valid: true, claim: response.claim };
}

const quoted = (list) => (list.length ? list.map((v) => JSON.stringify(v)).join(' | ') : '(none)');

// V1: tokens are matched exactly, so values that differ only in case would be a Claim nobody can route.
export function assertClaimEnum(schema, tokens) {
  const values = schema?.properties?.claim?.enum;
  if (!values) throw new Error('claim: the schema has no claim enum');
  assertStrict(schema.properties.claim, 'claim');
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === 'string')) {
    throw new Error('claim: the declared tokens must be a list of strings');
  }
  for (const list of [values, tokens]) {
    if (new Set(list.map((v) => v.toLowerCase())).size !== list.length) throw new Error(`claim: ${quoted(list)} repeats a value or differs only in case`);
  }
  const missing = tokens.filter((t) => !values.includes(t));
  if (!missing.length && values.length === tokens.length) return;
  const caseOnly = missing.some((t) => values.some((v) => v.toLowerCase() === t.toLowerCase()));
  throw new Error(`claim: enum ${quoted(values)} does not equal the declared tokens ${quoted(tokens)}${caseOnly ? ' (they differ in case)' : ''}`);
}

// A path steps through arrays implicitly: findings.severity is a list of the severity enum.
export function fieldType(schema, path) {
  if (typeof path !== 'string') return { error: refs.parse(path).error };
  try {
    assertStrict(schema);
  } catch (e) {
    return { error: `${JSON.stringify(path)}: the schema is outside the strict subset (${e.message})` };
  }
  const { type, error } = refs.resolve(schema, path, 'a field of the schema');
  return error ? { error } : type;
}

// Each Brief's excerpt of a Check run, as before templates: test-fix shows more of a failing run (U1: size stays per Brief).
const OUTPUT_LIMIT = { 'test-fix.md': 6000 };

// A value is computed only when the Brief names it (U1); the interpreter passes the diff and changed test files as
// functions, since they read git. `first` lets a template separate History entries as a join would.
export function brief(name, { ticket, base, commands = {}, history = [], testFiles, redOutput, output, impl, diff, changedTestFiles, reason }) {
  return render.template(render.templateFile(name), {
    ticket, base, testFiles, diff, changedTestFiles, reason,
    commands: () => Object.entries(commands).map(([key, command]) => ({ name: key, command })),
    history: () => history.map((h, i) => ({ ...h, n: i + 1, first: i === 0 })),
    redOutput: () => render.publicTail(redOutput, String, 4000),
    output: () => render.publicTail(output, String, OUTPUT_LIMIT[name] ?? 3000),
    report: () => JSON.stringify(impl, null, 2),
  });
}
