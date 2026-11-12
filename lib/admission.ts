// gg run's admission of one Ticket: its Execution Record, its readiness, its worktree and the holds they decide, then
// the Execution it runs.
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import * as config from './config.ts';
import * as effectErrors from './effect-errors.ts';
import * as effectEvidence from './effect-evidence.ts';
import type * as effects from './effects.ts';
import type * as events from './events.ts';
import type * as github from './github.ts';
import * as interpreter from './interpreter.ts';
import * as labels from './labels.ts';
import * as marker from './marker.ts';
import type * as model from './model.ts';
import * as reconcile from './reconcile.ts';
import * as runFlows from './run-flows.ts';
import * as record from './record.ts';
import * as publicText from './public-text.ts';
import type * as runContext from './run-context.ts';
import * as ticketWorktree from './ticket-worktree.ts';

// The repository a Run works in: its main checkout, shared .git directory and folder, and its GitHub owner/name.
export type Repo = Awaited<ReturnType<runContext.RunGit['repoInfo']>> & { repository: string };

// What every Ticket of a Run reads: the Run's settings and the Flow a new Execution pins, every admitted Flow, the deps
// with gh and git as the Run shares them (labels ensured once, writes under the repo lock), Events and run stop.
export interface AdmissionContext {
  config: config.Settings;
  flow: model.ResolvedFlow;
  hash: string;
  flows: ReadonlyMap<string, runFlows.PinnedFlow>;
  runId: string;
  repo: Repo;
  harnesses: Record<string, unknown>;
  protectedPaths: string[];
  deps: Required<Omit<runContext.Deps, 'integrity'>> & Pick<runContext.Deps, 'integrity'>;
  testImmutability?: runContext.TestImmutability;
  commands: config.Settings['commands'];
  testPaths: string[] | undefined;
  log: (line: string) => void;
  events: ReturnType<typeof events.eventLog>;
  runState: effects.RunState;
  epic: number | null;
}

// A Ticket's result: its Outcome, the State Label it ends with, and whether a label update or a fault failed it.
export interface TicketResult {
  ticket: number;
  outcome: string;
  state?: string;
  labelFailed?: boolean;
  held?: boolean;
  fault?: boolean;
  error?: unknown;
  unread?: string;
  flowMissing?: boolean;
}

// One Ticket's admission as it goes: what it read before deciding, the record it decided on, and whether a label
// update failed, which an Event of the Execution can still set.
interface Admitting {
  issue: github.Issue;
  context: AdmissionContext;
  ticket: number;
  cwd: string;
  issueLabels: string[];
  state: (name: string) => string;
  recovery: string;
  executionRecord: record.ExecutionRecord | null;
  path: string;
  branch: string;
  redact: (text: unknown) => string;
  labelFailed: boolean;
  started: boolean;
  events: ReturnType<typeof events.eventLog>;
}
// What admission decided before the Execution runs: a hold, abandonment or fault, and the other worktrees to guard.
interface Decided {
  admission?: runContext.Admission;
  fault?: unknown;
  others: string[] | (() => Promise<string[]>);
}

// An end is its own State Label; an abandonment leaves the human's needs-human.
const stateOf = (outcome: string) => {
  if (outcome === 'abandoned') return labels.NEEDS_HUMAN;
  return (labels.END_STATES as readonly string[]).includes(outcome) ? outcome : undefined;
};

// Admission's hold, abandonment or fault is saved with every field, so a reader never meets a missing key.
const declaredAdmissionStop = (decision: runContext.Admission): record.AdmissionStop => ({
  kind: decision.kind,
  name: decision.name ?? null,
  terminalReasonText: decision.terminalReasonText ?? null,
  fresh: decision.fresh ?? false,
  advice: decision.advice ?? null,
  detail: decision.detail ?? null,
  inProgress: decision.inProgress ?? false,
  error: decision.error ?? null,
});

const setLabels = (admitting: Admitting, change: github.LabelChange) =>
  admitting.context.deps.gh.setLabels(admitting.ticket, change, admitting.cwd, {
    log: admitting.context.log,
    ev: admitting.events,
  });

