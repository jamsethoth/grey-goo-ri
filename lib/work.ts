// `gg work`: a person's recovery verbs over the Tickets gg runs: abandon, done and resume.
import * as admission from './admission.ts';
import * as closeEffect from './effects/close.ts';
import * as effects from './effects/index.ts';
import type * as config from './config.ts';
import * as eventsModule from './events.ts';
import type * as github from './github.ts';
import * as integrityModule from './integrity.ts';
import * as labels from './labels.ts';
import type * as locks from './locks.ts';
import * as reconcile from './reconcile.ts';
import * as record from './record.ts';
import * as runContext from './run-context.ts';
import * as stateDatabase from './state-database/index.ts';
import * as terminal from './terminal.ts';
import * as terminalReport from './terminal-report.ts';
import * as visitInputs from './visit-inputs.ts';

// What gg work abandon reaches: the repository's State Database and ticket lock, and GitHub for its State Label.
export interface AbandonOptions {
  ticket: number;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  gh: github.Gh;
  locks: Pick<locks.Locks, 'tryAcquire' | 'release'>;
}

// Request 3.5's abandon: keep the worktree, forget the position. The record's row goes, as the recovery advice tells a
// person to do by hand, since admission skips a record that is merely marked finished; its Events, worktree and branch
// stay, so the next gg run starts a new Execution on that branch. Readiness refuses a Ticket with any State Label, and
// an in-progress one with no record behind it reads as stuck, so every State Label goes first, and the row only once
// they have.
export async function abandon({ ticket, commonDir, cwd, labelPrefix, gh, locks }: AbandonOptions): Promise<string> {
  // Before the lock, which would leave its file in a repository gg init never set up (#150).
  stateDatabase.open(commonDir);
  return underTicketLock({ commonDir, ticket, locks, verb: 'abandon' }, async () => {
    const executionRecord = stateDatabase.load(commonDir, 'ticket', ticket);
    if (!executionRecord) throw new Error(`Ticket ${ticket} has no Execution Record to abandon`);
    const names = labels.labelsFor(labelPrefix);
    const stateLabels = gh
      .labelNames(await gh.viewIssue(ticket, cwd))
      .filter((name) => names.parse(name)?.family === 'state');
    const failures: string[] = [];
    const report = { log: (line: string) => failures.push(line), ev: () => {} };
    if (stateLabels.length && !(await gh.setLabels(ticket, { remove: stateLabels }, cwd, report)))
      throw new Error(`${failures.join('; ')}; Execution Record ticket-${ticket} is kept`);
    stateDatabase.removeRecord(commonDir, 'ticket', ticket);
    const plural = stateLabels.length > 1 ? 's' : '';
    const removed = stateLabels.length ? ` and removed the ${stateLabels.join(', ')} label${plural}` : '';
    return (
      `gg work abandon deleted Execution Record ticket-${ticket} of Flow ${executionRecord.flow}${removed}; its ` +
      `Events, its worktree ${executionRecord.worktree} and its branch ${executionRecord.branch} are kept. ` +
      `gg run ${ticket} --flow <name> starts a new Execution on that branch.\n`
    );
  });
}

// The record states a person hands back or resolves: each end a hold, a fault, an abandonment or a stopping end lands
// in (owner, 2026-11-06).
const STOPPED_STATES = [labels.NEEDS_HUMAN, 'needs-replan', 'held', 'fault', 'abandoned'];
const stoppedList = `${STOPPED_STATES.slice(0, -1).join(', ')} or ${STOPPED_STATES.at(-1)}`;

// A Pending Ticket waits for a Decision or a cleanup confirmation with its record still active (L11, J6).
const isPending = (executionRecord: record.ExecutionRecord) =>
  executionRecord.state === 'active' &&
  (executionRecord.approvalRequest !== null || reconcile.heldForCleanup(executionRecord));

// What gg work done reaches: the deps a Run has, with the locks, and whether the person passed --close.
export interface DoneOptions {
  ticket: number;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  deps: runContext.Deps & { locks: locks.Locks };
  close: boolean;
  log: (line: string) => void;
}

// Whether gg work done closes the issue (Q4 A): never while the branch's PR is open, since the issue would stay open
// and its dependents blocked; once merged, if the issue is still open; with no PR, or one closed unmerged, only when
// the person passed --close.
async function closesIssue(executionRecord: record.ExecutionRecord, { deps, cwd, close }: DoneOptions) {
  const { ticket, branch } = executionRecord;
  const pr = await deps.gh.findPr(branch, cwd);
  if (pr?.state === 'OPEN') throw new Error(`PR #${pr.number} of Ticket ${ticket} is open; merge or close it first`);
  if (pr?.state !== 'MERGED' && !close)
    throw new Error(`Ticket ${ticket} has no merged PR; pass --close when no change was needed`);
  return (await deps.gh.viewIssue(ticket, cwd)).state === 'OPEN';
}

