// What every Action of a Visit reads and writes: its scope, its outputs, the claimed token, the Transition Table's
// view of its Signals, and settle, which decides whether a pass's result ends the Visit.
import * as integrity from './integrity.ts';
import type * as marker from './marker.ts';
import type * as model from './model.ts';
import * as outcome from './outcome.ts';
import type * as procedures from './procedures.ts';
import * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';

// The Visit's saved progress (visit.VisitState), with its Procedure and Claim tokens, which runVisit adds as
// non-enumerable properties so they stay out of the saved record.
export interface RunningVisit extends visit.VisitState {
  readonly proc: model.Procedure;
  readonly claimTokens: model.Procedure['claimTokens'];
}

// An Action's result as the Visit routes it: any row's, with the fields a table row or a failing Check adds.
export type ActionResolution = visit.Resolution &
  Partial<
    Pick<
      visit.TableResolution,
      'signal' | 'reason' | 'output' | 'failureClass' | 'surfaces' | 'attempt' | 'retryAfterMs' | 'sessionId'
    >
  > & { source?: string | null };

// One Action as the Visit runs it: its identity, its declaration, and the Visit's progress.
export interface Running {
  actionIdentity: marker.ActionIdentity;
  action: procedures.Action;
  state: RunningVisit;
}

// A Vertex with no agent Action has the implicit Claim ok, which requires all its Checks (R11f).
export const IMPLICIT_OK: Omit<visit.AgentCall, 'baseline'> = {
  harnessResult: { status: 'completed' },
  claim: { valid: true, token: 'ok', reason: null },
  response: null,
  signal: { status: 'completed', response: { claim: 'ok' }, failure: null },
};

// The Transition Table's view of an Action's Signals: the Integrity Assertions, then the Check signals.
export const resolverChecks = (
  integrityRows: { name: string; passed: boolean }[],
  signals: visit.CheckSignal[],
): outcome.TableCheck[] => [
  ...integrityRows.map((row) => ({ name: row.name, passed: row.passed, integrity: true })),
  ...signals.map((signal) => ({ name: signal.id, passed: signal.state === 'passed', integrity: false })),
];

// The agent's claimed token name, or the implicit ok of a Vertex with no agent Action (R11f).
const claimOf = (response: unknown): string => (response as { claim?: string } | null)?.claim ?? 'ok';
export const tokenOf = (state: RunningVisit): procedures.ClaimToken =>
  state.claimTokens.get(claimOf(state.response)) as procedures.ClaimToken;

// A Check's saved signal and run, by Action id. The validator admits only ids the Procedure declares and puts every
// Check before the first effect, so a result that is missing is a broken record, named.
export function checkSignal(state: Pick<visit.VisitState, 'checks'>, id: string): visit.CheckSignal {
  const found = state.checks.get(id);
  if (!found) throw new Error(`Check ${JSON.stringify(id)} has no saved result`);
  return found;
}

export function checkRun(state: Pick<visit.VisitState, 'runs'>, id: string): visit.CheckRun {
  const found = state.runs.get(id);
  if (!found) throw new Error(`Check ${JSON.stringify(id)} has no saved run`);
  return found;
}

// What a reference or template may name of a Visit (W2): its own outputs by Action id, and its `inputs`, where an
// absent input reads as nothing so a template renders it empty (T10).
export const visitScope = (
  executionRecord: record.ExecutionRecord,
  { vertex, visit }: { vertex: string; visit: number },
): Record<string, unknown> => ({
  ...Object.fromEntries(
    executionRecord.outputs
      .filter((output) => output.vertex === vertex && output.visit === visit)
      .map((output) => [output.action, output.value]),
  ),
  inputs: Object.fromEntries(
    Object.entries((executionRecord.configurationSnapshot as visit.ConfigurationSnapshot).inputs).map(
      ([name, input]) => [name, input.absent ? undefined : input.value],
    ),
  ),
});