export function skip({ context, issue }: Pick<Admitting, 'context' | 'issue'>, reason: string): TicketResult {
  context.log(`#${issue.number} skipped: ${reason}`);
  const needsHuman = labels.labelsFor(context.config.labelPrefix).state(labels.NEEDS_HUMAN);
  const held = labels.hasLabel(context.deps.gh.labelNames(issue), needsHuman);
  return { ticket: issue.number, outcome: 'skipped', ...(held && { state: labels.NEEDS_HUMAN }) };
}
// The Ticket's row, its labels and the worktree and branch it runs in. A landed fresh hold restarts as a new Execution;
// readiness then judges whether a human has cleared it.
async function openAdmission(issue: github.Issue, context: AdmissionContext) {
  const { config: settings, repo, deps, runId } = context;
  const ticket = issue.number;
  const cwd = repo.mainRoot;
  const recordLocation = relative(cwd, join(repo.gitCommonDir, 'gg', 'gg.db')).replaceAll('\\', '/');
  const state = labels.labelsFor(settings.labelPrefix).state;
  const recovery =
    `Inspect the row first in the State Database at ${recordLocation} (relative to the main checkout) using a SQLite ` +
    'client. After preserving your changes, delete it with ' +
    `\`DELETE FROM records WHERE kind = 'ticket' AND n = ${ticket};\`, then remove the ` +
    `${state(labels.NEEDS_HUMAN)} label and re-run gg run ${ticket}.`;
  const issueLabels = deps.gh.labelNames(issue);
  const admitting = { issue, context, ticket, cwd, issueLabels, state, recovery, labelFailed: false } as Admitting;
  admitting.events = (type, data) => {
    if (type !== 'label_failed') return context.events(type, data);
    admitting.labelFailed = true;
    // The check above says which Event this is, which tsc cannot read from a type parameter.
    context.events('label_failed', { run: runId, ...(data as events.EventInput<'label_failed'>) });
  };
  const loaded = reconcile.loadExecutionRecord(repo.gitCommonDir, ticket);
  const { corrupt } = loaded;
  let executionRecord = loaded.executionRecord;
  const pending = executionRecord && interpreter.pendingReport(executionRecord);
  if (executionRecord?.state === 'held' && executionRecord.terminalStop?.fresh && !pending) executionRecord = null;
  const worktreeRoot = settings.worktreeRoot.replace(/^~(?=$|[\\/])/, homedir());
  admitting.executionRecord = executionRecord;
  admitting.path = executionRecord?.worktree ?? deps.git.worktreePath(worktreeRoot, repo.repository, ticket);
  admitting.redact = publicText.publicTextFor({ worktree: admitting.path, commonDir: repo.gitCommonDir, cwd });
  admitting.branch = executionRecord?.branch ?? `ticket/${ticket}-${deps.git.slugify(admitting.redact(issue.title))}`;
  admitting.started = false;
  return { admitting, corrupt, pending };
}

// An unreadable row holds no intent, so the marker comes from the Ticket and the row itself: a comment that landed
// before its label failed is found on the next Run, not posted again.
async function holdCorruptRecord(admitting: Admitting, corrupt: record.RecordCorruptError): Promise<TicketResult> {
  const { context, ticket, cwd, state } = admitting;
  const { gh } = context.deps;
  if (labels.hasLabel(admitting.issueLabels, state(labels.NEEDS_HUMAN)))
    return skip(admitting, `it is labelled ${state(labels.NEEDS_HUMAN)}`);
  const { reason } = await reconcile.reconcile({
    corrupt,
    flow: context.flow,
    git: context.deps.git,
    gh,
    labelPrefix: context.config.labelPrefix,
    cwd,
    database: context.deps.database,
  });
  context.log(`#${ticket} hold: ${reason}`);
  const rowHash = config.sha256(corrupt.raw ?? corrupt.message).slice(0, 12);
  const actionMarker = marker.formatMarker({
    execution: `${ticket}.corrupt`,
    vertex: labels.NEEDS_HUMAN,
    visit: 1,
    action: 'hold-comment',
    recovery: 0,
    run: rowHash,
    attempt: 1,
  });
  if (!(await gh.comments(ticket, cwd)).some((comment) => effectEvidence.carries(comment.body, actionMarker))) {
    const text = admitting.redact(
      `### gg: needs-human\n\nExecution Record ticket-${ticket} could not be read, so no agent ran and the record ` +
        `was kept. ${admitting.recovery}\n`,
    );
    await gh.comment(ticket, `${text}\n${marker.markerComment(actionMarker)}\n`, cwd);
  }
  await setLabels(admitting, { add: [state(labels.NEEDS_HUMAN)], remove: [state('in-progress')] });
  const { labelFailed } = admitting;
  return { ticket, outcome: labels.NEEDS_HUMAN, state: labels.NEEDS_HUMAN, held: true, labelFailed };
}

