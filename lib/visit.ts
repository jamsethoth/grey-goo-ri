// The Visit's saved shapes, which the Execution Record nests: the Configuration Snapshot a Visit entered with, its
// Vertex inputs, its progress (VisitState) and each Action's Resolution, by the row that decided it.
import type * as commandCleanup from './command-cleanup.ts';
import type * as config from './config.ts';
import type * as integrity from './integrity.ts';
import type * as events from './events.ts';
import type * as jsonValue from './json-value.ts';
import type * as model from './model.ts';
import type * as runContext from './run-context.ts';

// The rule identity { table, row }: a fixed row by name, or a Procedure table's row by index, `otherwise`, or null
// when no row matched (request 3.3).
export interface RuleIdentity {
  table: 'fixed' | 'stopped' | 'passed' | 'failed';
  row: string | number | null;
}

export type Direction = 'advance' | 'retry' | 'stop';

// gg's fixed rows of the Transition Table (outcome.FIXED_ROWS), and `recover`, which starts the next recovery pass.
export type FixedRow =
  | 'cleanup-unconfirmed'
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

// An agent or Check Action's resolution through the Transition Table: its fixed row, or null once a Procedure table
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

// A human's Decision, which is the Visit's Outcome (X1c).
export interface DecisionResolution extends ResolutionBase {
  row: 'decision';
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
  // The remote Action whose failure stopped the Run, when the stop names one.
  source: string | null;
}

// An Action's result, by the row that decided it.
export type Resolution =
  TableResolution | EffectResolution | ActionCapResolution | RunStoppedResolution | DecisionResolution;

// The Claim the agent's Structured Response made, once validated against its schema (briefs.validateResponse).
export interface ClaimSignal {
  valid: boolean;
  token: string | null;
  reason: string | null;
}

// A Vertex input as Visit entry resolved it (S4, T6): the value and the Visit and Action that produced it, or absent
// (T10), every field then null.
export interface VertexInput {
  value: jsonValue.JsonValue;
  vertex: string | null;
  visit: number | null;
  action: string | null;
  absent: boolean;
}

// A failed Harness Result's failure (docs/interfaces/harness.md): its Failure Class, and the wait the harness was told.
export interface HarnessFailure {
  failureClass: string;
  retryAfterMs?: number | null;
  message?: string;
}

// A call's Harness Result and response, as the Transition Table reads them (outcome.resolve).
export interface CallSignal {
  status: 'completed' | 'failed' | 'timed-out' | 'killed';
  response: jsonValue.JsonValue;
  failure: HarnessFailure | null;
}

// The agent Action's latest Attempt, as the Transition Table reads it: the three Signals of a call.
export interface AgentCall {
  harnessResult: runContext.HarnessResult;
  claim: ClaimSignal;
  response: jsonValue.JsonValue;
  baseline: integrity.IntegrityBaseline;
  signal: CallSignal;
}

// What the recovery Brief and the Terminal Reason read of a Check's last run.
export interface CheckRun {
  output: string | null;
  reason: string | null;
  // Which of its kind's failures a failed run was, where the kind has several (lib/check-action.ts).
  failure: string | null;
  recoverable: boolean;
}

// The current Visit's progress, saved so a restart routes what it already settled (interpreter.runVisit).
export interface VisitState {
  recovery: number;
  firstAttemptBaseline: integrity.IntegrityBaseline | null;
  call: AgentCall | null;
  response: jsonValue.JsonValue;
  // Each Check's run and signal by Action id: Maps, so a Check such as __proto__ is kept like any other (#174).
  runs: Map<string, CheckRun>;
  checks: Map<string, CheckSignal>;
  checkFollows: boolean;
  settled: { action: string; recovery: number; resolution: Resolution } | null;
  // The report that stopped the Visit: its writers may still run, so nothing marks the worktree idle (L11).
  unconfirmedCleanup: commandCleanup.CleanupReport | null;
}

// Everything a Visit reads, copied at its entry so a Flow or command edited mid-Visit cannot reach it. The Agent,
// Outcomes, routes and commands are the Resolved Flow's (lib/validate/).
export interface ConfigurationSnapshot {
  vertex: string;
  visit: number;
  // The Config Hash the Visit entered under, which its Action Events carry though a later Run resumes it.
  configHash: string;
  agent: model.Agent | null;
  access: string;
  procedure: { name: string; hash: string };
  outcomes: jsonValue.JsonValue;
  route: jsonValue.JsonValue;
  routes: jsonValue.JsonValue;
  inputs: Record<string, VertexInput>;
  commands: Record<string, jsonValue.JsonValue>;
  testPaths: string[];
  persona: { name: string; bytes: string; hash: string } | null;
  // Each file the Procedure names, by bytes and hash, which every read in the Visit reads (request 3.5, #381).
  files: config.SourceFiles;
}

// What an earlier Attempt left for the next Brief to read: a hold, a rescue or an Integrity Violation's rollback.
export interface HistoryItem {
  // held, rescued or integrity violation: a Brief template prints it as text.
  kind: string;
  text: string;
}

// What an Action leaves for later Vertices' inputs, by the name they read it under: each Action kind's own outputs
// (lib/procedures.ts), and what gg adds to any call.
export interface ActionOutputValue {
  // An agent Action's Structured Response, once valid.
  response?: jsonValue.JsonValue;
  // What a call's or a Check's Command Cleanup found (L11).
  cleanup?: commandCleanup.CallCleanup;
  // A passed Check's evidence (N9), and a repeat Check's Findings Hash.
  evidence?: { command: string; output: string; [field: string]: jsonValue.JsonValue };
  findingsHash?: string;
  // The files a commit Action committed.
  files?: string[];
  // An await-approval Action's Decision.
  decision?: { outcome: string; actor: string | undefined; reply: string | null };
  // A rescue's ref, what it holds and why (#118).
  ref?: string;
  diffStat?: events.DiffStats;
  output?: string;
}

// An Action's outputs in Visit order, by Vertex, Visit and Action, which later Vertices' inputs read (W2).
export interface ActionOutput {
  vertex: string;
  visit: number;
  action: string;
  value: ActionOutputValue;
}
