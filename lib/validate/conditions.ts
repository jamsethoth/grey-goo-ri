// A response Check's conditions, read against the agent's response schema (R4a, P5d), and the item fields a condition
// or a repeat Check names.

import * as procedures from '../procedures.ts';
import * as refs from '../refs.ts';

type Value = Record<string, unknown>;

export const isObjectList = (type: refs.FieldType | null | undefined) =>
  type?.kind === 'list' && (type as { of: refs.FieldType | null }).of?.kind === 'object';

// A field of each item of a list, as checks reads it (item[field] in a where or a repeat Check's fields): one key, not
// a path.
export function itemField(items: refs.SchemaNode | undefined, field: string) {
  if (items === refs.ANY) return { type: null };
  const node =
    items?.type === 'object' && refs.isRecord(items.properties) && Object.hasOwn(items.properties, field)
      ? items.properties[field]
      : null;
  return node
    ? { node, type: refs.kindOf(node) }
    : { error: `${JSON.stringify(field)} is not a field of the list's items` };
}

// Why a response condition's value cannot match its field, or null.
function valueProblem(type: refs.FieldType | null, value: unknown) {
  if (type === null) return null;
  if (type.kind === 'boolean')
    return typeof value === 'boolean' ? null : `${JSON.stringify(value)} is not true or false`;
  if (type.kind === 'enum') {
    const { values } = type as { values: string[] };
    return values.includes(value as string) ? null : `${JSON.stringify(value)} is not one of ${values.join(' | ')}`;
  }
  return `the field is ${JSON.stringify(type)}; a response condition reads only enum and boolean fields`;
}

const typedPath = (schema: refs.SchemaNode, path: unknown) => refs.resolve(schema, path, 'defined', { read: true });

function fieldProblems(condition: Value, schema: refs.SchemaNode) {
  const { type, error } = typedPath(schema, condition.field);
  if (error) return [error];
  const field = JSON.stringify(condition.field);
  if (type?.kind === 'boolean' && typeof condition.is !== 'boolean')
    return [`${field} is a boolean, so is must be true or false`];
  const problem = valueProblem(type ?? null, condition.is);
  return problem ? [`${field}: ${problem}`] : [];
}

function listProblems(condition: Value, form: string, schema: refs.SchemaNode) {
  const list = condition[form];
  const { type, node, error } = typedPath(schema, list);
  if (error) return [error];
  if (type && !isObjectList(type))
    return [`${form} must read a list of objects; ${JSON.stringify(list)} is ${JSON.stringify(type)}`];
  const problems = [];
  if (form === 'count') {
    const ops = procedures.OPS.filter((op) => Object.hasOwn(condition, op));
    if (ops.length !== 1 || !Number.isInteger(condition[ops[0]]))
      problems.push(`count takes one of ${procedures.OPS.join(', ')} with an integer`);
  }
  if (!refs.isRecord(condition.where)) return [...problems, 'where must be an object of item fields'];
  return [...problems, ...whereProblems(condition.where, node)];
}

// Each `where` field is a field of the list's items, and each value one it can hold.
function whereProblems(where: Value, list: refs.SchemaNode | undefined) {
  const problems = [];
  for (const [field, wanted] of Object.entries(where)) {
    const item = list && list !== refs.ANY ? itemField(list.items, field) : { type: null };
    if (item.error) {
      problems.push(`where: ${item.error}`);
      continue;
    }
    for (const one of Array.isArray(wanted) ? wanted : [wanted]) {
      const problem = valueProblem(item.type ?? null, one);
      if (problem) problems.push(`where ${JSON.stringify(field)}: ${problem}`);
    }
  }
  return problems;
}

// One response condition's problems.
export function conditionProblems(condition: unknown, schema: refs.SchemaNode): string[] {
  if (!refs.isRecord(condition)) return ['a condition must be an object'];
  const form = ['field', 'none', 'any', 'all', 'count'].filter((key) => Object.hasOwn(condition, key));
  if (form.length !== 1)
    return [
      'a condition is { field, is }, { none | any | all: <list>, where }, or { count: <list>, where, <op>: <integer> }',
    ];
  return form[0] === 'field' ? fieldProblems(condition, schema) : listProblems(condition, form[0], schema);
}
