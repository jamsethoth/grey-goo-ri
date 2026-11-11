import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as admission from './admission.ts';
import * as cleanupHold from './cleanup-hold.ts';
import * as clockModule from './clock.ts';
import * as config from './config.ts';
import * as effectErrors from './effect-errors.ts';
import * as events from './events.ts';
import * as flowModule from './flow.ts';
import * as github from './github.ts';
import * as labels from './labels.ts';
import * as locksModule from './locks.ts';
import * as model from './model.ts';
import * as record from './record.ts';
import * as runFlows from './run-flows.ts';
import type * as runContext from './run-context.ts';
import * as settingsModule from './settings.ts';
import * as report from './validate/report.ts';
import * as stateDatabase from './state-database.ts';

type TicketResult = admission.TicketResult;

// A Ticket left needing a human, or a record whose Flow is gone, is a gap a person closes: exit 2.
export const runExitCode = (results: TicketResult[]): number => {
  if (results.some((result) => result.labelFailed || result.fault || result.unread)) return 1;
  return results.some((result) => result.state === labels.NEEDS_HUMAN || result.flowMissing) ? 2 : 0;
};

export function epicProblem(tickets: unknown[], ready: unknown[]): string | null {
  if (!tickets.length) return 'epic has no sub-issues; nothing to run (publish a plan first)';
  if (!ready.length)
    return 'nothing ready: every sub-issue is closed, blocked or already in progress / ready-for-qa / needs-human';
  return null;
}

// Runs up to `limit` tasks at once; results keep the order of `items`.
export async function mapConcurrently<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

// Every orchestrator git write waits for the repo lock, so two gg processes on one repo serialise (request 3.5).
// writeTree and the rescue's tree and commit write objects, and remoteSha fetches, so all of them count as writes.
const GIT_WRITES = [
  'ensureWorktree',
  'stageAll',
  'writeTree',
  'commitStaged',
  'commitTree',
  'push',
  'remoteSha',
  'resetTo',
  'rescueTree',
  'rescueCommit',
  'createRef',
] as const;
type Guard = (verb: string, args: unknown[], unlocked: runContext.RunGit) => Promise<unknown>;
// A write that waited for the lock runs `guard(verb, args, git)` once it holds it, with git unlocked: the guard may
// throw to stop the write, or return { skip: true } when the write's effect is already there (withGuard sets it).
// `locks` (locks.createLocks) takes the repo lock.
export const lockedGit = (
  git: runContext.RunGit,
  commonDir: string,
  { guard = null, locks = locksModule }: { guard?: Guard | null; locks?: Pick<locksModule.Locks, 'withLock'> } = {},
): runContext.RunGit => ({
  ...git,
  withGuard: (given) => lockedGit(git, commonDir, { guard: given, locks }),
  ...Object.fromEntries(
    GIT_WRITES.map((verb) => [
      verb,
      (...args: unknown[]) =>
        locks.withLock(
          commonDir,
          'repo',
          async ({ waited }) =>
            waited && guard && ((await guard(verb, args, git)) as { skip?: boolean } | undefined)?.skip
              ? undefined
              : (git[verb] as (...given: unknown[]) => Promise<unknown>)(...args),
          { timeoutMs: locksModule.REPO_LOCK_TIMEOUT_MS },
        ),
    ]),
  ),
});

// What gg run takes: the Ticket or Epic, the two configuration sources, the registered Harnesses, the deps it reaches
// outside its process (ADR 0019), and where it runs and logs.
export interface RunOptions {
  deps: runContext.Deps;
  target: number;
  flow?: string;
  config: config.Configuration;
  harnesses: Record<string, unknown>;
  protectedPaths: string[];
  cwd: string;
  log: (line: string) => void;
  testImmutability?: runContext.TestImmutability;
}

