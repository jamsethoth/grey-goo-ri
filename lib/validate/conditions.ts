// A response Check's conditions, read against the agent's response schema (R4a, P5d), and the item fields a condition
// or a repeat Check names.

import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as report from './report.ts';

type Value = Record<string, unknown>;

export const isObjectList = (type: referencePaths.FieldType | null | undefined) =>
  type?.kind === 'list' && (type as { of: referencePaths.FieldType | null }).of?.kind === 'object';

// A field of each item of a list, as checks reads it (item[field] in a where or a repeat Check's fields): one key, not
// a path.
export function itemField(items: referencePaths.SchemaNode | undefined, field: string) {
  if (items === referencePaths.ANY) return { type: null };
  const node =
    items?.type === 'object' && referencePaths.isRecord(items.properties) && Object.hasOwn(items.properties, field)
      ? items.properties[field]
      : null;
  return node
    ? { node, type: referencePaths.kindOf(node) }
    : { error: `${JSON.stringify(field)} is not a field of the list's items` };
}

// Why a response condition's value cannot match its field, or null.
function valueProblem(field: unknown, type: referencePaths.FieldType | null, value: unknown): report.Finding | null {
  if (type === null) return null;
  if (type.kind === 'boolean') {
    const message = `${JSON.stringify(value)} is not true or false`;
    return typeof value === 'boolean' ? null : { code: 'condition-value-mismatch', message, params: { field, value } };
  }
  if (type.kind === 'enum') {
    const { values } = type as { values: string[] };
    const message = `${JSON.stringify(value)} is not one of ${values.join(' | ')}`;
    return values.includes(value as string)
      ? null
      : { code: 'condition-value-mismatch', message, params: { field, value, values } };
  }
  const message = `the field is ${JSON.stringify(type)}; a response condition reads only enum and boolean fields`;
  return { code: 'invalid-condition-field', message, params: { field, type } };
}

const typedPath = (schema: referencePaths.SchemaNode, path: unknown) =>
  referencePaths.resolve(schema, path, 'defined', { read: true });

function fieldProblems(condition: Value, schema: referencePaths.SchemaNode): report.Finding[] {
  const resolved = typedPath(schema, condition.field);
  if (resolved.error) return [resolved.finding];
  const { type } = resolved;
  const field = JSON.stringify(condition.field);
  const named = { field: condition.field };
  if (type?.kind === 'boolean' && typeof condition.is !== 'boolean') {
    const message = `${field} is a boolean, so is must be true or false`;
    return [report.absentOr(condition.is, 'is', 'condition-value-mismatch', message, named)];
  }
  if (type?.kind === 'enum' && condition.is === undefined) {
    const { values } = type as { values: string[] };
    const message = `${field} is an enum, so is must be one of ${values.join(' | ')}`;
    return [{ code: 'required-key-missing', message, params: { key: 'is', ...named, values } }];
  }
  const problem = valueProblem(condition.field, type ?? null, condition.is);
  return problem ? [{ ...problem, message: `${field}: ${problem.message}` }] : [];
}

function listProblems(condition: Value, form: string, schema: referencePaths.SchemaNode): report.Finding[] {
  const list = condition[form];
  const resolved = typedPath(schema, list);
  if (resolved.error) return [resolved.finding];
  const { type, node } = resolved;
  if (type && !isObjectList(type)) {
    const message = `${form} must read a list of objects; ${JSON.stringify(list)} is ${JSON.stringify(type)}`;
    return [{ code: 'not-a-list-of-objects', message, params: { path: list, type } }];
  }
  const problems: report.Finding[] = [];
  if (form === 'count') {
    const ops = procedures.OPERATORS.filter((op) => Object.hasOwn(condition, op));
    if (ops.length !== 1 || !Number.isInteger(condition[ops[0]]))
      problems.push({
        code: 'malformed-count',
        message: `count takes one of ${procedures.OPERATORS.join(', ')} with an integer`,
      });
  }
  if (!referencePaths.isRecord(condition.where))
    return [
      ...problems,
      report.absentOr(condition.where, 'where', 'not-an-object', 'where must be an object of item fields'),
    ];
  return [...problems, ...whereProblems(condition.where, node)];
}

// Each `where` field is a field of the list's items, and each value one it can hold.
function whereProblems(where: Value, list: referencePaths.SchemaNode | undefined) {
  const problems: report.Finding[] = [];
  for (const [field, wanted] of Object.entries(where)) {
    const item = list && list !== referencePaths.ANY ? itemField(list.items, field) : { type: null };
    if (item.error) {
      problems.push({ code: 'unknown-item-field', message: `where: ${item.error}`, params: { field } });
      continue;
    }
    for (const one of Array.isArray(wanted) ? wanted : [wanted]) {
      const problem = valueProblem(field, item.type ?? null, one);
      if (problem) problems.push({ ...problem, message: `where ${JSON.stringify(field)}: ${problem.message}` });
    }
  }
  return problems;
}

// One response condition's problems.
export function conditionProblems(condition: unknown, schema: referencePaths.SchemaNode): report.Finding[] {
  if (!referencePaths.isRecord(condition)) return [{ code: 'not-an-object', message: 'a condition must be an object' }];
  const form = ['field', 'none', 'any', 'all', 'count'].filter((key) => Object.hasOwn(condition, key));
  if (form.length !== 1)
    return [
      {
        code: 'malformed-condition',
        message:
          'a condition is { field, is }, { none | any | all: <list>, where }, ' +
          'or { count: <list>, where, <op>: <integer> }',
      },
    ];
  return form[0] === 'field' ? fieldProblems(condition, schema) : listProblems(condition, form[0], schema);
}
