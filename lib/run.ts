import { randomBytes } from 'node:crypto';
import { appendFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as admission from './admission.ts';
import * as config from './config.ts';
import * as events from './events.ts';
import * as flowModule from './flow.ts';
import type * as github from './github.ts';
import * as contract from './harnesses/contract.ts';
import * as interpreter from './interpreter.ts';
import * as labels from './labels.ts';
import * as locksModule from './locks.ts';
import * as record from './record.ts';
import type * as runContext from './run-context.ts';
import type * as report from './validate/report.ts';
import * as stateDatabase from './state-database.ts';
import * as validator from './validate/index.ts';

type TicketResult = admission.TicketResult;

export const runExitCode = (results: TicketResult[]): number => {
  if (results.some((result) => result.labelFailed || result.fault)) return 1;
  return results.some((result) => result.state === labels.NEEDS_HUMAN) ? 2 : 0;
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

const withExitCode = (message: string, exitCode: number) => Object.assign(new Error(message), { exitCode });

// A Harness module as preflight checks it: the shipped modules declare only their paths until slices 2 and 3.
interface PreflightHarness {
  run?: unknown;
  validate(agent: unknown): Promise<{ ok: boolean; errors: string[] }>;
  resolveTools(agent: unknown): Promise<unknown>;
}

// Each active Vertex's registered Harness, checked by name before any GitHub access.
async function harnessProblems(flow: runContext.RunFlow | undefined, harnesses: Record<string, unknown>) {
  const failed: string[] = [];
  for (const [id, { agent }] of Object.entries(flow?.ticket.vertices ?? {})) {
    const harness =
      agent && typeof agent.harness === 'string' && Object.hasOwn(harnesses, agent.harness)
        ? (harnesses[agent.harness] as PreflightHarness)
        : null;
    // A Vertex without an Agent (publish) runs on no Harness; an unset or unregistered one is the validator's error.
    if (!harness) continue;
    try {
      // shortcut: the shipped Harness modules declare only their paths until slices 2 and 3; drop this when each
      // implements the contract.
      if (!harness.run) throw new Error('not implemented');
      contract.assertHarness(harness);
      const { ok, errors } = await harness.validate(agent);
      if (!ok) throw new Error(errors.join(', '));
      await harness.resolveTools(agent);
    } catch (err) {
      failed.push(`vertex ${id}: harness ${agent!.harness}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return failed;
}

// The configuration's errors, as gg doctor prints them (V1), and every active Vertex's registered Harness, all failures
// in one error. An unset Harness is a configuration gap, so any one makes the error exit 2.
async function preflight(
  flow: runContext.RunFlow | undefined,
  errors: report.Problem[],
  layers: config.Config,
  { harnesses, repoRoot }: { harnesses: Record<string, unknown>; repoRoot: string },
) {
  const failed = [
    ...config.commandProblems(layers.commands, config.layerPath(repoRoot)),
    ...config.testPathsProblems(layers.testPaths, config.layerPath(repoRoot)),
    ...errors.map((error) => `error: ${error.at}: ${error.message}`),
  ];
  const unset = errors.some((error) => error.code === 'harness-unset');
  failed.push(...(await harnessProblems(flow, harnesses)));
  if (unset) {
    const examples = readdirSync(config.EXAMPLES_DIRECTORY)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => join(config.EXAMPLES_DIRECTORY, file));
    failed.push(`Merge one of ${examples.join(', ')} into the user Layer at ${config.layerPath(homedir())}.`);
  }
  if (failed.length) throw withExitCode(`preflight failed:\n${failed.join('\n')}`, unset ? 2 : 1);
}

// What gg run takes: the Ticket or Epic, the merged Layers, the registered Harnesses, the deps it reaches outside its
// process (ADR 0019), and where it runs and logs.
export interface RunOptions {
  deps: runContext.Deps;
  target: number;
  config: config.Config;
  harnesses: Record<string, unknown>;
  protectedPaths: string[];
  cwd: string;
  log: (line: string) => void;
  testImmutability?: runContext.TestImmutability;
}

// Every line and error a Run prints names its repository on its first line, so two gg processes can share a terminal or
// a log.
export async function runTarget(options: RunOptions): Promise<TicketResult[]> {
  const repo = await options.deps.git.repoInfo(options.cwd);
  const named = (message: string) => `[${repo.name}] ${message}`;
  try {
    return await runRepo(repo, named, options);
  } catch (err) {
    if (err instanceof Error) err.message = named(err.message);
    throw err;
  }
}

// Admission runs the validator gg doctor runs, so gg run rejects exactly what gg doctor rejects (V1, ADR 0014). The
// Pinned Configuration is the Flow it gives with the files, Harnesses and commands it ran under.
async function admitConfiguration(layers: config.Config, harnesses: Record<string, unknown>, repo: admission.Repo) {
  const { flows, errors, warnings } = validator.validate(layers, {
    harnesses,
    readSchema: (name) => JSON.parse(config.layerFile(layers.files, name)),
    readTemplate: (name) => config.layerFile(layers.files, name),
  });
  // shortcut: gg run runs the Flow named default until --flow selects one (#122).
  const flow = (flows as Record<string, unknown>).default as runContext.RunFlow;
  await preflight(flow, errors, layers, { harnesses, repoRoot: repo.mainRoot });
  const commands = (layers.commands ?? {}) as Record<string, unknown>;
  const pinned = {
    flow,
    files: layers.files,
    harnesses: layers.harnesses ?? {},
    launchProfile: null,
    commands,
    testPaths: layers.testPaths,
  };
  return { flow, warnings, commands, pinned, hash: config.configHash(pinned) };
}

// The Ticket, or an Epic's ready sub-issues. Every sub-issue is read before the Run's first effect, so an epic with
// nothing ready leaves no trace.
async function readTickets(gh: github.Gh, target: number, repo: admission.Repo, layers: config.Config) {
  const issue = await gh.viewIssue(target, repo.mainRoot);
  // gh gives an issue's sub-issues as a list, or as a connection with its list under `nodes`.
  const declared = issue.subIssues as ({ nodes?: { number: number }[] } & { number: number }[]) | undefined;
  const subIssues = declared?.nodes ?? declared ?? [];
  if (!subIssues.length) return { issue, subIssues, tickets: [issue] };
  const children = await Promise.all(subIssues.map((sub) => gh.viewIssue(sub.number, repo.mainRoot)));
  const tickets = children.filter((child) => gh.isReady(child, { prefix: layers.labelPrefix }));
  const problem = epicProblem(children, tickets);
  if (problem) throw new Error(`#${target}: ${problem}`);
  return { issue, subIssues, tickets };
}

// The gh a Run's Tickets share: a label update that adds a label first creates gg's State Labels, once per Run, and
// again after a failed attempt.
function labelEnsuringGh(gh: github.Gh, repo: admission.Repo, layers: config.Config): github.Gh {
  let ensuredLabels: Promise<void> | undefined;
  return {
    ...gh,
    setLabels: (issue, change, cwd, report) =>
      gh.setLabels(issue, change, cwd, {
        ...report,
        ...(change.add?.length && {
          ensureLabels: () =>
            (ensuredLabels ??= gh.ensureLabels(repo.mainRoot, { prefix: layers.labelPrefix }).catch((err) => {
              ensuredLabels = undefined;
              throw err;
            })),
        }),
      }),
  };
}

// The Run's directory, Pinned Configuration and log: each line goes to the run log and the caller's log, named.
function startRun(
  repo: admission.Repo,
  { flow, hash, pinned, clock }: { flow: runContext.RunFlow; hash: string; pinned: unknown; clock: runContext.Clock },
  { named, log }: { named: (message: string) => string; log: (line: string) => void },
) {
  const runId = `${new Date(clock.now()).toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(3).toString('hex')}`;
  const runDir = join(repo.gitCommonDir, 'gg', 'runs', runId);
  flowModule.writeResolved(runDir, flow, hash);
  stateDatabase.savePinnedConfiguration(repo.gitCommonDir, hash, JSON.stringify(pinned));
  const runLog = (message: string) => {
    const line = named(message);
    appendFileSync(join(runDir, 'run.log'), `${new Date().toISOString()} ${line}\n`);
    log(line);
  };
  return { runId, runLog };
}

async function runRepo(repo: admission.Repo, named: (message: string) => string, options: RunOptions) {
  const { target, config: layers, harnesses, protectedPaths, testImmutability, deps, log } = options;
  const { gh, git, exec, integrity, locks = locksModule, database = record, clock = interpreter.WALL_CLOCK } = deps;
  const { flow, warnings, commands, pinned, hash } = await admitConfiguration(layers, harnesses, repo);
  const { issue, subIssues, tickets } = await readTickets(gh, target, repo, layers);
  const { runId, runLog } = startRun(repo, { flow, hash, pinned, clock }, { named, log });
  const eventLog = events.eventLog(repo.gitCommonDir, {}, database);
  eventLog('run_start', { run: runId });
  runLog(`run ${runId} started for #${target} under Flow ${flow.name} (config ${hash.slice(0, 12)})`);
  for (const warning of warnings) runLog(`warning: ${warning.at}: ${warning.message}`);
  const results: TicketResult[] = [];
  // The first run stop of any Execution, which ends every other one before its next Action, and the cooldown every
  // remote Action of the Run waits for after any one of them backs off.
  const runState = { stop: null, remoteNotBefore: 0 } as runContext.ExecutionOptions['runState'] & {
    stop: { failureClass: string } | null;
  };
  const context: admission.AdmissionContext = {
    config: layers,
    flow,
    hash,
    runId,
    repo,
    harnesses,
    protectedPaths,
    deps: {
      gh: labelEnsuringGh(gh, repo, layers),
      git: lockedGit(git, repo.gitCommonDir, { locks }),
      exec,
      locks,
      database,
      clock,
      integrity,
    },
    testImmutability,
    commands,
    testPaths: layers.testPaths as string[] | undefined,
    log: runLog,
    events: eventLog,
    runState,
    epic: subIssues.length ? issue.number : null,
  };
  try {
    results.push(...(await mapConcurrently(tickets, layers.maxParallel, (ticket) => runTicket(ticket, context))));
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
    const error = (err as Error).message ?? String(err);
    context.log(`#${ticket} ERROR ${error}`);
    return { ticket, outcome: 'fault', fault: true, error };
  };
  const { gh, locks } = context.deps;
  // Every failure, the lock's included, becomes this Ticket's result, so mapConcurrently settles every worker before
  // run_end.
  let lock = null;
  let result;
  try {
    lock = await locks.tryAcquire(context.repo.gitCommonDir, `ticket-${ticket}`);
    if (!lock) {
      context.log(`#${ticket} skipped: another process holds the ticket-${ticket} lock`);
      const needsHuman = labels.labelsFor(context.config.labelPrefix).state(labels.NEEDS_HUMAN);
      return {
        ticket,
        outcome: 'skipped',
        ...(labels.hasLabel(gh.labelNames(issue), needsHuman) && { state: labels.NEEDS_HUMAN }),
      };
    }
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
