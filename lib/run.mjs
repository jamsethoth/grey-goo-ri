import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configHash, loadCommands } from './config.mjs';
import * as events from './events.mjs';
import { resolveFlow, writeResolved } from './flow.mjs';
import * as contract from './harnesses/contract.mjs';
import * as integrity from './integrity.mjs';
import * as interpreter from './interpreter.mjs';
import * as locks from './locks.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';
import { fence } from './render.mjs';
import { labels } from './labels.mjs';

export const runExitCode = (results) =>
  results.some((r) => r.labelFailed || r.fault) ? 1 : results.some((r) => r.state === 'needs-human') ? 2 : 0;

export function epicProblem(tickets, ready) {
  if (!tickets.length) return 'epic has no sub-issues; nothing to run (publish a plan first)';
  if (!ready.length) return 'nothing ready: every sub-issue is closed, blocked or already in progress / ready-for-qa / needs-human';
  return null;
}

const STATE_OF = { done: 'ready-for-qa', 'needs-human': 'needs-human', replan: 'needs-replan', abandoned: 'abandoned' };
// Every orchestrator git write waits for the repo lock, so two gg processes on one repo serialise (request 3.5).
// writeTree writes objects and remoteSha fetches, so both count as writes.
const GIT_WRITES = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
export const lockedGit = (git, commonDir) => ({ ...git,
  ...Object.fromEntries(GIT_WRITES.map((verb) => [verb, (...args) => locks.withLock(commonDir, 'repo', () => git[verb](...args))])) });

const withExitCode = (message, exitCode) => Object.assign(new Error(message), { exitCode });

