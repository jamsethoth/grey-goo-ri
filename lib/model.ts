// The Resolved Flow in memory. Every collection a run looks up by a configured name is a Map, so no name, a Vertex
// `constructor` or a Procedure `__proto__`, reads or writes a property every object inherits (#174). Its JSON, which
// the validator gives and the Run's directory and the Pinned Configuration keep, holds the same collections as keyed
// objects. The validator also declares every Flow as written, which gg doctor prints whether or not it resolved.

import type * as flow from './flow.ts';
import type * as jsonValue from './json-value.ts';
import type * as labels from './labels.ts';
import type * as procedures from './procedures.ts';
import type * as inputs from './validate/inputs.ts';

type JsonValue = jsonValue.JsonValue;

// A route's target: a Vertex id or an end. A route may also take an Edge, which bounds its traversals (U5).
export type Target = string | { end: labels.EndState };
export type Edge = { to: Target; max?: number; exhausted?: Target };
export type RouteTarget = Target | Edge;
// Which route an Outcome takes, and where a failure's work goes (R12d, U5), as gg doctor prints it.
export interface Routing {
  target: RouteTarget;
  by: flow.RouteSource;
  work: string | null;
}
// An Agent as the validator resolves it: the declared Agent under the Vertex's own Agent keys. Only its harness and
// access are checked; every other key is as declared.
export type Agent = { harness: string } & { [key: string]: JsonValue };

// A Vertex as the Resolved Flow carries it. `routing` is gg doctor's; the interpreter reads a Vertex.
export interface ResolvedVertexJson {
  use: string | null;
  agent: Agent | null;
  procedure: string;
  access: string;
  tests: procedures.Procedure['tests'] | null;
  outcomes: string[];
  // The Await and Decide Labels a Vertex whose Procedure ends in await-approval can request, else null (X1d).
  approvalLabels: { await: string; decide: string[] } | null;
  routing: Record<string, Routing>;
  inputs: Record<string, inputs.ResolvedInput>;
  route: Record<string, RouteTarget>;
  max: number | null;
  exhausted: Target | null;
}

// The Resolved Flow's JSON, as the validator gives a Flow whose every field holds its type.
export interface ResolvedFlowJson {
  name: string;
  actionCap: number;
  procedures: Record<string, procedures.Procedure>;
  ticket: { entry: string; routes: Record<string, RouteTarget>; vertices: Record<string, ResolvedVertexJson> };
}

// A Vertex as the interpreter reads it.
export type Vertex = Pick<
  ResolvedVertexJson,
  'agent' | 'access' | 'procedure' | 'outcomes' | 'approvalLabels' | 'route' | 'inputs' | 'max' | 'exhausted'
>;

// The fields the validator copies as declared, by where they sit; a Vertex's routing holds declared route targets. A
// Flow with an error is printed as written (gg doctor, #305), so in its declared view each may hold any JSON, and
// lib/validate/resolved.ts narrows each to its Resolved Flow type.
export const COPIED_FIELDS = {
  flow: ['actionCap'],
  ticket: ['entry', 'routes'],
  vertex: ['use', 'agent', 'procedure', 'access', 'tests', 'route', 'max', 'exhausted', 'routing'],
  procedure: ['actions', 'claimTokens', 'tests', 'access', 'recover', 'passed', 'failed', 'stopped', 'otherwise'],
} as const;
type AsDeclared<Shape, Copied extends keyof Shape> = Omit<Shape, Copied> & { [Key in Copied]: JsonValue };
export type DeclaredProcedureJson = AsDeclared<procedures.Procedure, (typeof COPIED_FIELDS.procedure)[number]>;
export type DeclaredVertexJson = AsDeclared<
  Omit<ResolvedVertexJson, 'routing'>,
  Exclude<(typeof COPIED_FIELDS.vertex)[number], 'routing'>
> & { routing: Record<string, Omit<Routing, 'target'> & { target: JsonValue }> };
export type DeclaredFlowJson = AsDeclared<Omit<ResolvedFlowJson, 'procedures' | 'ticket'>, 'actionCap'> & {
  procedures: Record<string, DeclaredProcedureJson>;
  ticket: AsDeclared<Omit<ResolvedFlowJson['ticket'], 'vertices'>, 'entry' | 'routes'> & {
    vertices: Record<string, DeclaredVertexJson>;
  };
};

// A Procedure with its Claim tokens by name.
export type Procedure = Omit<procedures.Procedure, 'claimTokens'> & {
  claimTokens: ReadonlyMap<string, procedures.ClaimToken>;
};

// The Resolved Flow an Execution runs. Only the validator and fromJson produce one, so its collections are read-only.
export interface ResolvedFlow {
  name: string;
  actionCap: number;
  procedures: ReadonlyMap<string, Procedure>;
  ticket: Omit<ResolvedFlowJson['ticket'], 'vertices'> & { vertices: ReadonlyMap<string, ResolvedVertexJson> };
}

// JSON.parse, the validator and Object.entries give only own keys, so every name read from the JSON is one it declares.
export function fromJson(flow: ResolvedFlowJson): ResolvedFlow {
  const procedureEntries = Object.entries(flow.procedures).map(
    ([name, procedure]) =>
      [name, { ...procedure, claimTokens: new Map(Object.entries(procedure.claimTokens)) }] as const,
  );
  return {
    ...flow,
    procedures: new Map(procedureEntries),
    ticket: { ...flow.ticket, vertices: new Map(Object.entries(flow.ticket.vertices)) },
  };
}

// A Vertex or Procedure the validator admitted: every route target and Vertex procedure is checked at admission, and
// Reconciliation holds a record at a name the Flow lacks, so a miss here is a broken invariant, named.
export function vertex(flow: ResolvedFlow, id: string): Vertex {
  const found = flow.ticket.vertices.get(id);
  if (!found) throw new Error(`Vertex ${JSON.stringify(id)} is not in Flow ${flow.name}`);
  return found;
}

export function procedure(flow: ResolvedFlow, name: string): Procedure {
  const found = flow.procedures.get(name);
  if (!found) throw new Error(`Procedure ${JSON.stringify(name)} is not in Flow ${flow.name}`);
  return found;
}

// Object.fromEntries defines own keys, so a name such as __proto__ stays data in the JSON.
export function toJson(flow: ResolvedFlow): ResolvedFlowJson {
  const procedureEntries = [...flow.procedures].map(
    ([name, procedure]) => [name, { ...procedure, claimTokens: Object.fromEntries(procedure.claimTokens) }] as const,
  );
  return {
    ...flow,
    procedures: Object.fromEntries(procedureEntries),
    ticket: { ...flow.ticket, vertices: Object.fromEntries(flow.ticket.vertices) },
  };
}
