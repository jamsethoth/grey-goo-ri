// The Run context an Execution's Visits, Actions, effects and Terminals read: the deps a test replaces, the
// Execution's configuration, and how each Action is entered, marked and recorded. runExecution builds it here, once.
import * as checks from './checks.ts';
import * as clockModule from './clock.ts';
import type * as commandCleanup from './command-cleanup.ts';
import type * as config from './config.ts';
import type * as sideEffect from './effects/side-effect.ts';
import * as eventRead from './event-read.ts';
import * as events from './events.ts';
import type * as exec from './exec.ts';
import type * as github from './github.ts';
import * as integrity from './integrity.ts';
import type * as jsonValue from './json-value.ts';
import type * as locks from './locks.ts';
import * as marker from './marker.ts';
import type * as model from './model.ts';
import type * as reconcile from './reconcile.ts';
import * as record from './record.ts';
import * as remoteEffects from './remote-effects.ts';
import * as publicText from './public-text.ts';
import type * as terminalReport from './terminal-report.ts';
import type * as visit from './visit.ts';

// The git verbs a Run calls (lib/git.ts's, or the fake git's): Reconciliation's, the Integrity Assertions', Test
// Immutability's, the Terminals' and the Actions' own. gg run's git adds the repo-lock guard (run.lockedGit), which
// checks the run stop and the human override once a queued write holds the lock.
export type RunGit = reconcile.ReconcileGit &
  checks.ChangedPaths &
  terminalReport.TerminalContext['git'] & {
    branchDiff(worktree: string, base: string): Promise<string>;
    stageAll(worktree: string): Promise<unknown>;
    writeTree(worktree: string): Promise<string>;
    commitTree(worktree: string, payload: { message: string; tree: string; parent: string }): Promise<string | null>;
    commitStaged(worktree: string, message: string): Promise<string | null>;
    push(worktree: string, branch: string, sha: string): Promise<unknown>;
    rescueTree(worktree: string, options: { within?: integrity.Within }): Promise<string>;
    rescueCommit(worktree: string, commit: { tree: string; parent: string; message: string }): Promise<string>;
    createRef(worktree: string, ref: string, sha: string): Promise<boolean>;
    withGuard?: (guard: (verb: string, args: unknown[], unlocked: RunGit) => Promise<unknown>) => RunGit;
  } & AdmissionGit;

// The git verbs gg run's admission calls before an Execution runs: the repository, and the Ticket's worktree.
export interface AdmissionGit {
  repoInfo(cwd: string): Promise<{ mainRoot: string; gitCommonDir: string; folder: string }>;
  worktreePath(root: string, repository: string, ticket: number): string;
  slugify(text: string): string;
  currentBranch(cwd: string): Promise<string | null>;
  ensureWorktree(request: { mainRoot: string; path: string; branch: string; base: string }): Promise<{
    path: string;
    branch: string;
  }>;
  listWorktrees(mainRoot: string): Promise<{ path: string; branch: string }[]>;
}

// What a Run reaches outside its process, which a test replaces with a fake (ADR 0019): GitHub, git, the shell, the
// locks, the State Database, time, and the integrity built from git and the locks. Given none, the State Database is
// the real one, the clock the wall clock, and the integrity the real one over this git and these locks.
export interface Deps {
  gh: github.Gh;
  git: RunGit;
  exec: Pick<exec.Exec, 'runShell' | 'cleanupConfirmed'>;
  locks?: locks.Locks;
  database?: record.StateDatabase;
  clock?: clockModule.Clock;
  integrity?: integrity.Integrity;
}

