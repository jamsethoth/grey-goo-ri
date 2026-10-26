import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { commandProblems, configHash, EXAMPLES_DIR, layerPath, testPathsProblems } from './config.mjs';
import * as events from './events.mjs';
import { resolveFlow, writeResolved } from './flow.mjs';
import * as contract from './harnesses/contract.mjs';
import * as interpreter from './interpreter.mjs';
import * as locks from './locks.mjs';
import * as marker from './marker.mjs';
import { pathKey } from './paths.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';
import { publicTextFor } from './render.mjs';
import { has, labels } from './labels.mjs';

export const runExitCode = (results) =>
  results.some((r) => r.labelFailed || r.fault) ? 1 : results.some((r) => r.state === 'needs-human') ? 2 : 0;

export function epicProblem(tickets, ready) {
  if (!tickets.length) return 'epic has no sub-issues; nothing to run (publish a plan first)';
  if (!ready.length) return 'nothing ready: every sub-issue is closed, blocked or already in progress / ready-for-qa / needs-human';
  return null;
}

// Runs up to `limit` tasks at once; results keep the order of `items` (ported from feature-flow lib/run.mjs:17-27).
export async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

const STATE_OF = { done: 'ready-for-qa', 'needs-human': 'needs-human', replan: 'needs-replan', abandoned: 'needs-human' };
// Every orchestrator git write waits for the repo lock, so two gg processes on one repo serialise (request 3.5).
// writeTree writes objects and remoteSha fetches, so both count as writes.
const GIT_WRITES = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
// A write that waited for the lock runs `guard(verb, args, git)` once it holds it, with git unlocked: the guard may throw to
// stop the write, or return { skip: true } when the write's effect is already there (withGuard sets it).
export const lockedGit = (git, commonDir, guard = null) => ({ ...git,
  withGuard: (g) => lockedGit(git, commonDir, g),
  ...Object.fromEntries(GIT_WRITES.map((verb) => [verb, (...args) => locks.withLock(commonDir, 'repo', async ({ waited }) =>
    (waited && guard && (await guard(verb, args, git))?.skip ? undefined : git[verb](...args)), { timeoutMs: locks.REPO_LOCK_TIMEOUT_MS })])) });

const withExitCode = (message, exitCode) => Object.assign(new Error(message), { exitCode });

// Every active Vertex's Harness is checked by name before any GitHub access, all failures in one error. An unset Harness
// is a configuration gap, so any one makes the error exit 2.
async function preflight(flow, config, harnesses, repoRoot) {
  const failed = [...commandProblems(config.commands, layerPath(repoRoot)), ...testPathsProblems(config.testPaths, layerPath(repoRoot))];
  let unset = false;
  for (const [id, { agent }] of Object.entries(flow.ticket.vertices)) {
    if (agent.harness === null) {
      unset = true;
      failed.push(`vertex ${id}: no harness configured for agent ${config.flows[flow.name].ticket.vertices[id].use}`);
      continue;
    }
    const h = harnesses[agent.harness];
    try {
      if (!h) throw new Error(`unknown harness "${agent.harness}"`);
      // shortcut: the Claude and Codex modules are empty until slices 2 and 3; drop this when both implement the contract.
      if (!h.run) throw new Error('not implemented');
      contract.assertHarness(h);
      const { ok, errors } = await h.validate(agent);
      if (!ok) throw new Error(errors.join(', '));
      await h.resolveTools(agent);
    } catch (err) {
      failed.push(`vertex ${id}: harness ${agent.harness}: ${err.message.split('\n')[0]}`);
    }
  }
  if (unset) failed.push(`Merge ${join(EXAMPLES_DIR, 'claude.json')} or ${join(EXAMPLES_DIR, 'codex.json')} into the user Layer at ${layerPath(homedir())}.`);
  if (failed.length) throw withExitCode(`preflight failed:\n${failed.join('\n')}`, unset ? 2 : 1);
}

