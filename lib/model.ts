// The Resolved Flow in memory. Every collection a run looks up by a configured name is a Map, so no name, a Vertex
// `constructor` or a Procedure `__proto__`, reads or writes a property every object inherits (#174). Its JSON, which
// the validator gives and the Run's directory and the Pinned Configuration keep, holds the same collections as keyed
// objects.

import type * as procedures from './procedures.ts';
import type * as inputs from './validate/inputs.ts';
import type * as visit from './visit.ts';

// A Vertex as the Resolved Flow carries it (lib/validate/), as the interpreter reads it.
export interface Vertex {
  agent: visit.ConfigurationSnapshot['agent'];
  access: string;
  procedure: string;
  outcomes: string[];
  approvalLabels?: { await: string; decide: string[] } | null;
  route?: unknown;
  inputs?: Record<string, inputs.ResolvedInput>;
  max?: number;
  exhausted?: unknown;
}

// A Procedure with its Claim tokens by name.
export type Procedure = Omit<procedures.Procedure, 'claimTokens'> & {
  claimTokens: Map<string, procedures.ClaimToken>;
};

// The Resolved Flow an Execution runs.
export interface ResolvedFlow {
  name: string;
  actionCap: number;
  procedures: Map<string, Procedure>;
  ticket: { entry: string | null; routes?: unknown; vertices: Map<string, Vertex> };
}

// The Resolved Flow's JSON, as the validator gives it.
export interface ResolvedFlowJson {
  name: string;
  actionCap: number;
  procedures: Record<string, procedures.Procedure>;
  ticket: { entry: string | null; routes?: unknown; vertices: Record<string, Vertex> };
}

// JSON.parse, the validator and Object.entries give only own keys, so every name read from the JSON is one it declares.
export function fromJson(json: unknown): ResolvedFlow {
  const flow = json as ResolvedFlowJson;
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