// L12's gg work done: a person finished the Ticket by hand, so gg records its end as done, decided by their gh login.
// The branch and the worktree stay as they are.
export async function done(options: DoneOptions): Promise<string> {
  const { ticket, commonDir, cwd, labelPrefix, deps, log } = options;
  // Before the lock, which would leave its file in a repository gg init never set up (#150).
  stateDatabase.open(commonDir);
  return underTicketLock({ commonDir, ticket, locks: deps.locks, verb: 'resolve' }, async () => {
    const executionRecord = (deps.database ?? stateDatabase).load(commonDir, 'ticket', ticket);
    if (!executionRecord) throw new Error(`Ticket ${ticket} has no Execution Record to resolve`);
    if (!STOPPED_STATES.includes(executionRecord.state) && !isPending(executionRecord))
      throw new Error(
        `Ticket ${ticket} is ${executionRecord.state}; gg work done takes a Ticket that is ${stoppedList}, or Pending`,
      );
    // A close intent left open landed or not; the close Effect is safe to make again, so a rerun finishes it.
    const closeOpen = effects.openIntents(executionRecord, closeEffect.effect).length > 0;
    const close = (await closesIssue(executionRecord, options)) || closeOpen;
    // gg:state:done is created as a Run creates its State Labels.
    await deps.gh.ensureLabels(cwd, { prefix: labelPrefix });
    const human = await deps.gh.login(cwd);
    // The Flow is not read, so a Ticket whose Flow is gone is still resolved.
    const pinned = admission.pinnedFlow(new Map(), executionRecord.flow, executionRecord.configHash);
    const context = runContext.createRunContext({
      deps,
      pinned,
      record: executionRecord,
      events: eventsModule.eventLog(commonDir, {}, deps.database),
      protectedPaths: [],
      log,
      cwd,
      labelPrefix,
    });
    // Each person's gg work done may deliver its report once more (#60), so a retry spent on a failed comment is
    // launched again rather than refused for good.
    context.laterRunReport = true;
    context.resolving = true;
    await terminalReport.resolve(context, { human, reason: terminal.resolvedReason(ticket, human), close });
    const closed = close ? `, and closed issue #${ticket}` : '';
    return `gg work done resolved Ticket ${ticket} as done, decided by ${human}${closed}.\n`;
  });
}

// What gg work resume reaches, under the ticket lock gg run's admission holds: the Flow the record runs under, and the
// deps of the Run that resumes it.
interface ResumeOptions {
  ticket: number;
  vertex: string;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  flows: ReadonlyMap<string, config.Pinned>;
  deps: Pick<runContext.Deps, 'gh' | 'git' | 'integrity' | 'locks' | 'database'>;
  events: ReturnType<typeof eventsModule.eventLog>;
  run: string;
  log: (line: string) => void;
}

// Why the Ticket cannot re-enter at `vertex`, or null: the Flow must have the Vertex, and a Visit in the record must
// have produced each input it requires (L16).
function unenterable(executionRecord: record.ExecutionRecord, { vertex, flows }: ResumeOptions): string | null {
  const flow = flows.get(executionRecord.flow)?.flow;
  if (!flow) return `Ticket ${executionRecord.ticket} runs under Flow ${executionRecord.flow}, which is not declared`;
  const target = flow.ticket.vertices.get(vertex);
  if (!target)
    return `Flow ${flow.name} has no Vertex ${vertex}; its Vertices are ${[...flow.ticket.vertices.keys()].join(', ')}`;
  const missing = Object.entries(target.inputs).filter(([name, input]) => {
    try {
      visitInputs.resolveInputs(executionRecord, vertex, { [name]: input });
      return false;
    } catch {
      return true;
    }
  });
  // A Vertex's Visit Bound holds on a resume as on a route; a person who wants more Visits raises it in the Flow.
  const visits = executionRecord.visits.get(vertex) ?? 0;
  if (target.max !== null && visits >= target.max)
    return `Vertex ${vertex} has used its Bound of ${target.max} Visit${target.max === 1 ? '' : 's'}`;
  if (!missing.length) return null;
  const names = missing.map(([name]) => name).join(', ');
  return `Vertex ${vertex} needs the inputs ${names}, which no Visit in the record produced`;
}