// A finished record is never resumed, whatever intents its log leaves open (a fault report leaves one for good). An
// Interrupted Attempt's warning comes before the recovery that deletes the row and its saved baseline.
function notResumedSkip(admitting: Admitting): TicketResult | null {
  const { executionRecord, ticket, state } = admitting;
  const warning =
    executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt'
      ? `${reconcile.INTERRUPTED_ADVICE} `
      : '';
  if (executionRecord?.state === 'held')
    return skip(
      admitting,
      `Execution Record ticket-${ticket} is held and cannot resume. ${warning}${admitting.recovery}`,
    );
  if (executionRecord && executionRecord.state !== 'active')
    return skip(admitting, `its Execution Record is finished (${executionRecord.state}); it is not resumed`);
  const missing = executionRecord && runFlows.missingFlow(admitting.context, executionRecord);
  if (missing) return missing;
  if (!executionRecord && labels.hasLabel(admitting.issueLabels, state('in-progress')))
    return skip(admitting, `it is labelled ${state('in-progress')} with no Execution Record behind it`);
  return null;
}

// The record exists before admission's first GitHub effect, so whatever admission decides lands through its Terminal.
// The record, its ticket_start and admission's decision commit together.
async function startTicket(
  admitting: Admitting,
  worktree: { path: string; branch: string } | undefined,
  decision: runContext.Admission | undefined,
) {
  if (admitting.started) return;
  const { context, ticket } = admitting;
  admitting.executionRecord ??= record.createExecutionRecord({
    commonDir: context.repo.gitCommonDir,
    repository: context.repo.repository,
    ticket,
    epic: context.epic,
    // Preflight admits only a Flow with no errors, and a Flow without an entry Vertex is one.
    flow: { name: context.flow.name, entry: context.flow.ticket.entry! },
    configHash: context.hash,
    run: context.runId,
    worktree: worktree?.path ?? admitting.path,
    branch: worktree?.branch ?? admitting.branch,
    base: context.config.baseBranch,
  });
  const executionRecord = admitting.executionRecord;
  if (decision) executionRecord.admissionStop = declaredAdmissionStop(decision);
  context.deps.database.save(executionRecord, () =>
    admitting.events('ticket_start', { run: context.runId, execution: executionRecord.execution, ticket }),
  );
  admitting.started = true;
}

// A held record cannot resume, so its recovery also deletes the row; a fresh hold has none to delete.
function advise(admitting: Admitting, fresh: boolean, next: string | undefined): string {
  const { ticket, recovery } = admitting;
  if (fresh)
    return `${next}, then remove the ${admitting.state(labels.NEEDS_HUMAN)} label and re-run gg run ${ticket}.`;
  return `Execution Record ticket-${ticket} is held and cannot resume. ${next ? `${next}. ` : ''}${recovery}`;
}

// A worktree with a merge conflict, or with changes gg did not make, holds the Ticket.
function dirtyHold(
  admitting: Admitting,
  fresh: boolean,
  held: { conflicts: string[]; stat: string; rescueRef: string | null },
): runContext.Admission {
  const conflicted = held.conflicts.length > 0;
  const found = conflicted
    ? 'The worktree has a merge conflict'
    : 'The worktree has uncommitted changes gg did not make';
  admitting.context.log(`#${admitting.ticket} hold: ${found}`);
  const next = conflicted
    ? 'Resolve and commit the conflicted paths in the worktree'
    : 'Commit, stash or remove these changes in the worktree';
  return {
    kind: 'hold',
    name: conflicted ? 'merge-conflict' : 'dirty-worktree',
    fresh,
    terminalReasonText:
      `${found}, so the Ticket is held, no agent ran and nothing was deleted.` +
      (held.rescueRef ? ` Rescue Ref ${held.rescueRef} keeps the work rescued before it.` : ''),
    advice: advise(admitting, fresh, next),
    detail: (conflicted ? `Conflicted paths:\n${held.conflicts.join('\n')}\n\n` : '') + held.stat,
  };
}

