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

export function fromJson(_json: unknown): ResolvedFlow {
  return { name: '', actionCap: 0, procedures: new Map(), ticket: { entry: null, vertices: new Map() } };
}

export function toJson(_flow: ResolvedFlow): ResolvedFlowJson {
  return { name: '', actionCap: 0, procedures: {}, ticket: { entry: null, vertices: {} } };
}