// Every line and error a Run prints names its repository on its first line, so two gg processes can share a terminal or
// a log: by its checkout's folder until gh has given its owner/name, then by that (#321).
export async function runTarget(options: RunOptions): Promise<TicketResult[]> {
  const checkout = await options.deps.git.repoInfo(options.cwd);
  let label = checkout.folder;
  const named = (message: string) => `[${label}] ${message}`;
  try {
    const admitted = await runFlows.admitConfiguration({ ...options, commonDir: checkout.gitCommonDir });
    const repo = await readRepository(options.deps.gh, checkout);
    label = repo.repository;
    return await runRepo(repo, { ...admitted, named }, options);
  } catch (err) {
    if (err instanceof Error) err.message = named(err.message);
    throw err;
  }
}

// The repository's owner/name, read once the configuration has passed preflight and before the Run reads GitHub for
// anything else: a failure fails preflight, naming the checkout.
async function readRepository(gh: github.Gh, checkout: Omit<admission.Repo, 'repository'>): Promise<admission.Repo> {
  const { repository, error } = await gh.repositoryName(checkout.mainRoot);
  if (repository !== null) return { ...checkout, repository };
  const found = report.newReport();
  const message = `cannot read the GitHub owner/name of ${checkout.mainRoot}: ${error}`;
  report.error(found, '', 'repository-unread', message, { path: checkout.mainRoot, reason: error });
  throw Object.assign(new Error(`preflight failed:\n${report.line('error', found.errors[0]!)}`), { exitCode: 1 });
}

// The Ticket, or an Epic's ready sub-issues. Every sub-issue is read before the Run's first effect, so an epic with
// nothing ready leaves no trace.
async function readTickets(gh: github.Gh, target: number, repo: admission.Repo, settings: config.Settings) {
  const issue = await gh.viewIssue(target, repo.mainRoot);
  const subIssues = github.linkedIssues(issue.subIssues);
  if (!subIssues.length) return { issue, subIssues, tickets: [issue] };
  const children = await Promise.all(subIssues.map((sub) => gh.viewIssue(sub.number, repo.mainRoot)));
  // A Pending Ticket reads as in progress, and its Await Label says it is waiting for this Run.
  const names = labels.labelsFor(settings.labelPrefix);
  const pending = (child: github.Issue) =>
    child.state === 'OPEN' && gh.labelNames(child).some((name) => names.parse(name)?.family === 'await');
  const tickets = children.filter((child) => gh.isReady(child, { prefix: settings.labelPrefix }) || pending(child));
  const problem = epicProblem(children, tickets);
  if (problem) throw new Error(`#${target}: ${problem}`);
  return { issue, subIssues, tickets };
}

// The gh a Run's Tickets share: a label update that adds a label first creates gg's State Labels, and the Await and
// Decide Labels a cleanup hold and any declared Flow can write, since a resumed Execution runs the Flow its record
// pins, once per Run, and again after a failed attempt.
function labelEnsuringGh(
  gh: github.Gh,
  repo: admission.Repo,
  settings: config.Settings,
  flows: runFlows.PinnedFlow[],
): github.Gh {
  const flowLabels = [
    labels.labelsFor(settings.labelPrefix).await(cleanupHold.AWAIT_VERTEX),
    ...new Set(flows.flatMap(({ flow }) => flowModule.approvalLabels(flow))),
  ];
  let ensuredLabels: Promise<void> | undefined;
  return {
    ...gh,
    setLabels: (issue, change, cwd, report) =>
      gh.setLabels(issue, change, cwd, {
        ...report,
        ...(change.add?.length && {
          ensureLabels: () =>
            (ensuredLabels ??= gh
              .ensureLabels(repo.mainRoot, { prefix: settings.labelPrefix, flowLabels })
              .catch((err) => {
                ensuredLabels = undefined;
                throw err;
              })),
        }),
      }),
  };
}

// The Run's directory with the Flow it runs, the Pinned Configuration of every declared Flow, which a resumed Execution
// may run under, and the Run's log: each line goes to the run log and the caller's log, named.
function startRun(
  repo: admission.Repo,
  { flows, selected, clock }: { flows: runFlows.PinnedFlow[]; selected: runFlows.PinnedFlow; clock: clockModule.Clock },
  { named, log }: { named: (message: string) => string; log: (line: string) => void },
) {
  const runId = `${new Date(clock.now()).toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(3).toString('hex')}`;
  const runDir = join(repo.gitCommonDir, 'gg', 'runs', runId);
  flowModule.writeResolved(runDir, model.toJson(selected.flow), selected.hash);
  for (const { hash, pinned } of flows) stateDatabase.savePinnedConfiguration(repo.gitCommonDir, hash, pinned);
  const runLog = (message: string) => {
    const line = named(message);
    appendFileSync(join(runDir, 'run.log'), `${new Date().toISOString()} ${line}\n`);
    log(line);
  };
  return { runId, runLog };
}