// Every active Vertex's Harness is checked by name before any GitHub access, all failures in one error.
async function preflight(flow, config, harnesses, commands) {
  const unset = Object.entries(flow.ticket.vertices).filter(([, v]) => v.node.harness === null).map(([id]) =>
    `vertex ${id}: no harness configured for node ${config.flows[flow.name].ticket.vertices[id].use}; copy examples/claude.json or examples/codex.json into a user Layer`);
  if (unset.length) throw withExitCode(unset.join('\n'), 2);
  const failed = commands.test ? [] : ['AGENTS.md has no "## Commands" entry for test'];
  for (const [id, { node }] of Object.entries(flow.ticket.vertices)) {
    const h = harnesses[node.harness];
    try {
      if (!h) throw new Error(`unknown harness "${node.harness}"`);
      // shortcut: the Claude and Codex modules are empty until slices 2 and 3; drop this when both implement the contract.
      if (!h.run) throw new Error(`harness ${node.harness}: not implemented`);
      contract.assertHarness(h);
      const { ok, errors } = await h.validate(node);
      if (!ok) throw new Error(errors.join(', '));
      await h.resolveTools(node);
    } catch (err) {
      failed.push(`vertex ${id} (harness ${node.harness}): ${err.message.split('\n')[0]}`);
    }
  }
  if (failed.length) throw withExitCode(`preflight failed: ${failed.join('; ')}`, 1);
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
  if (flow.plan !== null) {
    throw new Error(`#${target} is a standalone Ticket, but Flow ${flow.name} has a plan section; run it under a Flow that sets plan to null`);
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
  try {
    results.push(await runTicket(issue, { config, flow, hash, runId, repo, harnesses, gh, git: lockedGit(git, repo.gitCommonDir), exec,
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
    return { ticket: n, outcome: 'skipped' };
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

async function admit(issue, { config, flow, hash, runId, repo, harnesses, gh, git, exec, commands, log, ev: runEv, clock }) {
  const n = issue.number;
  const cwd = repo.mainRoot;
  const state = labels(config.labelPrefix).state;
  const issueLabels = gh.labelNames(issue);
  let labelFailed = false;
  const ev = (type, data) => {
    if (type === 'label_failed') labelFailed = true;
    runEv(type, type === 'label_failed' ? { run: runId, ...data } : data);
  };
  const setLabels = (change) => gh.setLabels(n, change, cwd, { log, ev });
  const holdTicket = async (text, detail) => {
    await gh.commentIssue(n, `### gg: needs-human\n\n${text}\n${detail ? `\n${fence(detail)}\n` : ''}`, cwd);
    await setLabels({ add: [state('needs-human')], remove: [state('in-progress')] });
    return { ticket: n, outcome: 'needs-human', state: 'needs-human', held: true, labelFailed };
  };
  const skip = (reason) => {
    log(`#${n} skipped: ${reason}`);
    return { ticket: n, outcome: 'skipped' };
  };

  let rec = await record.load(repo.gitCommonDir, 'ticket', n).catch((err) => {
    if (err instanceof record.RecordCorruptError) return err;
    throw err;
  });
  if (rec instanceof record.RecordCorruptError) {
    const { reason } = await reconcile.reconcile({ record: rec, flow, git, gh, labelPrefix: config.labelPrefix, cwd });
    log(`#${n} hold: ${reason}`);
    return holdTicket(`The Execution Record could not be read, so no agent ran. ${reason}`);
  }
  // A finished record is never resumed, whatever intents its log leaves open (a fault report leaves one for good).
  if (rec && rec.state !== 'active') return skip(`its Execution Record is finished (${rec.state}); it is not resumed`);
  if (!rec && issueLabels.includes(state('in-progress'))) return skip(`it is labelled ${state('in-progress')} with no Execution Record behind it`);
  // A resumed record's State Label is Reconciliation's to judge, but it still needs an open, unblocked Ticket.
  if (!gh.isReady(rec ? { ...issue, labels: [] } : issue, { prefix: config.labelPrefix })) return skip('it is not ready: closed, blocked or carrying a State Label');

  const worktreeRoot = config.worktreeRoot.replace(/^~(?=$|[\\/])/, homedir());
  const path = rec?.worktree ?? git.worktreePath(worktreeRoot, repo.name, n);
  const wt = await git.ensureWorktree({ mainRoot: cwd, path, branch: rec?.branch ?? `ticket/${n}-${git.slugify(issue.title)}`, base: config.baseBranch });

  if (!await integrity.isCleanAt(wt.path, 'HEAD')) {
    // Only an open reset intent whose saved worktree still matches proves the changes are the agent's: anything a human
    // changed since makes it unknown dirty state (ADR 0005).
    const { payload } = (rec ? record.openIntents(rec).filter((e) => e.action === 'reset') : []).at(-1) ?? {};
    const now = payload?.left && await integrity.snapshot(wt.path);
    if (now && now.head === payload.left.head && now.tree === payload.left.tree) {
      await git.resetTo(wt.path, payload.baseline);
      if (payload.untracked) await integrity.restoreUntracked(wt.path, payload.untracked);
      log(`#${n} discarded the changes its record proves the agent made`);
    } else {
      const stat = (await git.runGit(['diff', '--stat', 'HEAD'], { cwd: wt.path })).stdout
        + (await git.runGit(['ls-files', '--others', '--exclude-standard'], { cwd: wt.path })).stdout.split('\n').filter(Boolean).map((p) => ` ${p} (untracked)\n`).join('');
      if (rec) {
        rec.state = 'held';
        await record.save(rec);
      }
      log(`#${n} hold: the worktree has uncommitted changes gg did not make`);
      return holdTicket('The worktree has uncommitted changes gg did not make, so the Ticket is held, no agent ran and nothing was deleted.', stat);
    }
  }

  if (!rec) {
    rec = record.createExecution({ commonDir: repo.gitCommonDir, ticket: n, epic: null, flow: { name: flow.name, entry: flow.ticket.entry },
      configHash: hash, run: runId, worktree: wt.path, branch: wt.branch, base: config.baseBranch });
    await record.save(rec);
  }
  if (!issueLabels.includes(state('in-progress'))) await setLabels({ add: [state('in-progress')] });
  ev('ticket_start', { run: runId, execution: rec.execution, ticket: n });

  const result = await interpreter.runExecution({
    flow, record: rec, harnesses, run: runId, gh, git, exec, events: ev, log, cwd, commands,
    ticket: { number: n, title: issue.title, body: issue.body, branch: rec.branch }, base: config.baseBranch, labelPrefix: config.labelPrefix,
    others: [], clock,
  });
  return { ticket: n, outcome: result.outcome, state: STATE_OF[result.outcome], labelFailed,
    ...(result.fault && { fault: true, error: rec.terminalStop?.error }) };
}
