// A Vertex's inputs: each source typed among the outputs the Flow's Vertices produce (W2, W3), every source of one
// input one type (T6), and `pick` typed in each item of a list.

import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as checked from './procedures.ts';
import * as report from './report.ts';

export const INPUT_KEYS = ['from', 'optional', 'pick'];

type Value = Record<string, unknown>;
// An input as the Resolved Flow carries it.
export interface ResolvedInput {
  from: unknown[];
  optional: boolean;
  pick?: unknown;
}
// A Vertex's inputs, and the node each reads as, for the scope of `inputs`.
export interface TypedInputs {
  inputs: Record<string, ResolvedInput>;
  nodes: Record<string, referencePaths.SchemaNode>;
}
interface Source {
  source: unknown;
  node: referencePaths.SchemaNode;
}

// Two schemas are one type when they differ only in key order or in the order of required or enum.
const typeKey = (node: referencePaths.SchemaNode) =>
  JSON.stringify(node, (key, value: unknown) => {
    if (Array.isArray(value) && (key === 'required' || key === 'enum')) return [...value].sort();
    if (!referencePaths.isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, value[name]]),
    );
  });

// `<vertex>.<action id>.<output>` and `<vertex>.rescue`, for every input's `from`.
export function sourceScope(procs: Map<string, checked.CheckedProcedure | undefined>, vertices: Value) {
  return procedures.object(
    Object.fromEntries(
      Object.entries(vertices).map(([id, vertex]) => {
        const proc = referencePaths.isRecord(vertex) ? procs.get(vertex.procedure as string) : undefined;
        if (!proc) return [id, referencePaths.ANY];
        const actions = proc.actions.filter(
          (action) => referencePaths.isRecord(action) && typeof action.id === 'string',
        ) as procedures.Action[];
        const outputs = actions.map((action) => [action.id, procedures.outputs(action, proc.schema)]);
        return [id, procedures.object({ rescue: procedures.RESCUE, ...Object.fromEntries(outputs) })];
      }),
    ),
  );
}

// The first source that types, after checking every source has its type (T6).
function firstSource(problems: report.Report, location: string, from: unknown[], scope: referencePaths.SchemaNode) {
  let first: Source | null = null;
  for (const source of from) {
    const resolved = referencePaths.resolve(scope, source, 'defined', { read: true });
    if (resolved.error !== undefined) {
      report.error(problems, location, resolved.code, resolved.error);
      continue;
    }
    if (resolved.node === referencePaths.ANY) continue;
    if (!first) first = { source, node: resolved.node };
    else if (typeKey(first.node) !== typeKey(resolved.node)) {
      const sources = `${JSON.stringify(first.source)} and ${JSON.stringify(source)}`;
      report.error(problems, location, 'source-types-differ', `sources ${sources} have different types`);
    }
  }
  return first;
}

// The node an input reads as: its sources' type, or a list of what `pick` reads in each item.
function pickedNode(problems: report.Report, location: string, pick: unknown, first: Source | null) {
  const node = first?.node ?? referencePaths.ANY;
  if (pick === undefined) return node;
  if (node === referencePaths.ANY) {
    const parsed = referencePaths.parse(pick);
    if (parsed.error) report.error(problems, location, 'malformed-reference', `pick: ${parsed.error}`);
    return node;
  }
  const type = referencePaths.kindOf(node);
  if (!(type?.kind === 'list' && (type as { of: referencePaths.FieldType | null }).of?.kind === 'object')) {
    const source = JSON.stringify((first as Source).source);
    report.error(
      problems,
      location,
      'not-a-list-of-objects',
      `pick needs a list of objects; ${source} is ${JSON.stringify(type)}`,
    );
    return referencePaths.ANY;
  }
  // The interpreter reads `pick` in each item, so it is typed in an item, as it is read.
  const resolved = referencePaths.resolve(node.items as referencePaths.SchemaNode, pick, 'defined', { read: true });
  if (resolved.error) {
    report.error(problems, location, resolved.code, `pick: ${resolved.error}`);
    return referencePaths.ANY;
  }
  return { type: 'array', items: resolved.node };
}

export function checkInputs(
  problems: report.Report,
  location: string,
  declared: unknown,
  scope: referencePaths.SchemaNode,
) {
  const inputs: [string, ResolvedInput][] = [];
  const nodes: [string, referencePaths.SchemaNode][] = [];
  if (declared !== undefined && !referencePaths.isRecord(declared))
    report.error(
      problems,
      `${location}.inputs`,
      'not-an-object',
      'inputs must be an object from name to { from, optional?, pick? }',
    );
  for (const [input, declaration] of report.entries(declared)) {
    const inputLocation = `${location}.inputs.${input}`;
    report.checkName(problems, inputLocation, input, { what: 'input', carried: true });
    if (!referencePaths.isRecord(declaration)) {
      report.error(problems, inputLocation, 'not-an-object', 'an input is { from, optional?, pick? }');
      continue;
    }
    report.unknownKeys(problems, declaration, INPUT_KEYS, inputLocation);
    if (declaration.optional !== undefined && typeof declaration.optional !== 'boolean')
      report.error(problems, inputLocation, 'not-a-boolean', 'optional must be true or false');
    const given = declaration.from;
    const sources = Array.isArray(given) ? given : [given];
    const from = given === undefined ? [] : sources;
    if (!from.length)
      report.error(problems, inputLocation, report.absentOr(given, 'empty-list'), 'from must name at least one source');
    const { pick } = declaration;
    inputs.push([input, { from, optional: declaration.optional === true, ...(pick !== undefined && { pick }) }]);
    const first = firstSource(problems, inputLocation, from, scope);
    nodes.push([input, pickedNode(problems, inputLocation, pick, first)]);
  }
  // Built from entries, so an input such as __proto__ is an own key.
  const typed: TypedInputs = { inputs: Object.fromEntries(inputs), nodes: Object.fromEntries(nodes) };
  return typed;
}