// What admission gave the Run, and how its lines name the repository.
type Admitted = Awaited<ReturnType<typeof runFlows.admitConfiguration>> & { named: (message: string) => string };

async function runRepo(repo: admission.Repo, admitted: Admitted, options: RunOptions) {
  const { flows, selected, warnings, settings, named } = admitted;
  const { target, harnesses, protectedPaths, testImmutability, deps, log } = options;
  const { gh, git, exec, integrity, locks = locksModule, database = record, clock = clockModule.WALL_CLOCK } = deps;
  const { flow, hash, source } = selected;
  const declared = [...flows.values()];
  const { issue, subIssues, tickets } = await readTickets(gh, target, repo, settings);
  const { runId, runLog } = startRun(repo, { flows: declared, selected, clock }, { named, log });
  const eventLog = events.eventLog(repo.gitCommonDir, {}, database);
  eventLog('run_start', { run: runId });
  runLog(
    `run ${runId} started for #${target} under Flow ${flow.name} from ${runFlows.sourceText(source)} ` +
      `(config ${hash.slice(0, 12)})`,
  );
  for (const warning of warnings) runLog(report.line('warning', warning));
  const results: TicketResult[] = [];
  // The first run stop of any Execution, which ends every other one before its next Action, and the cooldown every
  // remote Action of the Run waits for after any one of them backs off.
  const runState = { stop: null, remoteNotBefore: 0 } as runContext.ExecutionOptions['runState'] & {
    stop: { failureClass: string } | null;
  };
  const context: admission.AdmissionContext = {
    config: settings,
    flow,
    hash,
    flows,
    runId,
    repo,
    harnesses,
    protectedPaths,
    deps: {
      gh: labelEnsuringGh(gh, repo, settings, declared),
      git: lockedGit(git, repo.gitCommonDir, { locks }),
      exec,
      locks,
      database,
      clock,
      integrity,
    },
    testImmutability,
    commands: settings.commands,
    testPaths: settings.testPaths,
    log: runLog,
    events: eventLog,
    runState,
    epic: subIssues.length ? issue.number : null,
  };
  try {
    results.push(...(await mapConcurrently(tickets, settings.maxParallel, (ticket) => runTicket(ticket, context))));
  } finally {
    eventLog('run_end', {
      run: runId,
      tickets: results.map((result) => ({ ticket: result.ticket, outcome: result.outcome })),
      ...(runState.stop && { failureClass: runState.stop.failureClass }),
    });
  }
  return results;
}

async function runTicket(issue: github.Issue, context: admission.AdmissionContext): Promise<TicketResult> {
  const ticket = issue.number;
  // A Ticket still queued when the run stopped is never admitted.
  if (context.runState.stop) {
    context.log(`#${ticket} skipped: the run stopped on failure class ${context.runState.stop.failureClass}`);
    return { ticket, outcome: 'skipped' };
  }
  const fault = (err: unknown) => {
    const error = effectErrors.errorText(err);
    context.log(`#${ticket} ERROR ${error}`);
    return { ticket, outcome: 'fault', fault: true, error };
  };
  const { locks } = context.deps;
  // Every failure, the lock's included, becomes this Ticket's result, so mapConcurrently settles every worker before
  // run_end.
  let lock = null;
  let result;
  try {
    lock = await locks.tryAcquire(context.repo.gitCommonDir, `ticket-${ticket}`);
    if (!lock) return admission.skip({ context, issue }, `another process holds the ticket-${ticket} lock`);
    result = await admission.admit(issue, context);
  } catch (err) {
    result = fault(err);
  }
  try {
    if (lock) await locks.release(lock);
  } catch (err) {
    return fault(err);
  }
  return result;
}