// Every line and error a Run prints names its repository on its first line, so two gg processes can share a terminal or a log.
export async function runTarget(opts) {
  const repo = await opts.git.repoInfo(opts.cwd);
  const named = (m) => `[${repo.name}] ${m}`;
  try {
    return await runRepo(repo, named, opts);
  } catch (err) {
    if (err instanceof Error) err.message = named(err.message);
    throw err;
  }
}

async function runRepo(repo, named, { target, config, harnesses, gh, git, integrity, testImmutability, exec, cwd, log, clock = interpreter.WALL_CLOCK }) {
  const flow = resolveFlow(config);
  const commands = config.commands ?? {};
  const pinned = { flow, personas: config.personas, harnesses: config.harnesses ?? {}, launchProfile: null, commands, testPaths: config.testPaths };
  const hash = configHash(pinned);
  await preflight(flow, config, harnesses, repo.mainRoot);

  const issue = await gh.viewIssue(target, repo.mainRoot);
  const subIssues = issue.subIssues?.nodes ?? issue.subIssues ?? [];
  let tickets = [issue];
  if (subIssues.length) {
    // Every sub-issue is read before the Run's first effect, so an epic with nothing ready leaves no trace.
    const children = await Promise.all(subIssues.map((s) => gh.viewIssue(s.number, repo.mainRoot)));
    tickets = children.filter((c) => gh.isReady(c, { prefix: config.labelPrefix }));
    const problem = epicProblem(children, tickets);
    if (problem) throw new Error(`#${target}: ${problem}`);
  } else if (flow.plan != null) {
    // shortcut: the advice edits the default Flow because gg run cannot select a Flow yet; once --flow lands (slice 5), name a null-plan Flow to pass with --flow instead.
    const repoLayer = layerPath(repo.mainRoot);
    const advice = JSON.stringify({ flows: { [flow.name]: { plan: null } } });
    throw new Error(`#${target} is a standalone Ticket, but Flow ${flow.name} has a plan section; set plan to null on Flow ${flow.name} by merging this JSON into the repo Layer at ${repoLayer}:\n${advice}`);
  }

  const runId = `${new Date(clock.now()).toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(3).toString('hex')}`;
  const runDir = join(repo.gitCommonDir, 'gg', 'runs', runId);
  writeResolved(runDir, flow, hash);
  record.saveConfig(repo.gitCommonDir, hash, JSON.stringify(pinned));
  const runLog = (msg) => {
    const line = named(msg);
    appendFileSync(join(runDir, 'run.log'), `${new Date().toISOString()} ${line}\n`);
    log(line);
  };
  const ev = events.eventLog(repo.gitCommonDir);
  ev('run_start', { run: runId });
  runLog(`run ${runId} started for #${target} under Flow ${flow.name} (config ${hash.slice(0, 12)})`);
  const results = [];
  let ensuredLabels;
  const runGh = { ...gh, setLabels: (n, change, cwd, hooks) => gh.setLabels(n, change, cwd, {
    ...hooks, ...(change.add?.length && { ensureLabels: () => ensuredLabels ??= gh.ensureLabels(repo.mainRoot, { prefix: config.labelPrefix }).catch((err) => {
      ensuredLabels = undefined;
      throw err;
    }) }),
  }) };
  // The first run stop of any Execution, which ends every other one before its next Action, and the cooldown every
  // remote Action of the Run waits for after any one of them backs off.
  const runState = { stop: null, remoteNotBefore: 0 };
  const ctx = { config, flow, hash, runId, repo, harnesses, gh: runGh, git: lockedGit(git, repo.gitCommonDir), integrity, testImmutability, exec, commands, testPaths: config.testPaths, log: runLog, ev,
    clock, runState, epic: subIssues.length ? issue.number : null };
  try {
    results.push(...await pool(tickets, config.maxParallel, (ticket) => runTicket(ticket, ctx)));
  } finally {
    ev('run_end', { run: runId, tickets: results.map((r) => ({ ticket: r.ticket, outcome: r.outcome })),
      ...(runState.stop && { failureClass: runState.stop.failureClass }) });
  }
  return results;
}

