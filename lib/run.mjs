import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { configHash, EXAMPLES_DIR, layerPath, loadCommands } from './config.mjs';
import * as events from './events.mjs';
import { resolveFlow, writeResolved } from './flow.mjs';
import * as contract from './harnesses/contract.mjs';
import * as interpreter from './interpreter.mjs';
import * as locks from './locks.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';
import { publicTextFor } from './render.mjs';
import { labels } from './labels.mjs';

export const runExitCode = (results) =>
  results.some((r) => r.labelFailed || r.fault) ? 1 : results.some((r) => r.state === 'needs-human') ? 2 : 0;

export function epicProblem(tickets, ready) {
  if (!tickets.length) return 'epic has no sub-issues; nothing to run (publish a plan first)';
  if (!ready.length) return 'nothing ready: every sub-issue is closed, blocked or already in progress / ready-for-qa / needs-human';
  return null;
}

const STATE_OF = { done: 'ready-for-qa', 'needs-human': 'needs-human', replan: 'needs-replan', abandoned: 'needs-human' };
// Every orchestrator git write waits for the repo lock, so two gg processes on one repo serialise (request 3.5).
// writeTree writes objects and remoteSha fetches, so both count as writes.
const GIT_WRITES = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
export const lockedGit = (git, commonDir) => ({ ...git,
  ...Object.fromEntries(GIT_WRITES.map((verb) => [verb, (...args) => locks.withLock(commonDir, 'repo', () => git[verb](...args))])) });

const withExitCode = (message, exitCode) => Object.assign(new Error(message), { exitCode });

// Every active Vertex's Harness is checked by name before any GitHub access, all failures in one error. An unset Harness
// is a configuration gap, so any one makes the error exit 2.
async function preflight(flow, config, harnesses, commands) {
  const failed = commands.test ? [] : ['AGENTS.md has no "## Commands" entry for test'];
  let unset = false;
  for (const [id, { node }] of Object.entries(flow.ticket.vertices)) {
    if (node.harness === null) {
      unset = true;
      failed.push(`vertex ${id}: no harness configured for node ${config.flows[flow.name].ticket.vertices[id].use}`);
      continue;
    }
    const h = harnesses[node.harness];
    try {
      if (!h) throw new Error(`unknown harness "${node.harness}"`);
      // shortcut: the Claude and Codex modules are empty until slices 2 and 3; drop this when both implement the contract.
      if (!h.run) throw new Error('not implemented');
      contract.assertHarness(h);
      const { ok, errors } = await h.validate(node);
      if (!ok) throw new Error(errors.join(', '));
      await h.resolveTools(node);
    } catch (err) {
      failed.push(`vertex ${id}: harness ${node.harness}: ${err.message.split('\n')[0]}`);
    }
  }
  if (unset) failed.push(`Merge ${join(EXAMPLES_DIR, 'claude.json')} or ${join(EXAMPLES_DIR, 'codex.json')} into the user Layer at ${layerPath(homedir())}.`);
  if (failed.length) throw withExitCode(`preflight failed:\n${failed.join('\n')}`, unset ? 2 : 1);
}