// A resumed record's State Label is Reconciliation's to judge, but it still needs an open, unblocked Ticket. Then its
// worktree: on the wrong branch, conflicted or dirty, it holds the Ticket. `decided.others` is set as soon as it is
// known, so a later failure still guards it.
async function admitReadyTicket(admitting: Admitting, fresh: boolean, decided: Decided) {
  const { context, issue, executionRecord } = admitting;
  const { gh, git, locks, integrity } = context.deps;
  const notReady = gh.readinessReason(executionRecord ? { ...issue, labels: [] } : issue, {
    prefix: context.config.labelPrefix,
  });
  if (notReady) return { skipped: skip(admitting, `it is not ready: ${notReady}`) };
  const admitted = await ticketWorktree.admitWorktree(executionRecord, git, {
    ticket: admitting.ticket,
    mainRoot: admitting.cwd,
    path: admitting.path,
    branch: admitting.branch,
    base: context.config.baseBranch,
  });
  const { worktree } = admitted;
  decided.others = admitted.others ?? [];
  if (admitted.hold) {
    context.log(`#${admitting.ticket} hold: ${admitted.hold}`);
    decided.admission = {
      kind: 'hold',
      name: 'branch-mismatch',
      terminalReasonText: admitted.hold,
      fresh,
      advice: advise(admitting, fresh, admitted.next),
    };
  }
  const held =
    worktree && (await reconcile.dirtyState(executionRecord, { git, worktree: worktree.path, locks, integrity }));
  if (held) decided.admission = dirtyHold(admitting, fresh, held);
  return { worktree };
}

// A human's needs-human label is honoured before anything is discarded or labelled (request 3.5). Returns the skip
// result when the Ticket is not ready, or null once admission has decided and started the Ticket.
async function decide(admitting: Admitting, decided: Decided): Promise<TicketResult | null> {
  const { context, executionRecord } = admitting;
  const fresh = !executionRecord;
  try {
    const overridden =
      executionRecord && reconcile.humanOverride(executionRecord, admitting.issueLabels, context.config.labelPrefix);
    let worktree;
    if (overridden) {
      context.log(`#${admitting.ticket} abandon: ${overridden.reason}`);
      decided.admission = {
        kind: 'abandon',
        terminalReasonText: overridden.reason,
        inProgress: overridden.inProgress,
      };
    } else {
      const ready = await admitReadyTicket(admitting, fresh, decided);
      if (ready.skipped) return ready.skipped;
      ({ worktree } = ready);
    }
    await startTicket(admitting, worktree, decided.admission);
    if (!decided.admission && !labels.hasLabel(admitting.issueLabels, admitting.state('in-progress')))
      await setLabels(admitting, { add: [admitting.state('in-progress')] });
  } catch (err) {
    if (err instanceof record.RecordSaveError) throw err;
    // An Execution that cannot be admitted is an unexpected fault: reported and marked, so it is never retried
    // automatically (request 3.4).
    const error = effectErrors.errorText(err);
    context.log(`#${admitting.ticket} ERROR ${error}`);
    decided.fault = err;
    await startTicket(admitting, undefined, { kind: 'fault', error });
  }
  return null;
}

// The Execution from its cursor, or the Terminal admission decided.
async function runAdmitted(admitting: Admitting, decided: Decided): Promise<TicketResult> {
  const { context, issue, ticket } = admitting;
  const executionRecord = admitting.executionRecord!;
  const { flow, hash, files } = runFlows.pinnedFlow(context.flows, executionRecord.flow, executionRecord.configHash);
  const result = await interpreter.runExecution({
    deps: context.deps,
    flow,
    record: executionRecord,
    harnesses: context.harnesses as Record<string, runContext.Harness>,
    protectedPaths: context.protectedPaths,
    run: context.runId,
    testImmutability: context.testImmutability,
    events: admitting.events,
    log: context.log,
    cwd: admitting.cwd,
    commands: context.commands,
    testPaths: context.testPaths,
    files,
    ticket: { number: ticket, title: issue.title, body: issue.body, branch: executionRecord.branch },
    base: context.config.baseBranch,
    labelPrefix: context.config.labelPrefix,
    approvers: context.config.approvers,
    configHash: hash,
    others: decided.others,
    fault: decided.fault,
    admission: decided.admission,
    runState: context.runState,
  });
  return {
    ticket,
    outcome: result.outcome,
    state: stateOf(result.outcome),
    labelFailed: admitting.labelFailed,
    ...(result.unread && { unread: result.unread }),
    ...(result.fault && {
      fault: true,
      error: (result as { error?: unknown }).error ?? executionRecord.terminalStop?.error,
    }),
  };
}

// A decided hold, fault or abandonment that has not landed is finished first and admits no more work. Its
// ticket_start landed with the Run that decided it.
export async function admit(issue: github.Issue, context: AdmissionContext): Promise<TicketResult> {
  const { admitting, corrupt, pending } = await openAdmission(issue, context);
  if (corrupt) return holdCorruptRecord(admitting, corrupt);
  const decided: Decided = { others: [] };
  if (!pending) {
    const skipped = notResumedSkip(admitting) ?? (await decide(admitting, decided));
    if (skipped) return skipped;
  }
  return runAdmitted(admitting, decided);
}