// A Harness as the interpreter calls it (docs/interfaces/harness.md).
export interface HarnessResult {
  status: visit.CallSignal['status'];
  sessionId: string | null;
  transcriptPath: string | null;
  usage: { cumulative: events.Usage; delta: events.Usage };
  exitCode?: number | null;
  exitSignal?: string | null;
  finalEventSubtype?: string | null;
  // What the Harness's own stream reported, as it parsed it: diagnostic only.
  sessionInit?: jsonValue.JsonValue;
  permissionDenials?: jsonValue.JsonValue;
  commandsRun?: jsonValue.JsonValue;
  cleanup?: commandCleanup.CallCleanup;
}
export interface Harness {
  run(call: Record<string, unknown>): Promise<{
    response: jsonValue.JsonValue;
    result: HarnessResult;
    failure: visit.HarnessFailure | null;
  }>;
  resolveTools(agent: unknown): jsonValue.JsonValue;
  capabilities: { confinement?: string | null; sessionResume?: { supported?: boolean } };
}

export interface Ticket {
  number: number;
  title: string;
  body?: string;
  branch: string;
}

// Test Immutability (R3): which committed tests changed since the baseline.
export type TestImmutability = (
  cwd: string,
  baseline: string,
  globs: string[],
) => Promise<{ ok: boolean; changed: string[] }>;

// A hold, abandonment or fault decided before the Execution ran, by admission or saved with the record.
export type Admission = Pick<record.AdmissionStop, 'kind'> & Partial<record.AdmissionStop>;

// What runExecution takes. `fault`, an error the caller hit before the Execution could run, is reported as an
// unexpected fault without running it; `admission`, a hold or abandonment the caller decided, is its Terminal.
export interface ExecutionOptions {
  deps: Deps;
  pinned: config.Pinned;
  record: record.ExecutionRecord;
  events: ReturnType<typeof events.eventLog>;
  protectedPaths: string[];
  log: (line: string) => void;
  ticket?: Ticket;
  base?: string;
  cwd?: string;
  labelPrefix?: string;
  // The other worktrees an Attempt's Integrity Assertions guard, or how to list them.
  others?: string[] | (() => Promise<string[]>);
  // Each Visit runs on its pinned Agent's Harness; `harness` alone serves a caller with a single one.
  harness?: Harness;
  harnesses?: Record<string, Harness>;
  run?: string;
  runState?: sideEffect.RunState;
  testImmutability?: TestImmutability;
  publicText?: (text: string) => string;
  crashAt?: sideEffect.EffectContext['crashAt'];
  fault?: unknown;
  admission?: Admission | null;
}

// The Run context: the options with each dep under its own name, as the effects, Terminals and Reconciliation read
// them, the defaults filled in, and the methods each Action is entered, marked and recorded with.
export interface RunContext extends Omit<ExecutionOptions, 'deps'>, terminalReport.TerminalContext {
  gh: github.Gh;
  git: RunGit;
  exec: Pick<exec.Exec, 'runShell' | 'cleanupConfirmed'>;
  locks: locks.Locks | undefined;
  database: record.StateDatabase;
  clock: clockModule.Clock;
  integrity: integrity.Integrity;
  testImmutability: TestImmutability;
  run: string;
  runState: sideEffect.RunState;
  // The pinned value's Flow, under the name every Visit and Action reads it by.
  flow: model.ResolvedFlow;
  publicText: (text: string) => string;
  laterRunReport: boolean;
  // The pinned Agent's Harness, or null for a Vertex without an Agent.
  harnessOf: () => Harness | null;
}

// A hold, fault or abandonment decided and saved, at admission or by a Terminal, whose ticket_end has not landed.
export const reportDecided = (executionRecord: record.ExecutionRecord): boolean =>
  !!(
    executionRecord.terminalStop?.held ||
    executionRecord.terminalStop?.error ||
    executionRecord.terminalStop?.abandoned
  ) && !eventRead.hasTicketEnd(executionRecord.commonDir, executionRecord.execution);