export async function runTarget({ target, config, harnesses, gh, git, exec, cwd, log, clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } }) {
  const repo = await git.repoInfo(cwd);
  const flow = resolveFlow(config);
  const commands = loadCommands(repo.mainRoot);
  const pinned = { flow, personas: config.personas, harnesses: config.harnesses ?? {}, launchProfile: null, commands };
  const hash = configHash(pinned);
  await preflight(flow, config, harnesses, commands);

  const issue = await gh.viewIssue(target, repo.mainRoot);
  // shortcut: an Epic target arrives with the pool (T21); until then only a standalone Ticket runs.
  if ((issue.subIssues?.nodes ?? issue.subIssues ?? []).length) throw new Error(`#${target} is an Epic; running an Epic is not supported yet`);
  // shortcut: the advice edits the default Flow because gg run cannot select a Flow yet; once --flow lands (slice 5), name a null-plan Flow to pass with --flow instead.
  if (flow.plan != null) {
    const repoLayer = layerPath(repo.mainRoot);
    const advice = JSON.stringify({ flows: { [flow.name]: { plan: null } } });
    throw new Error(`#${target} is a standalone Ticket, but Flow ${flow.name} has a plan section; set plan to null on Flow ${flow.name} by merging this JSON into the repo Layer at ${repoLayer}:\n${advice}`);
  }

  const runId = `${new Date(clock.now()).toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(3).toString('hex')}`;
  const runDir = join(repo.gitCommonDir, 'gg', 'runs', runId);
  writeResolved(runDir, flow, hash);
  record.saveConfig(repo.gitCommonDir, hash, JSON.stringify(pinned));
  const runLog = (msg) => {
    appendFileSync(join(runDir, 'run.log'), `${new Date().toISOString()} ${msg}\n`);
    log(msg);
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
  try {
    results.push(await runTicket(issue, { config, flow, hash, runId, repo, harnesses, gh: runGh, git: lockedGit(git, repo.gitCommonDir), exec,
      commands, log: runLog, ev, clock }));
  } finally {
    ev('run_end', { run: runId, tickets: results.map((r) => ({ ticket: r.ticket, outcome: r.outcome })) });
  }
  return results;
}

async function runTicket(issue, ctx) {
  const n = issue.number;
  const lock = await locks.tryAcquire(ctx.repo.gitCommonDir, `ticket-${n}`);
  if (!lock) {
    ctx.log(`#${n} skipped: another process holds the ticket-${n} lock`);
    return { ticket: n, outcome: 'skipped', ...(ctx.gh.labelNames(issue).includes(labels(ctx.config.labelPrefix).state('needs-human')) && { state: 'needs-human' }) };
  }
  try {
    return await admit(issue, ctx);
  } catch (err) {
    const error = err.message ?? String(err);
    ctx.log(`#${n} ERROR ${error}`);
    return { ticket: n, outcome: 'fault', fault: true, error };
  } finally {
    await locks.release(lock);
  }
}

// Windows paths are case-insensitive, so the own worktree must not count as a sibling because of how a path was cased.
const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

// A worktree on another Ticket's branch would carry this Ticket's commits, pushes and PR there, and a resumed one must be on
// exactly the recorded branch. Returns { hold } with the reason, or the worktree and every other ticket worktree, whose
// Integrity Assertions guard them against this Ticket's agent.
async function admitWorktree({ n, rec, git, mainRoot, path, branch, base }) {
  const prefix = `ticket/${n}-`;
  const wrong = (what, b) => `${what} \`${b}\`, but Ticket #${n} requires \`${prefix}*\`, so the Ticket is held; no agent ran and nothing was committed, pushed or discarded.`;
  if (rec && !rec.branch.startsWith(prefix)) return { hold: wrong('The Execution Record names branch', rec.branch) };
  if (existsSync(path)) {
    // A detached HEAD can equal the recorded commit during a rebase without owning its branch.
    const current = await git.runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: path, allowFail: true });
    if (current.code !== 0 && current.code !== 1) throw new Error(current.stderr.trim() || `git symbolic-ref exited ${current.code}`);
    const actual = current.code === 1 ? 'detached HEAD' : current.stdout.trim().replace(/^refs\/heads\//, '');
    if (rec && actual !== rec.branch) {
      return { hold: `The worktree is on ${actual}, not the Execution Record's branch ${rec.branch}, so the Ticket is held; nothing was committed, pushed or discarded.` };
    }
    if (!actual.startsWith(prefix)) return { hold: wrong('The worktree is on', actual) };
  }
  const wt = await git.ensureWorktree({ mainRoot, path, branch, base });
  const others = (await git.listWorktrees(mainRoot))
    .filter((w) => /^ticket\/\d+-/.test(w.branch) && pathKey(w.path) !== pathKey(wt.path))
    .map((w) => w.path);
  return { wt, others };
}

