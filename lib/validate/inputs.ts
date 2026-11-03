// A Vertex's inputs: each source typed among the outputs the Flow's Vertices produce (W2, W3), every source of one
// input one type (T6), and `pick` typed in each item of a list.

import * as procedures from '../procedures.ts';
import * as refs from '../refs.ts';
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
  nodes: Record<string, refs.SchemaNode>;
}
interface Source {
  source: unknown;
  node: refs.SchemaNode;
}

// Two schemas are one type when they differ only in key order or in the order of required or enum.
const typeKey = (node: refs.SchemaNode) =>
  JSON.stringify(node, (key, value: unknown) => {
    if (Array.isArray(value) && (key === 'required' || key === 'enum')) return [...value].sort();
    if (!refs.isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, value[name]]),
    );
  });

// `<vertex>.<action id>.<output>` and `<vertex>.rescue`, for every input's `from`.
export function sourceScope(procs: Record<string, checked.CheckedProcedure | undefined>, vertices: Value) {
  return procedures.object(
    Object.fromEntries(
      Object.entries(vertices).map(([id, vertex]) => {
        const proc = refs.isRecord(vertex) && report.has(procs, vertex.procedure) ? procs[vertex.procedure] : undefined;
        if (!proc) return [id, refs.ANY];
        const actions = proc.actions.filter(
          (action) => refs.isRecord(action) && typeof action.id === 'string',
        ) as procedures.Action[];
        const outputs = actions.map((action) => [action.id, procedures.outputs(action, proc.schema)]);
        return [id, procedures.object({ rescue: procedures.RESCUE, ...Object.fromEntries(outputs) })];
      }),
    ),
  );
}

// The first source that types, after checking every source has its type (T6).
function firstSource(problems: report.Report, location: string, from: unknown[], scope: refs.SchemaNode) {
  let first: Source | null = null;
  for (const source of from) {
    const resolved = refs.resolve(scope, source, 'defined', { read: true });
    if (resolved.error !== undefined) {
      report.error(problems, location, resolved.error);
      continue;
    }
    if (resolved.node === refs.ANY) continue;
    if (!first) first = { source, node: resolved.node };
    else if (typeKey(first.node) !== typeKey(resolved.node)) {
      const sources = `${JSON.stringify(first.source)} and ${JSON.stringify(source)}`;
      report.error(problems, location, `sources ${sources} have different types`);
    }
  }
  return first;
}

// The node an input reads as: its sources' type, or a list of what `pick` reads in each item.
function pickedNode(problems: report.Report, location: string, pick: unknown, first: Source | null) {
  const node = first?.node ?? refs.ANY;
  if (pick === undefined) return node;
  if (node === refs.ANY) {
    const parsed = refs.parse(pick);
    if (parsed.error) report.error(problems, location, `pick: ${parsed.error}`);
    return node;
  }
  const type = refs.kindOf(node);
  if (!(type?.kind === 'list' && (type as { of: refs.FieldType | null }).of?.kind === 'object')) {
    const source = JSON.stringify((first as Source).source);
    report.error(problems, location, `pick needs a list of objects; ${source} is ${JSON.stringify(type)}`);
    return refs.ANY;
  }
  // The interpreter reads `pick` in each item, so it is typed in an item, as it is read.
  const resolved = refs.resolve(node.items as refs.SchemaNode, pick, 'defined', { read: true });
  if (resolved.error) {
    report.error(problems, location, `pick: ${resolved.error}`);
    return refs.ANY;
  }
  return { type: 'array', items: resolved.node };
}

export function checkInputs(problems: report.Report, location: string, declared: unknown, scope: refs.SchemaNode) {
  const typed: TypedInputs = { inputs: {}, nodes: {} };
  if (declared !== undefined && !refs.isRecord(declared))
    report.error(problems, `${location}.inputs`, 'inputs must be an object from name to { from, optional?, pick? }');
  for (const [input, declaration] of report.entries(declared)) {
    const inputLocation = `${location}.inputs.${input}`;
    if (!refs.isRecord(declaration)) {
      report.error(problems, inputLocation, 'an input is { from, optional?, pick? }');
      continue;
    }
    report.unknownKeys(problems, declaration, INPUT_KEYS, inputLocation);
    if (declaration.optional !== undefined && typeof declaration.optional !== 'boolean')
      report.error(problems, inputLocation, 'optional must be true or false');
    const from = Array.isArray(declaration.from) ? declaration.from : [declaration.from];
    if (!from.length) report.error(problems, inputLocation, 'from must name at least one source');
    const { pick } = declaration;
    typed.inputs[input] = { from, optional: declaration.optional === true, ...(pick !== undefined && { pick }) };
    const first = firstSource(problems, inputLocation, from, scope);
    typed.nodes[input] = pickedNode(problems, inputLocation, pick, first);
  }
  return typed;
}
