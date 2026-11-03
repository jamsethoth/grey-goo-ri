// The Visit's saved shapes, which the Execution Record nests: the Configuration Snapshot a Visit entered with, its
// Vertex inputs, its progress (VisitState) and each Action's Resolution, by the row that decided it.
import type * as integrity from './integrity.ts';

// The rule identity { table, row }: a fixed row by name, or a Procedure table's row by index, `otherwise`, or null
// when no row matched (request 3.3).
export interface RuleIdentity {
  table: 'fixed' | 'stopped' | 'passed' | 'failed';
  row: string | number | null;
}

export type Direction = 'advance' | 'retry' | 'stop';

// gg's fixed rows of the transition table (outcome.ROWS), and `recover`, which starts the next recovery pass.
export type FixedRow =
  | 'integrity-violation'
  | 'transient-retry'
  | 'transient-exhausted'
  | 'run-stop'
  | 'timeout-retry'
  | 'timeout-exhausted'
  | 'unknown-failure'
  | 'parse-retry'
  | 'parse-exhausted'
  | 'claimed'
  | 'recover';

// A Check's signal as the Visit keeps it: its latest result on the tree it checked.
export interface CheckSignal {
  id: string;
  kind: string;
  state: 'passed' | 'failed';
  tree: string | null;
}

interface ResolutionBase {
  outcome: string;
  direction: Direction;
  rule: RuleIdentity;
}

// An agent or Check Action's resolution through the transition table: its fixed row, or null once a Procedure table
// decided. An agent Action's adds its Session and Attempt; a failure carries the failing Check's signal and output.
export interface TableResolution extends ResolutionBase {
  row: FixedRow | null;
  check: string | null;
  retryAfterMs: number | null;
  retryKind: 'parse' | 'timeout' | 'transient' | 'rateLimited' | null;
  failureClass: string | null;
  sessionId?: string | null;
  reason?: string | null;
  surfaces?: string[] | null;
  attempt?: number;
  signal?: CheckSignal;
  output?: string | null;
}

// A deterministic side effect that completed.
export interface EffectResolution extends ResolutionBase {
  row: 'effect-completed';
}

// A Flow Attempt past the Action Cap, which never runs (request 3.3, V1).
export interface ActionCapResolution extends ResolutionBase {
  row: 'action-cap';
  actionCap: number;
}

// Another Execution's run stop, which ends this one before its next Action (request 3.4).
export interface RunStoppedResolution extends ResolutionBase {
  row: 'run-stopped';
  failureClass: string;
  runStopTicket: number;
}

// An Action's result, by the row that decided it.
export type Resolution = TableResolution | EffectResolution | ActionCapResolution | RunStoppedResolution;

// The Claim the agent's Structured Response made, once validated against its schema (briefs.validateResponse).
export interface ClaimSignal {
  valid: boolean;
  token: string | null;
  reason: string | null;
}

// A Vertex input as Visit entry resolved it (S4, T6): the value and the Visit and Action that produced it, or absent
// (T10), every field then null.
export interface VertexInput {
  value: unknown;
  vertex: string | null;
  visit: number | null;
  action: string | null;
  absent: boolean;
}

// The agent Action's latest Attempt, as the transition table reads it: the three Signals of a call.
export interface AgentCall {
  harnessResult: Record<string, unknown>;
  claim: ClaimSignal;
  response: unknown;
  baseline: integrity.IntegrityBaseline;
  signal: { status: string; response: unknown; failure: unknown };
}

// What the recovery Brief and the Terminal Reason read of a Check's last run.
export interface CheckRun {
  output: string | null;
  reason: string | null;
  failure: unknown;
  recoverable: boolean;
}

// The current Visit's progress, saved so a restart routes what it already settled (interpreter.runVisit).
export interface VisitState {
  recovery: number;
  firstAttemptBaseline: integrity.IntegrityBaseline | null;
  call: AgentCall | null;
  response: unknown;
  runs: Record<string, CheckRun>;
  checks: Record<string, CheckSignal>;
  checkFollows: boolean;
  settled: { action: string; recovery: number; resolution: Resolution } | null;
}

// Everything a Visit reads, copied at its entry so a Flow or command edited mid-Visit cannot reach it. The Agent,
// Outcomes, routes and commands are the Resolved Flow's (validate.mjs).
export interface ConfigurationSnapshot {
  vertex: string;
  visit: number;
  agent:
    | ({ harness: string; model: string | null; effort: string | null; persona: string } & Record<string, unknown>)
    | null;
  access: string;
  procedure: { name: string; hash: string };
  outcomes: unknown;
  route: unknown;
  routes: unknown;
  inputs: Record<string, VertexInput>;
  commands: Record<string, unknown>;
  testPaths: unknown;
  persona: { name: string; bytes: string; hash: string } | null;
}

// An Action's outputs in Visit order, by Vertex, Visit and Action, which later Vertices' inputs read (W2).
export interface ActionOutput {
  vertex: string;
  visit: number;
  action: string;
  value: Record<string, unknown>;
}
