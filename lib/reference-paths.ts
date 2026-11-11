// The one resolver for dotted reference paths (R14e): rule fields, Check parameters, `tests: named`, `with`, and the
// `from` and `pick` of inputs. It types a path by walking a schema-shaped scope, where gg's own facts are nodes too and
// an integer fact may carry `min` and `max` (J15).

import type * as report from './validate/report.ts';

// A node of a schema-shaped scope: a Structured Response schema's node, or one of gg's own facts.
export interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: string[];
  min?: number;
  max?: number;
}

// The type of a path: a list of a type, an enum's values, or a scalar type with an integer fact's bounds.
export type FieldType =
  | { kind: 'list'; of: FieldType | null }
  | { kind: 'enum'; values: string[] }
  | { kind: string | undefined; min?: number; max?: number };

// A node of unknown shape, such as a schema that could not be read: every path through it resolves, untyped.
export const ANY: SchemaNode = Object.freeze({});

// An object that is not a list: what a scope, a section item or a schema node must be.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parse(path: unknown): { steps: string[]; error?: undefined } | { error: string; steps?: undefined } {
  // Only the type: a YAML value may be self-referencing or lack a callable toString.
  if (typeof path !== 'string')
    return { error: `the field path must be a string, not ${path === null ? 'null' : typeof path}` };
  if (path === '') return { error: 'the field path is empty' };
  const steps = path.split('.');
  if (steps.includes('')) return { error: `${JSON.stringify(path)} has an empty segment` };
  return { steps };
}

export function read(value: unknown, path: unknown): unknown {
  const { steps } = parse(path);
  if (!steps) return undefined;
  let current = value;
  for (const key of steps) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Own data properties only, so a key such as __proto__ never reaches a prototype.
const own = (target: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

export function write(value: Record<string, unknown>, path: string, leaf: unknown) {
  const parsed = parse(path);
  if (!parsed.steps) throw new Error(parsed.error);
  const { steps } = parsed;
  let target = value;
  for (const key of steps.slice(0, -1))
    target = (Object.hasOwn(target, key) ? target[key] : own(target, key, {})[key]) as Record<string, unknown>;
  own(target, steps.at(-1) as string, leaf);
}

export function kindOf(node: SchemaNode): FieldType | null {
  if (node === ANY) return null;
  if (node.type === 'array') return { kind: 'list', of: kindOf(node.items as SchemaNode) };
  if (node.enum) return { kind: 'enum', values: node.enum };
  return {
    kind: node.type,
    ...(node.min !== undefined && { min: node.min }),
    ...(node.max !== undefined && { max: node.max }),
  };
}

// A path steps through arrays implicitly: findings.severity is a list of the severity enum. With `read`, a path is
// typed as read reads it: into a list only by its length or an item's index, so findings.severity is `list`, the list
// it cannot step into.
const LENGTH: SchemaNode = Object.freeze({ type: 'integer' });
type Walked =
  | { node: SchemaNode; list?: undefined; missing?: undefined }
  | { list: string; node?: undefined; missing?: undefined }
  | { missing: string; node?: undefined; list?: undefined };
function walk(scope: SchemaNode, steps: string[], readsAtRunTime: boolean): Walked {
  let node = scope;
  let lists = 0;
  for (const [i, key] of steps.entries()) {
    if (readsAtRunTime && node.type === 'array') {
      if (key !== 'length' && !/^\d+$/.test(key)) return { list: steps.slice(0, i).join('.') };
      node = key === 'length' ? LENGTH : (node.items as SchemaNode);
      continue;
    }
    while (node.type === 'array') {
      node = node.items as SchemaNode;
      lists++;
    }
    if (node === ANY) return { node: ANY };
    if (node.type !== 'object' || !isRecord(node.properties) || !Object.hasOwn(node.properties, key))
      return { missing: steps.slice(0, i + 1).join('.') };
    node = node.properties[key] as SchemaNode;
  }
  for (; lists > 0; lists--) node = { type: 'array', items: node };
  return { node };
}

// A path that does not resolve: its sentence, and the validator's Finding of it, whose params the code types.
export type Resolved =
  | { type: FieldType | null; node: SchemaNode; error?: undefined }
  | {
      error: string;
      finding: report.Finding<'malformed-reference' | 'reference-into-list' | 'undefined-reference'>;
      list?: string;
      type?: undefined;
      node?: undefined;
    };

// The type and node at `path` in `scope`, or an error naming the first segment `scope` lacks. `read` types a path gg
// reads at run time (`with`, an input's `from`, a Check parameter, a template name): `list` names the list it
// stepped into.
export function resolve(scope: SchemaNode, path: unknown, what = 'defined', { read = false } = {}): Resolved {
  const parsed = parse(path);
  if (!parsed.steps)
    return {
      error: parsed.error,
      finding: { code: 'malformed-reference', message: parsed.error, params: { path } },
    };
  const walked = walk(scope, parsed.steps, read);
  if (walked.list !== undefined) {
    const { list } = walked;
    const error =
      `${JSON.stringify(path)}: ${JSON.stringify(list)} is a list, ` +
      'so a path reads only its length or an item by index';
    return { error, finding: { code: 'reference-into-list', message: error, params: { path, list } }, list };
  }
  if (walked.missing !== undefined) {
    const { missing } = walked;
    const error = `${missing === path ? '' : `${JSON.stringify(path)}: `}${JSON.stringify(missing)} is not ${what}`;
    return { error, finding: { code: 'undefined-reference', message: error, params: { path, missing } } };
  }
  return { type: kindOf(walked.node), node: walked.node };
}