async function admit(issue, { config, flow, hash, runId, repo, harnesses, gh, git, exec, commands, log, ev: runEv, clock }) {
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
    return { ticket: n, outcome: 'skipped', ...(issueLabels.includes(state('needs-human')) && { state: 'needs-human' }) };
  };

  if (corrupt) {
    if (issueLabels.includes(state('needs-human'))) return skip(`it is labelled ${state('needs-human')}`);
    const { reason } = await reconcile.reconcile({ record: rec, flow, git, gh, labelPrefix: config.labelPrefix, cwd });
    log(`#${n} hold: ${reason}`);
    // shortcut: a corrupt record's hold is not write-ahead (no readable row to mark), upgrade if duplicate corrupt-record comments are seen
    await gh.commentIssue(n, redact(`### gg: needs-human\n\nExecution Record ticket-${n} could not be read, so no agent ran and the record was kept. ${recovery}\n`), cwd);
    await setLabels({ add: [state('needs-human')], remove: [state('in-progress')] });
    return { ticket: n, outcome: 'needs-human', state: 'needs-human', held: true, labelFailed };
  }
  if (!pending) {
    // A finished record is never resumed, whatever intents its log leaves open (a fault report leaves one for good).
    if (rec?.state === 'held') return skip(`Execution Record ticket-${n} is held and cannot resume. ${recovery}`);
    if (rec && rec.state !== 'active') return skip(`its Execution Record is finished (${rec.state}); it is not resumed`);
    if (!rec && issueLabels.includes(state('in-progress'))) return skip(`it is labelled ${state('in-progress')} with no Execution Record behind it`);
  }
  const fresh = !rec;
  let started = false;
  // The record exists before admission's first GitHub effect, so whatever admission decides lands through its Terminal.
  const startTicket = async (wt) => {
    if (!rec) {
      rec = record.createExecution({ commonDir: repo.gitCommonDir, ticket: n, epic: null, flow: { name: flow.name, entry: flow.ticket.entry },
        configHash: hash, run: runId, worktree: wt?.path ?? path, branch: wt?.branch ?? branch, base: config.baseBranch });
      await record.save(rec);
    }
    if (!started) ev('ticket_start', { run: runId, execution: rec.execution, ticket: n });
    started = true;
  };
  let admission;
  let fault;
  let others = [];
  // A decided hold, fault or abandonment that has not landed is finished first and admits no more work.
  if (pending) await startTicket();
  else try {
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
        admission = { kind: 'hold', name: 'branch-mismatch', text: admitted.hold, fresh };
      }
      const held = wt && await reconcile.dirtyState(rec, { git, worktree: wt.path });
      if (held) {
        const found = held.conflicts.length ? 'The worktree has a merge conflict' : 'The worktree has uncommitted changes gg did not make';
        log(`#${n} hold: ${found}`);
        const next = held.conflicts.length ? 'Resolve and commit the conflicted paths in the worktree' : 'Commit, stash or remove these changes in the worktree';
        const restart = fresh ? ` ${next}, then remove the ${state('needs-human')} label and re-run gg run ${n}.`
          : ` Execution Record ticket-${n} is held and cannot resume. ${next}. ${recovery}`;
        admission = { kind: 'hold', name: held.conflicts.length ? 'merge-conflict' : 'dirty-worktree', fresh,
          text: `${found}, so the Ticket is held, no agent ran and nothing was deleted.${restart}`,
          detail: (held.conflicts.length ? `Conflicted paths:\n${held.conflicts.join('\n')}\n\n` : '') + held.stat };
      }
    }
    await startTicket(wt);
    if (!admission && !issueLabels.includes(state('in-progress'))) await setLabels({ add: [state('in-progress')] });
  } catch (err) {
    // An Execution that cannot be admitted is an unexpected fault: reported and marked, so it is never retried
    // automatically (request 3.4).
    log(`#${n} ERROR ${err.message ?? String(err)}`);
    fault = err;
    await startTicket();
  }

  const result = await interpreter.runExecution({
    flow, record: rec, harnesses, run: runId, gh, git, exec, events: ev, log, cwd, commands,
    ticket: { number: n, title: issue.title, body: issue.body, branch: rec.branch }, base: config.baseBranch, labelPrefix: config.labelPrefix,
    others, clock, fault, admission,
  });
  return { ticket: n, outcome: result.outcome, state: STATE_OF[result.outcome], labelFailed,
    ...(result.fault && { fault: true, error: result.error ?? rec.terminalStop?.error }) };
}