// L12's gg work resume, the step gg run takes first when it is given one, under the ticket lock, before admission reads
// the record (Q3 A): a person fixed what stopped the Ticket, so its Execution re-enters at a new Visit of the Vertex,
// its Visit, Edge and Action Cap counts kept, and the branch tip the person left is the baseline Reconciliation checks
// from (Q2 A).
// It gives the issue as the resume left it: the stop's labels are down, and admission must not read them as a person's.
export async function resume(context: admission.AdmissionContext, ticket: number): Promise<github.Issue> {
  const { repo, config: settings, deps, flows, events } = context;
  await reposition({
    ticket,
    vertex: context.resume!.vertex,
    commonDir: repo.gitCommonDir,
    cwd: repo.mainRoot,
    labelPrefix: settings.labelPrefix,
    flows,
    deps,
    events,
    run: context.runId,
    log: context.log,
  });
  return deps.gh.viewIssue(ticket, repo.mainRoot);
}

async function reposition(options: ResumeOptions): Promise<void> {
  const { ticket, vertex, commonDir, cwd, deps, events } = options;
  const database = deps.database ?? stateDatabase;
  const executionRecord = database.load(commonDir, 'ticket', ticket);
  if (!executionRecord) throw new Error(`Ticket ${ticket} has no Execution Record to resume`);
  if (!STOPPED_STATES.includes(executionRecord.state))
    throw new Error(
      `Ticket ${ticket} is ${executionRecord.state}; gg work resume takes a Ticket that is ${stoppedList}`,
    );
  const why = unenterable(executionRecord, options);
  if (why) throw new Error(why);
  const { worktree } = executionRecord;
  const integrity = deps.integrity ?? integrityModule.createIntegrity(deps.git, undefined, deps.locks);
  if (!(await integrity.isCleanAt(worktree)))
    throw new Error(`the worktree ${worktree} of Ticket ${ticket} is not clean; commit or discard its changes first`);
  const human = await deps.gh.login(cwd);
  const head = await deps.git.headSha(worktree);
  // Completed in memory only: the save that writes ticket_resumed commits them, so a failure before it keeps them open.
  // Looked up before the labels come down, which would hide a label that landed.
  // The person overrides an Interrupted Attempt (Q1 A), so they are told what to check first (ADR 0011).
  if (reconcile.interruptedAttempt(executionRecord)) options.log(`#${ticket} ${reconcile.INTERRUPTED_ADVICE}`);
  const superseded = await reconcile.supersedeOpenIntents(executionRecord, { gh: deps.gh, git: deps.git, cwd });
  await removeStopLabels(executionRecord, options);
  Object.assign(executionRecord, {
    state: 'active',
    terminalReason: null,
    terminalStop: null,
    admissionStop: null,
    approvalRequest: null,
    visitState: null,
    cursor: { vertex, visit: (executionRecord.visits.get(vertex) ?? 0) + 1, action: null, recovery: 0, attempt: 1 },
  });
  const { execution, owner } = executionRecord;
  database.save(executionRecord, () =>
    events('ticket_resumed', { run: options.run, execution, ticket, owner, human, vertex, head, superseded }),
  );
}

// The State and Await Labels the stop left: a needs-human label left on would read as a person's override, and
// readiness reads any as busy. gg run's admission labels the Ticket in progress once it runs.
async function removeStopLabels(executionRecord: record.ExecutionRecord, { deps, cwd, labelPrefix }: ResumeOptions) {
  const names = labels.labelsFor(labelPrefix);
  const left = deps.gh
    .labelNames(await deps.gh.viewIssue(executionRecord.ticket, cwd))
    .filter((name) => ['state', 'await'].includes(names.parse(name)?.family ?? ''));
  const failures: string[] = [];
  const report = { log: (line: string) => failures.push(line), ev: () => {} };
  if (left.length && !(await deps.gh.setLabels(executionRecord.ticket, { remove: left }, cwd, report)))
    throw new Error(`${failures.join('; ')}; Ticket ${executionRecord.ticket} is not resumed`);
}

// A verb's work under the Ticket's lock, refused while a Run or another verb holds it.
async function underTicketLock<Result>(
  {
    commonDir,
    ticket,
    locks,
    verb,
  }: { commonDir: string; ticket: number; locks: AbandonOptions['locks']; verb: string },
  work: () => Promise<Result>,
): Promise<Result> {
  const lock = await locks.tryAcquire(commonDir, `ticket-${ticket}`);
  if (!lock)
    throw new Error(
      `another process holds the ticket-${ticket} lock, so Ticket ${ticket} may be running; ${verb} it once that ` +
        'process ends',
    );
  try {
    return await work();
  } finally {
    await locks.release(lock);
  }
}