// What a Check parameter, a `with`, a rule or a template may name (U1, W2): the Vertex's own outputs by Action id, its
// inputs, the agent's response and Claim token, the pass (Recovery Number + 1, T4d) and each Check's state
// (`checkSignals`, when given, are the states to read).
export function scopeOf(
  executionRecord: record.ExecutionRecord,
  actionIdentity: marker.ActionIdentity,
  state: RunningVisit,
  checkSignals: Map<string, visit.CheckSignal> | visit.CheckSignal[] = state.checks,
): Record<string, unknown> {
  return {
    ...visitScope(executionRecord, actionIdentity),
    response: state.response,
    claim: claimOf(state.response),
    pass: state.recovery + 1,
    check: Object.fromEntries([...checkSignals.values()].map((signal) => [signal.id, signal.state])),
  };
}

// The values an Action's `with` names, read from its scope.
export const bind = (executionRecord: record.ExecutionRecord, { actionIdentity, action, state }: Running) =>
  Object.fromEntries(
    Object.entries((action.with as Record<string, string> | undefined) ?? {}).map(([name, ref]) => [
      name,
      referencePaths.read(scopeOf(executionRecord, actionIdentity, state), ref),
    ]),
  );

// The entry an Action's outputs are kept in, if it has one yet.
export const outputOf = (executionRecord: record.ExecutionRecord, actionIdentity: marker.ActionIdentity) =>
  executionRecord.outputs.find(
    (output) =>
      output.vertex === actionIdentity.vertex &&
      output.visit === actionIdentity.visit &&
      output.action === actionIdentity.action,
  );

// An Action's outputs (W2), one entry per Vertex, Visit and Action in Visit order. A recovery pass of the Action, or a
// resumed one, replaces its fields, so a reference reads the Action's last pass.
export function recordOutput(
  executionRecord: record.ExecutionRecord,
  actionIdentity: marker.ActionIdentity,
  value: Record<string, unknown>,
) {
  const entry = outputOf(executionRecord, actionIdentity);
  if (entry) Object.assign(entry.value, value);
  else
    executionRecord.outputs.push({
      vertex: actionIdentity.vertex,
      visit: actionIdentity.visit,
      action: actionIdentity.action,
      value,
    });
}

// A Check counts only on the tree it checked, so a pass on an older tree reads as failed (R1b). A response or repeat
// Check reads no tree and never goes stale, so the worktree is read only when a signal has one (a git process: run it
// under whileBusy).
export async function fresh(runContext: RunContext, signals: visit.CheckSignal[]): Promise<visit.CheckSignal[]> {
  if (!signals.some((signal) => signal.tree)) return signals;
  const { tree } = await integrity.snapshot(runContext.record.worktree, runContext.git, runContext.locks);
  return signals.map((signal) =>
    signal.tree && signal.tree !== tree && signal.state === 'passed' ? { ...signal, state: 'failed' } : signal,
  );
}

// A pass ends at its last Check, or at the agent call when no Check follows it (T4). There a stop token, or a Check the
// claimed token requires that failed, decides the Visit (Q3d); a failure some failing Check can recover from starts the
// next pass instead, while `recover` has passes left. A pass whose required Checks passed leaves the decision to the
// `passed` table, once every Action has run. A final failure carries the first failing Check's signal for the Terminal
// Reason.
export function settle(
  executionRecord: record.ExecutionRecord,
  actionIdentity: marker.ActionIdentity,
  state: RunningVisit,
  input: outcome.Signals,
): visit.TableResolution {
  const resolution = outcome.resolve(input);
  if (resolution.row !== 'claimed' || state.checkFollows) return resolution;
  const token = tokenOf(state);
  const failing = token.stop ? [] : token.requires.filter((id) => state.checks.get(id)?.state !== 'passed');
  if (!token.stop && !failing.length) return resolution;
  const recoverable =
    failing.some((id) => checkRun(state, id).recoverable) && state.recovery < (state.proc.recover?.max ?? 0);
  const [first] = failing;
  const decided = outcome.decide({
    ...input,
    checks: resolverChecks([], [...state.checks.values()]),
    token,
    procedure: state.proc,
    scope: scopeOf(executionRecord, actionIdentity, state),
    recoverable,
  });
  if (!first) return decided;
  return {
    ...decided,
    signal: checkSignal(state, first),
    reason: checkRun(state, first).reason,
    output: checkRun(state, first).output,
  };
}