async function runTicket(issue, ctx) {
  const n = issue.number;
  // A Ticket still queued when the run stopped is never admitted.
  if (ctx.runState.stop) {
    ctx.log(`#${n} skipped: the run stopped on failure class ${ctx.runState.stop.failureClass}`);
    return { ticket: n, outcome: 'skipped' };
  }
  const fault = (err) => {
    const error = err.message ?? String(err);
    ctx.log(`#${n} ERROR ${error}`);
    return { ticket: n, outcome: 'fault', fault: true, error };
  };
  // Every failure, the lock's included, becomes this Ticket's result, so the pool settles every worker before run_end.
  let lock = null;
  let result;
  try {
    lock = await locks.tryAcquire(ctx.repo.gitCommonDir, `ticket-${n}`);
    if (!lock) {
      ctx.log(`#${n} skipped: another process holds the ticket-${n} lock`);
      return { ticket: n, outcome: 'skipped', ...(has(ctx.gh.labelNames(issue), labels(ctx.config.labelPrefix).state('needs-human')) && { state: 'needs-human' }) };
    }
    result = await admit(issue, ctx);
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

// A worktree on another Ticket's branch would carry this Ticket's commits, pushes and PR there, and a resumed one must be on
// exactly the recorded branch. Returns { hold, next } with the reason and what to do about it, or the worktree and a reader
// of every other ticket worktree, whose Integrity Assertions guard them against this Ticket's agent.
async function admitWorktree({ n, rec, git, mainRoot, path, branch, base }) {
  const prefix = `ticket/${n}-`;
  const wrong = (what, b) => `${what} ${b}, but Ticket #${n} requires \`${prefix}*\`, so the Ticket is held; no agent ran and nothing was committed, pushed or discarded.`;
  if (rec && !rec.branch.startsWith(prefix)) return { hold: wrong('The Execution Record names branch', `\`${rec.branch}\``) };
  if (existsSync(path)) {
    // A detached HEAD can equal the recorded commit during a rebase without owning its branch.
    const actual = await git.currentBranch(path);
    if (rec && actual !== rec.branch) {
      return { hold: `The worktree is on ${actual ?? 'detached HEAD'}, not the Execution Record's branch ${rec.branch}, so the Ticket is held; nothing was committed, pushed or discarded.`,
        next: `Switch the worktree back to \`${rec.branch}\` or remove it` };
    }
    if (!actual?.startsWith(prefix)) {
      return { hold: wrong('The worktree is on', actual === null ? 'detached HEAD' : `\`${actual}\``), next: `Switch the worktree back to a \`${prefix}*\` branch or remove it` };
    }
  }
  const wt = await git.ensureWorktree({ mainRoot, path, branch, base });
  // Read now so a list that cannot be read stops admission, and again for each Attempt: a parallel Ticket's worktree
  // may be created after this one is admitted.
  await otherWorktrees(git, mainRoot, wt.path);
  return { wt, others: () => otherWorktrees(git, mainRoot, wt.path) };
}

const otherWorktrees = async (git, mainRoot, own) => (await git.listWorktrees(mainRoot))
  .filter((w) => /^ticket\/\d+-/.test(w.branch) && pathKey(w.path) !== pathKey(own))
  .map((w) => w.path);

async function admit(issue, { config, flow, hash, runId, repo, harnesses, gh, git, integrity, testImmutability, exec, commands, testPaths, log, ev: runEv, clock, runState, epic }) {
  const n = issue.number;
  const cwd = repo.mainRoot;
  const recordLocation = relative(cwd, join(repo.gitCommonDir, 'gg', 'gg.db')).replaceAll('\\', '/');
  const state = labels(config.labelPrefix).state;
  const recovery = `Inspect the row first in the State Database at ${recordLocation} (relative to the main checkout) using a SQLite client. After preserving your changes, delete it with \`DELETE FROM records WHERE kind = 'ticket' AND n = ${n};\`, then remove the ${state('needs-human')} label and re-run gg run ${n}.`;
  const issueLabels = gh.labelNames(issue);
  let labelFailed = false;
  const ev = (type, data) => {
    if (type === 'label_failed') labelFailed = true;
    runEv(type, type === 'label_failed' ? { run: runId, ...data } : data);
  };
  const setLabels = (change) => gh.setLabels(n, change, cwd, { log, ev });
  let rec = await record.load(repo.gitCommonDir, 'ticket', n).catch((err) => {
    if (err instanceof record.RecordCorruptError) return err;
    throw err;
  });
  const corrupt = rec instanceof record.RecordCorruptError;
  const pending = rec && !corrupt && interpreter.pendingReport(rec);
  // A landed fresh hold restarts as a new Execution; readiness then judges whether a human has cleared it.
  if (rec?.state === 'held' && rec.terminalStop?.fresh && !pending) rec = null;
  const worktreeRoot = config.worktreeRoot.replace(/^~(?=$|[\\/])/, homedir());
  const path = rec?.worktree ?? git.worktreePath(worktreeRoot, repo.name, n);
  const redact = publicTextFor({ worktree: path, commonDir: repo.gitCommonDir, cwd });
  const branch = rec?.branch ?? `ticket/${n}-${git.slugify(redact(issue.title))}`;
  const skip = (reason) => {
    log(`#${n} skipped: ${reason}`);
    return { ticket: n, outcome: 'skipped', ...(has(issueLabels, state('needs-human')) && { state: 'needs-human' }) };
  };

  if (corrupt) {
    if (has(issueLabels, state('needs-human'))) return skip(`it is labelled ${state('needs-human')}`);
    const { reason } = await reconcile.reconcile({ record: rec, flow, git, gh, labelPrefix: config.labelPrefix, cwd });
    log(`#${n} hold: ${reason}`);
    // An unreadable row holds no intent, so the marker comes from the Ticket and the row itself: a comment that landed
    // before its label failed is found on the next Run, not posted again.
    const rowHash = createHash('sha256').update(rec.raw ?? rec.message).digest('hex').slice(0, 12);
    const m = marker.formatMarker({ execution: `${n}.corrupt`, vertex: 'needs-human', visit: 1, phase: 'hold', ordinal: 1, run: rowHash, attempt: 1 });
    if (!(await gh.issueComments(n, cwd)).some((c) => reconcile.carries(c.body, m))) {
      const text = redact(`### gg: needs-human\n\nExecution Record ticket-${n} could not be read, so no agent ran and the record was kept. ${recovery}\n`);
      await gh.commentIssue(n, `${text}\n${marker.markerComment(m)}\n`, cwd);
    }
    await setLabels({ add: [state('needs-human')], remove: [state('in-progress')] });
    return { ticket: n, outcome: 'needs-human', state: 'needs-human', held: true, labelFailed };
  }
  if (!pending) {
    // A finished record is never resumed, whatever intents its log leaves open (a fault report leaves one for good).
    // An Interrupted Attempt's warning comes before the recovery that deletes the row and its saved baseline.
    const warning = rec?.terminalReason?.decidedBy?.hold === 'interrupted-attempt' ? `${reconcile.INTERRUPTED_ADVICE} ` : '';
    if (rec?.state === 'held') return skip(`Execution Record ticket-${n} is held and cannot resume. ${warning}${recovery}`);
    if (rec && rec.state !== 'active') return skip(`its Execution Record is finished (${rec.state}); it is not resumed`);
    if (!rec && has(issueLabels, state('in-progress'))) return skip(`it is labelled ${state('in-progress')} with no Execution Record behind it`);
  }
  const fresh = !rec;
  // A held record cannot resume, so its recovery also deletes the row; a fresh hold has none to delete.
  const advise = (next) => (fresh ? `${next}, then remove the ${state('needs-human')} label and re-run gg run ${n}.`
    : `Execution Record ticket-${n} is held and cannot resume. ${next ? `${next}. ` : ''}${recovery}`);
  let started = false;
  // The record exists before admission's first GitHub effect, so whatever admission decides lands through its Terminal.
  // The record, its ticket_start and admission's decision commit together.
  const startTicket = async (wt, decision) => {
    if (started) return;
    rec ??= record.createExecution({ commonDir: repo.gitCommonDir, ticket: n, epic, flow: { name: flow.name, entry: flow.ticket.entry },
      configHash: hash, run: runId, worktree: wt?.path ?? path, branch: wt?.branch ?? branch, base: config.baseBranch });
    if (decision) rec.admission = decision;
    await record.save(rec, () => ev('ticket_start', { run: runId, execution: rec.execution, ticket: n }));
    started = true;
  };
  let admission;
  let fault;
  let others = [];
  // A decided hold, fault or abandonment that has not landed is finished first and admits no more work. Its ticket_start
  // landed with the Run that decided it.
  if (!pending) try {
    // A human's needs-human label is honoured before anything is discarded or labelled (request 3.5).
    const overridden = rec && await reconcile.humanOverride(rec, issueLabels, config.labelPrefix);
    let wt;
    if (overridden) {
      log(`#${n} abandon: ${overridden.reason}`);
      admission = { kind: 'abandon', ...overridden };
    } else {
      // A resumed record's State Label is Reconciliation's to judge, but it still needs an open, unblocked Ticket.
      const notReady = gh.readinessReason(rec ? { ...issue, labels: [] } : issue, { prefix: config.labelPrefix });
      if (notReady) return skip(`it is not ready: ${notReady}`);

      const admitted = await admitWorktree({ n, rec, git, mainRoot: cwd, path, branch, base: config.baseBranch });
      ({ wt, others = [] } = admitted);
      if (admitted.hold) {
        log(`#${n} hold: ${admitted.hold}`);
        admission = { kind: 'hold', name: 'branch-mismatch', text: admitted.hold, fresh, advice: advise(admitted.next) };
      }
      const held = wt && await reconcile.dirtyState(rec, { git, worktree: wt.path, integrity });
      if (held) {
        const found = held.conflicts.length ? 'The worktree has a merge conflict' : 'The worktree has uncommitted changes gg did not make';
        log(`#${n} hold: ${found}`);
        const next = held.conflicts.length ? 'Resolve and commit the conflicted paths in the worktree' : 'Commit, stash or remove these changes in the worktree';
        admission = { kind: 'hold', name: held.conflicts.length ? 'merge-conflict' : 'dirty-worktree', fresh,
          text: `${found}, so the Ticket is held, no agent ran and nothing was deleted.`,
          advice: advise(next),
          detail: (held.conflicts.length ? `Conflicted paths:\n${held.conflicts.join('\n')}\n\n` : '') + held.stat };
      }
    }
    await startTicket(wt, admission);
    if (!admission && !has(issueLabels, state('in-progress'))) await setLabels({ add: [state('in-progress')] });
  } catch (err) {
    if (err instanceof record.RecordSaveError) throw err;
    // An Execution that cannot be admitted is an unexpected fault: reported and marked, so it is never retried
    // automatically (request 3.4).
    log(`#${n} ERROR ${err.message ?? String(err)}`);
    fault = err;
    await startTicket(undefined, { kind: 'fault', error: err.message ?? String(err) });
  }

  const result = await interpreter.runExecution({
    flow, record: rec, harnesses, run: runId, gh, git, integrity, testImmutability, exec, events: ev, log, cwd, commands, testPaths,
    ticket: { number: n, title: issue.title, body: issue.body, branch: rec.branch }, base: config.baseBranch, labelPrefix: config.labelPrefix,
    others, clock, fault, admission, runState,
  });
  return { ticket: n, outcome: result.outcome, state: STATE_OF[result.outcome], labelFailed,
    ...(result.fault && { fault: true, error: result.error ?? rec.terminalStop?.error }) };
}