// The deps and options as one context; `integrity` and `testImmutability` default to the real ones over the git given.
export function createRunContext(options: ExecutionOptions): RunContext {
  const { deps, ...given } = options;
  const { record: executionRecord } = options;
  const { clock = clockModule.WALL_CLOCK } = deps;
  // A resumed record keeps the Run that wrote its markers, while its Events belong to the Run resuming it. The
  // methods are attached below, so the literal is not yet a whole RunContext.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const runContext = {
    ...given,
    ...deps,
    clock,
    flow: options.pinned.flow,
    run: options.run ?? executionRecord.run,
    runState: options.runState ?? { stop: null, remoteNotBefore: 0 },
    database: deps.database ?? record,
    integrity: deps.integrity ?? integrity.createIntegrity(deps.git, undefined, deps.locks),
    testImmutability:
      options.testImmutability ??
      ((cwd: string, baseline: string, globs: string[]) =>
        checks.testImmutability(cwd, baseline, { globs, git: deps.git })),
  } as RunContext;
  // Reconciliation looks for a remote effect as a retry does: a failed lookup is retried on the Action's budget.
  if (deps.git && Object.hasOwn(deps.git, 'withGuard'))
    runContext.git = deps.git.withGuard!((verb, args, unlocked) =>
      remoteEffects.lockGuard(runContext, verb, args, unlocked),
    );
  runContext.publicText ??= publicText.publicTextFor({
    worktree: executionRecord.worktree,
    commonDir: executionRecord.commonDir,
    cwd: options.cwd,
  });
  attachActionMethods(runContext);
  runContext.laterRunReport = reportDecided(executionRecord);
  return runContext;
}

// A Vertex without an Agent (publish) runs on no Harness, and a fault before the first Visit has no pinned Agent, so
// their deterministic Actions record no confinement.
function attachActionMethods(runContext: RunContext) {
  const { record: executionRecord, flow, clock } = runContext;
  runContext.harnessOf = () => {
    const agent = executionRecord.configurationSnapshot?.agent;
    return agent == null ? null : (runContext.harnesses?.[agent.harness] ?? runContext.harness ?? null);
  };
  // Records one Action Event: the Action's identity (with its attempt), when it began, and its outcome and payload.
  runContext.emit = (actionIdentity, startedAt, fields) =>
    runContext.events('action', {
      flow: flow.name,
      configHash: executionRecord.configHash,
      launchProfile: null,
      confinement: runContext.harnessOf()?.capabilities.confinement ?? null,
      ticket: executionRecord.ticket,
      run: runContext.run,
      execution: executionRecord.execution,
      attempt: 1,
      durationMs: clock.now() - startedAt,
      ...actionIdentity,
      ...fields,
    });
  runContext.markerOf = (actionIdentity) =>
    marker.formatMarker({
      execution: executionRecord.execution,
      run: executionRecord.run,
      attempt: 1,
      ...actionIdentity,
    } as Parameters<typeof marker.formatMarker>[0]);
  runContext.enter = (actionIdentity) => enter(runContext, actionIdentity);
}

// The cursor moves to the Action, saved before it runs.
async function enter(runContext: RunContext, actionIdentity: marker.ActionIdentity) {
  const executionRecord = runContext.record;
  const cursor = executionRecord.cursor;
  // A resume re-entering the cursor's own Action continues at its Attempt.
  const same =
    cursor.vertex === actionIdentity.vertex &&
    cursor.visit === actionIdentity.visit &&
    cursor.action === actionIdentity.action &&
    cursor.recovery === actionIdentity.recovery;
  const attempt = actionIdentity.attempt ?? (same ? cursor.attempt : 1);
  // A Flow Action (one with a Procedure) counts each new Attempt toward the Action Cap; a resumed one is not new.
  if (actionIdentity.procedure && !(same && attempt === cursor.attempt))
    executionRecord.attempts = (executionRecord.attempts ?? 0) + 1;
  executionRecord.cursor = {
    vertex: actionIdentity.vertex,
    visit: actionIdentity.visit,
    action: actionIdentity.action,
    recovery: actionIdentity.recovery,
    attempt,
  };
  runContext.database.save(executionRecord);
}
