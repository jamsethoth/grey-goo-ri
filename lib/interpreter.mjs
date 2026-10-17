import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { PERSONAS_DIR } from './config.mjs';
import * as briefs from './briefs.mjs';
import * as checks from './checks.mjs';
import * as events from './events.mjs';
import * as integrity from './integrity.mjs';
import * as marker from './marker.mjs';
import * as outcome from './outcome.mjs';
import * as procedures from './procedures.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';
import * as render from './render.mjs';
import { labels } from './labels.mjs';

const TERMINALS = ['done', 'needs-human', 'replan'];
export const PROTECTED_PATHS = ['.agents/', '.claude/', '.codex/', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];
// The green Action runs the declared `test` command, so its failure is gate-failed(test).
const CHECK_NAMES = { red: 'red', green: 'test' };
const CHECK_TITLES = { red: 'the Red Check', green: 'the Green Check' };

const STOP_CLAIMS = ['blocked', 'misscoped'];
// The conditions of the Procedures' conditional Actions, read from the Check runs of this Visit.
const WHEN = {
  'red run passed': (state) => state.runs.red?.code === 0,
  'green run failed': (state) => state.runs.green?.passed === false && !state.relaxed.green,
};
// A failing Check is retried only through a recovery Phase that runs next; otherwise the Procedure has exhausted it.
const recovers = (state) => !!WHEN[state.next?.when]?.(state);

// Where an Outcome leaves the pinned Vertex: a bounded Edge counts traversals per Execution in record.traversals and,
// once `max` is reached, routes to its `exhausted` target instead. Built-in defaults: misscoped to replan, else needs-human.
function edge(rec, out) {
  const { vertex, then, route } = rec.snapshot;
  const target = (out === 'ok' && then) || route?.[out] || (out === 'misscoped' ? 'replan' : 'needs-human');
  if (typeof target === 'string') return { next: target };
  const key = `${vertex}->${target.to}:${out}`;
  const count = rec.traversals[key] ?? 0;
  return count < target.max ? { next: target.to, key, count: count + 1 } : { next: target.exhausted, exhausted: true, target };
}

// Takes the Edge; the count is saved with the next Vertex's entry, before it runs, so a restart routes the same way.
function traverse(rec, out) {
  const e = edge(rec, out);
  if (e.key) rec.traversals[e.key] = e.count;
  return e;
}

const rollbackSet = (baseline) => integrity.rollbackSet(baseline, PROTECTED_PATHS, checks.TEST_PATHSPECS);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Test-only crash injection (T18): rethrown untouched, so the record is left exactly as the crash found it.
export class CrashError extends Error {
  name = 'CrashError';
}

// A failed red Phase or an Integrity Violation leaves nothing behind and tells the next Brief why. Rollback is limited
// to what this Visit's agent made (request 3.5); the History item is saved with the reset's evidence, so
// Reconciliation adds it exactly once. An Integrity Violation also passes what git clean leaves (integrity.rollbackSet),
// saved in the intent so a crash after the reset can still finish the restore.
async function discard(ctx, at, baseline, history, extra = {}) {
  const { record: rec, git } = ctx;
  // The worktree as the agent left it: at admission, only dirty state that still matches this is proven the agent's.
  // The ignored Protected Files and tests are in it too: the tree cannot see them, but the restore rewrites them.
  const left = await bracket(rec, async () => ({ ...await integrity.snapshot(rec.worktree),
    files: extra.untracked ? await integrity.ignoredFiles(rec.worktree, extra.untracked.pathspecs) : {} }));
  const payload = { baseline, history, ...extra, left: { head: left.head, tree: left.tree, files: left.files } };
  await bracket(rec, () => sideEffect(ctx, ctx.markerOf(at), 'reset', payload, async () => {
    await git.resetTo(rec.worktree, payload.baseline);
    if (payload.untracked) await integrity.restoreUntracked(rec.worktree, payload.untracked);
    // HEAD is read first: nothing awaited may sit between the History push and saving the evidence that proves it.
    const head = await git.headSha(rec.worktree);
    rec.history.push(payload.history);
    return { head };
  }));
}

async function bracket(rec, fn) {
  await integrity.markBusy(rec);
  let result;
  try {
    result = await fn();
  } catch (err) {
    // A crashed process saves nothing more: marking idle would also persist whatever the crash left unsaved.
    if (!(err instanceof CrashError)) await integrity.markIdle(rec);
    throw err;
  }
  await integrity.markIdle(rec);
  return result;
}

const logged = (rec, m, step) => rec.log.find((e) => e.marker === m && e.step === step);

// A completed Action is not repeated; an open one, left by Reconciliation to be redone, reuses its intended payload.
// crashAt (tests only) throws at one of three points of the Action with that marker.
async function sideEffect(ctx, m, action, payload, effect) {
  const rec = ctx.record;
  const crash = (point) => {
    if (ctx.crashAt?.marker === m && ctx.crashAt.point === point) throw new CrashError(`crash ${point} ${m}`);
  };
  if (logged(rec, m, 'complete')) return logged(rec, m, 'evidence')?.evidence;
  const intended = logged(rec, m, 'intent')?.payload;
  if (!intended) await record.intent(rec, m, action, payload);
  crash('before-effect');
  const evidence = await effect(intended ?? payload);
  crash('after-effect');
  await record.evidence(rec, m, evidence);
  await record.complete(rec, m);
  crash('after-completion');
  return evidence;
}

export async function runExecution(opts) {
  const { flow, record: rec, events: ev, clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } } = opts;
  // A resumed record keeps the Run that wrote its markers, while its Events belong to the Run resuming it.
  const ctx = { ...opts, clock, run: opts.run ?? rec.run };
  // Each Visit runs on its pinned Node's Harness; `harness` alone serves a caller with a single one.
  ctx.harnessOf = () => opts.harnesses?.[rec.snapshot?.node.harness] ?? opts.harness;

  // Records one Action Event; `at` is the Action's identity (with its attempt), `fields` its outcome and payload.
  ctx.emit = (at, t0, fields) => ev('action', {
    flow: flow.name, configHash: rec.configHash, launchProfile: null, confinement: ctx.harnessOf().capabilities.confinement,
    ticket: rec.ticket, run: ctx.run, execution: rec.execution, attempt: 1, durationMs: clock.now() - t0, ...at,
    ...(at.procedure && rec.snapshot?.options?.requireTestPass === false && { requireTestPass: false }), ...fields,
  });
  ctx.markerOf = (at) => marker.formatMarker({ execution: rec.execution, run: rec.run, attempt: 1, ...at });
  ctx.enter = async (at) => {
    rec.cursor = { vertex: at.vertex, visit: at.visit, phase: at.phase, ordinal: at.ordinal, attempt: at.attempt ?? 1 };
    await record.save(rec);
  };

  let stop = null;
  try {
    // A record that has entered a Vertex is resumed, so GitHub and git are reconciled with it first.
    if (Object.keys(rec.visits).length) {
      const { next, reason } = await bracket(rec, () => reconcile.reconcile({ record: rec, flow, git: opts.git, gh: opts.gh,
        labelPrefix: opts.labelPrefix ?? 'gg', cwd: opts.cwd }));
      if (next !== 'continue') opts.log(`#${rec.ticket} ${next}: ${reason}`);
      if (next === 'abandon') return { outcome: 'abandoned' };
      if (next === 'hold') return await hold(ctx, reason);
    }
    // The persisted cursor, not the Flow's entry: a restart continues at the Action it names with the Edge counts already taken.
    let next = rec.cursor.vertex;
    let reason = null;
    while (!TERMINALS.includes(next)) {
      ({ next, stop, reason } = await runVisit(ctx, next, rec.cursor.visit));
      if (TERMINALS.includes(next)) break;
      rec.cursor = { vertex: next, visit: (rec.visits[next] ?? 0) + 1, phase: null, ordinal: 0, attempt: 1 };
      // Saved with the traversal count, so a crash before the next Vertex runs routes the same way.
      await record.save(rec);
    }
    rec.cursor = { vertex: next, visit: null, phase: null, ordinal: 0, attempt: 1 };
    // Saved with the terminal cursor, before any Terminal side effect, so a crash inside the Terminal keeps it.
    if (reason) rec.terminalReason = next === 'done' ? { ...reason, text: `${reason.text} PR #${rec.pr} is ready for review.` } : reason;
    await record.save(rec);
    return await terminal(ctx, next, stop);
  } catch (err) {
    if (err instanceof CrashError) throw err;
    return await fault(ctx, err, stop ?? rec.terminalStop);
  }
}

// Reconciliation could not decide safely: the ticket goes to needs-human with the reason, and the record is kept as Held.
async function hold(ctx, text) {
  const rec = ctx.record;
  rec.terminalReason = { decidedBy: { hold: 'reconciliation' }, outcome: null, rule: null, text };
  rec.cursor = { vertex: 'needs-human', visit: null, phase: null, ordinal: 0, attempt: 1 };
  await record.save(rec);
  return terminal(ctx, 'needs-human', { outcome: 'needs-human', response: null, at: null, held: true });
}

// An unexpected fault is never retried: the ticket goes to needs-human with the error, and the record is marked.
// An account failure stops the whole run even when reporting it faults, so the caller can still stop every ticket.
async function fault(ctx, err, prior) {
  const rec = ctx.record;
  const error = err?.message || String(err) || 'unknown error';
  const { vertex, visit, phase, ordinal } = rec.cursor;
  // The fault replaces the Terminal Reason, so the reason of a Terminal it interrupted travels in the fault comment.
  const interrupted = TERMINALS.includes(vertex) && rec.terminalReason ? { terminal: vertex, reason: rec.terminalReason } : null;
  rec.state = 'fault';
  rec.cursor = { vertex: 'needs-human', visit: null, phase: null, ordinal: 0, attempt: 1 };
  rec.terminalReason = { decidedBy: { vertex, visit, phase, ordinal }, outcome: null, rule: null,
    text: `An unexpected fault stopped the Execution at ${phase ? `${phase} ${ordinal}` : vertex}; the error is in this comment and on ticket_end.` };
  await record.save(rec);
  const runStop = runStopOf(prior);
  return terminal(ctx, 'needs-human', { outcome: 'fault', detail: error, error, ...(runStop && { runStop }), ...(interrupted && { interrupted }) });
}

// The failure class of a run stop, whether the stop is the run stop itself or a fault that interrupted its Terminal.
const runStopOf = (stop) => (stop?.outcome === 'run-stop' ? stop.failureClass : stop?.runStop);

async function runVisit(ctx, vertexId, visit) {
  const { flow, record: rec } = ctx;
  // A cursor inside this Visit's Actions is a restart: the Visit continues on its pinned snapshot and saved state.
  const resuming = rec.cursor.phase !== null && rec.snapshot?.vertex === vertexId && rec.snapshot.visit === visit && !!rec.visitState;
  rec.visits[vertexId] = visit;
  if (!resuming) {
    const vertex = flow.ticket.vertices[vertexId];
    // shortcut: Personas resolve against the shipped defaults only; user and repo Layers arrive in slice 5.
    const { persona } = vertex.node;
    const bytes = await readFile(isAbsolute(persona) ? persona : join(PERSONAS_DIR, persona), 'utf8');
    // A copy of everything the Visit reads, so a Flow or command edited mid-Visit cannot reach its Actions, Checks or routing.
    rec.snapshot = structuredClone({ vertex: vertexId, visit, node: vertex.node, procedure: vertex.procedure, options: vertex.options,
      then: vertex.then ?? null, route: vertex.route ?? null, commands: ctx.commands,
      persona: { name: basename(vertex.node.persona), bytes, hash: sha256(bytes) } });
    // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry; log it against the Config Hash when gg run reloads between Vertices (T20).
    await record.save(rec);
  }
  const snap = rec.snapshot;
  const proc = procedures.PROCEDURES[snap.procedure];

  // A failed red is rolled back to the baseline, which is safe only when the agent made every change (request 3.5):
  // unknown uncommitted changes are Held before any agent runs, and nothing is deleted.
  if (!resuming && proc.actions.some((a) => a.phase === 'red') && !await bracket(rec, () => integrity.isCleanAt(rec.worktree, 'HEAD'))) {
    rec.history.push({ kind: 'held', text: 'The worktree had uncommitted changes before red; nothing was deleted.' });
    return { next: 'needs-human', stop: { outcome: 'needs-human', response: null, at: null }, reason: { decidedBy: { hold: 'dirty-worktree' },
      outcome: null, rule: null, text: 'The worktree had uncommitted changes before red, so no agent ran and nothing was deleted.' } };
  }
  const described = procedures.describe(snap.procedure, snap.options);
  // Saved with the record, so a restart has the calls and Check runs the remaining Actions read.
  const state = rec.visitState = resuming ? rec.visitState : { lineage: described.lineage, calls: {}, runs: {}, passed: [],
    relaxed: Object.fromEntries(described.checks.map((c) => [c.name, c.relaxed])) };
  // Not enumerable, so the Procedure's data stays out of the saved record.
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  const start = resuming ? described.actions.findIndex((a) => a.phase === rec.cursor.phase && a.ordinal === rec.cursor.ordinal) : 0;
  let last = null;
  for (const [i, action] of described.actions.entries()) {
    if (i < start) continue;
    if (action.when && !WHEN[action.when]?.(state)) continue;
    const at = { vertex: vertexId, visit, procedure: snap.procedure, phase: action.phase, ordinal: action.ordinal };
    await ctx.enter(at);
    state.next = described.actions[i + 1];
    // A stop saved before a crash is routed again; its Action is not rerun, as its rollback may have removed the work.
    const settled = state.settled?.phase === at.phase && state.settled.ordinal === at.ordinal ? state.settled.r : null;
    const r = settled ?? await KINDS[action.kind](ctx, at, action, state);
    last = { at, r };
    // A call that advances with a non-ok Outcome (a review's changes) decides where the Visit routes once it completes.
    if (action.kind === 'call' && r.direction === 'advance' && r.outcome !== 'ok') state.decided = last;
    // check-failed fires only when a recovery Phase runs next (see `exhausted`), so the Visit continues into it.
    if (r.direction === 'advance' || r.row === 'check-failed') continue;
    // A stop Claim waits for its Phase's Check, so every Check still runs and is recorded with it (request 3.4).
    if (action.kind === 'call' && STOP_CLAIMS.includes(r.outcome) && state.next?.kind === 'check') continue;
    const out = r.outcome;
    if (!settled) {
      state.settled = { phase: at.phase, ordinal: at.ordinal, r };
      await record.save(rec);
    }
    // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4).
    if (r.surfaces) {
      const { baseline } = state.calls[at.phase];
      await discard(ctx, { ...at, attempt: r.attempt }, baseline.head, { kind: 'integrity violation',
        text: `Attempt ${r.attempt} of ${at.phase} ${at.ordinal} changed ${r.surfaces.join(' and ')}; the worktree was restored to its baseline head.` }, { untracked: rollbackSet(baseline) });
    }
    // The first red call's baseline: still-green's would count red's additions as the owner's.
    if (out === 'red-failed') await discard(ctx, at, state.first.head, { kind: 'red phase failed', text: r.reason }, { untracked: rollbackSet(state.first) });
    // A Check's Integrity Violation (Test Immutability) is the preceding call's doing, so it rolls back to that Attempt's baseline.
    if (r.row === 'integrity-violation' && !r.surfaces) {
      const { baseline } = state.calls[at.phase];
      await discard(ctx, at, baseline.head, { kind: 'integrity violation',
        text: `${at.phase} ${at.ordinal} found a changed committed test; the worktree was restored to the baseline head of ${at.phase}.` }, { untracked: rollbackSet(baseline) });
    }
    // The Red Check's diagnosis can quote agent-reported test names, so it is posted fenced, never in the reason text.
    return { next: traverse(rec, out).next,
      stop: { outcome: out, response: state.response, at, ...(out === 'red-failed' && { detail: r.reason }),
        ...(out === 'run-stop' && { failureClass: r.failureClass }) },
      reason: terminalReason(at, r.outcome, r, stopText(at, out, r)) };
  }
  const checked = state.passed.length ? `: ${state.passed.join(' and ')} passed` : '';
  const { at, r } = state.decided ?? last;
  const e = traverse(rec, state.decided ? r.outcome : 'ok');
  const exhausted = e.exhausted ? `, and its Edge to ${e.target.to} had already used its Bound of ${e.target.max} traversals` : '';
  const text = state.decided ? `${vertexId} visit ${visit} completed every ${snap.procedure} Action with outcome ${r.outcome}${exhausted}.`
    : `${vertexId} visit ${visit} completed every ${snap.procedure} Action${checked}.`;
  return { next: e.next, stop: null, reason: terminalReason(at, r.outcome, r, text) };
}

// Only the Visit that routes to a Terminal keeps its reason; the Signals stay on the deciding Action's Event.
const terminalReason = ({ vertex, visit, phase, ordinal }, outcome, r, text) =>
  ({ decidedBy: { vertex, visit, phase, ordinal }, outcome, rule: r.row, text });

function stopText(at, out, r) {
  const where = `${at.phase} ${at.ordinal}`;
  const cls = r.failureClass ?? 'unknown';
  switch (r.row) {
    case 'integrity-violation': return r.surfaces
      ? `The agent's Attempt at ${where} broke an Integrity Assertion on ${r.surfaces.join(' and ')}, so the worktree was restored to its baseline head.`
      : `Test Immutability failed at ${where}: a committed test was changed.`;
    case 'parse-exhausted': return `The agent gave no valid Structured Response at ${where}, even after the return-the-result nudge.`;
    case 'timeout-exhausted': return `The harness call at ${where} timed out or was killed, and so did its retry.`;
    case 'transient-exhausted': return `The harness call at ${where} kept failing with class ${cls} until its retry budget ran out.`;
    case 'run-stop': return `The harness call at ${where} failed with class ${cls}, which stops the whole run.`;
    case 'unknown-failure': return `The harness call at ${where} failed with class ${cls}, which is never retried.`;
  }
  if (out === 'gate-failed(test)') return `The Green Check failed at ${where} with no test-fix left (rule ${r.row}).`;
  if (out === 'red-failed') return `The red phase failed the Red Check (rule ${r.row}) and the agent's changes were discarded.`;
  // The agent's notes stay out: the blocked comment posts them fenced, and they need not be one sentence.
  if (out === 'blocked') return `The agent made a blocked Claim at ${at.phase}; its notes in the blocked comment say why.`;
  if (out === 'misscoped') return `The agent made a misscoped Claim at ${at.phase}; its diagnosis is posted with this reason.`;
  return `${where} ended with ${out} (rule ${r.row}).`;
}

// One Attempt of an agent call: `resume` and `nudge` come from the Attempt before it, if any.
async function callAttempt(ctx, at, state, { lineage, resume, nudge }) {
  const { record: rec, ticket, base, git, others = [] } = ctx;
  const harness = ctx.harnessOf();
  // Each call gets its own copy: a Harness that edits its call must not change the next one.
  const { node, persona, commands } = structuredClone(rec.snapshot);
  const m = ctx.markerOf(at);
  const red = rec.outputs.red;
  const review = rec.outputs.reviews.at(-1);
  const impl = rec.outputs.implementation.at(-1);
  // The reviewer sees the branch diff and every test file changed since the red commit, including a fix's named ones.
  const reviewInputs = at.phase === 'review' && !nudge ? await bracket(rec, async () => ({
    diff: (await git.runGit(['diff', `${base}...HEAD`], { cwd: rec.worktree })).stdout,
    changedTestFiles: (await checks.testImmutability(rec.worktree, red.sha)).changed,
  })) : {};
  const findings = at.phase === 'fix' && review ? [{ kind: `review findings from ${review.vertex} visit ${review.visit}`,
    text: review.findings.map((f) => `- ${f.severity} in ${f.file}: ${f.issue}\n  Fix: ${f.fix}`).join('\n') }] : [];
  const brief = nudge ? briefs.nudgeBrief(nudge) : briefs[state.proc.briefs[at.phase]]({ ticket, base, commands, history: [...rec.history, ...findings],
    testFiles: red?.tests, redOutput: red?.evidence.output, output: state.runs[at.phase === 'test-fix' ? 'green' : 'red']?.output,
    // The reviewer judges tddEvidenceOk, so the report carries the captured Red and Green Evidence, as the PR body does.
    impl: impl ? { ...impl.response, red: red.evidence, green: impl.green } : null, ...reviewInputs });
  // A review is read-only whatever the Node says, so a reviewer cannot ship unreviewed edits.
  const access = state.proc.access ?? node.access;
  const schema = at.phase === 'review' ?briefs.REVIEW_SCHEMA : ['red', 'still-green'].includes(at.phase) ? briefs.RED_SCHEMA : briefs.IMPLEMENT_SCHEMA;
  const call = {
    marker: m, vertex: at.vertex, visit: at.visit, phase: at.phase, attempt: at.attempt, node, persona, brief, schema, cwd: rec.worktree,
    resume, access, network: node.network, tools: harness.resolveTools(node), timeouts: node.timeouts ?? {}, env: {},
  };
  const t0 = ctx.clock.now();
  // The snapshots are git processes in this worktree, so they run inside the busy interval too (request 3.6).
  const { response, result, failure, violations, baseline } = await bracket(rec, async () => {
    const baseline = await integrity.begin({ record: rec, others, protectedPaths: PROTECTED_PATHS, testPathspecs: checks.TEST_PATHSPECS });
    state.first ??= baseline;
    const out = await harness.run(call);
    const { violations } = await integrity.end({ baseline, record: rec, others, access, protectedPaths: PROTECTED_PATHS });
    return { ...out, violations, baseline };
  });
  rec.sessions[`${at.vertex}/${at.visit}/${at.phase}`] = { sessionId: result.sessionId, harness: node.harness, personaHash: persona.hash,
    transcriptPath: result.transcriptPath, usage: result.usage.cumulative,
    vertex: at.vertex, model: node.model, effort: node.effort, persona: persona.name };
  const claim = briefs.validateResponse(call.schema, response);
  // The transition table reads the three Signals of a call as one flat result.
  state.calls[at.phase] = { result, claim, response, baseline, signal: { status: result.status, response, failure } };
  state.response = response;
  const checkResults = [{ name: 'integrity', passed: violations.length === 0, integrity: true, violations }];
  // A check on the Structured Response itself runs only on a completed Attempt with a valid Claim (request 3.4).
  if (state.proc.checks.includes('review-pass') && result.status === 'completed' && claim.valid) {
    checkResults.push({ name: 'review-pass', passed: checks.reviewPass(response).passed, integrity: false });
  }
  const r = outcome.resolve({ result: state.calls[at.phase].signal, claim, checks: checkResults,
    retries: rec.retries[`${at.vertex}/${at.visit}/${at.phase}/${at.ordinal}`] ?? {}, routes: state.proc.checkOutcome });
  ctx.emit(at, t0, {
    agent: true, harness: node.harness, cliVersion: null, model: node.model, effort: node.effort, personaHash: persona.hash,
    tools: call.tools, init: result.init, sessionId: result.sessionId, lineage: lineage ?? null,
    transcriptPath: result.transcriptPath, usage: result.usage, exitCode: result.exitCode, signal: result.signal,
    finalEventSubtype: result.finalEventSubtype, permissionDenials: result.permissionDenials, commandsRun: result.commandsRun,
    failureClass: r.failureClass, outcome: r.outcome, direction: r.direction, rule: r.row,
    signals: { result: { status: result.status, failureClass: r.failureClass }, claim, checks: checkResults },
    ...(r.check && { check: r.check }), ...(violations.length && { violations }),
    ...(edge(rec, r.outcome).exhausted && { exhausted: true }),
  });
  await record.save(rec);
  // A violation always stops (integrity-violation is the first row), so runVisit rolls it back with the other stops.
  const surfaces = violations.length ? [...new Set(violations.map((v) => v.surface))] : null;
  return { ...r, sessionId: result.sessionId, reason: claim.reason, surfaces, attempt: at.attempt };
}

const KINDS = {
  // Attempt retries (parse, timeout, transient) stay inside the Action: each is a new attempt of the same (phase, ordinal).
  async call(ctx, at, action, state) {
    const { record: rec } = ctx;
    const harness = ctx.harnessOf();
    const key = `${at.vertex}/${at.visit}/${at.phase}/${at.ordinal}`;
    const lineage = state.lineage[at.phase];
    const parent = lineage ? rec.sessions[`${at.vertex}/${at.visit}/${lineage}`] : null;
    let resume = parent?.sessionId ?? null;
    // A Session cannot be resumed without its transcript, so the Phase starts fresh with the full Brief.
    if (parent && !(parent.transcriptPath && existsSync(parent.transcriptPath))) {
      ctx.log(`#${rec.ticket} ${key}: the ${lineage} transcript is missing, so ${at.phase} starts a fresh Session with the full Brief`);
      resume = null;
    }
    let nudge = null;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await ctx.enter({ ...at, attempt });
      const r = await callAttempt(ctx, { ...at, attempt }, state, { lineage, resume, nudge });
      if (r.direction !== 'retry') return r;
      const kind = { 'parse-retry': 'parse', 'timeout-retry': 'timeout' }[r.row] ?? (r.failureClass === 'rate-limited' ? 'rateLimited' : 'transient');
      (rec.retries[key] ??= {})[kind] = (rec.retries[key][kind] ?? 0) + 1;
      await record.save(rec);
      if (r.retryAfterMs) await ctx.clock.sleep(r.retryAfterMs);
      if (harness.capabilities.resume?.supported) resume = r.sessionId;
      nudge = r.row === 'parse-retry' ? r.reason : null;
    }
  },

  async check(ctx, at, action, state) {
    const { record: rec, exec } = ctx;
    const { commands } = rec.snapshot;
    const t0 = ctx.clock.now();
    const { result, claim, response, signal } = state.calls[at.phase];
    const { run, immutability } = await bracket(rec, async () => ({
      run: await checks.greenCheck(commands.test, rec.worktree, { runShell: exec.runShell }),
      // Test Immutability is asserted with the Green Check: committed tests must still match the baseline commit.
      immutability: action.check === 'green' && rec.outputs.red ? await checks.testImmutability(rec.worktree, rec.outputs.testBaseline ?? rec.outputs.red.sha) : null,
    }));
    // A fix may change a test that a Finding of the review it answers names; any other test change is a violation.
    if (immutability && rec.snapshot.procedure === 'fix') {
      const named = new Set(rec.outputs.reviews.at(-1)?.findings.map((f) => f.file));
      immutability.changed = immutability.changed.filter((p) => !named.has(p));
      immutability.ok = immutability.changed.length === 0;
    }
    state.runs[action.check] = run;
    const name = CHECK_NAMES[action.check];
    const checked = action.check === 'red' ? checks.redCheck(run, response?.tests ?? []) : { ok: run.passed };
    const passed = checked.ok;
    const relaxed = state.relaxed[action.check];
    const evidence = checks.evidence(commands.test, run);
    if (passed || relaxed) state.evidence = { ...state.evidence, [action.check]: evidence };
    if (passed && !state.passed.includes(CHECK_TITLES[action.check])) state.passed.push(CHECK_TITLES[action.check]);
    const checkResults = [{ name, passed, integrity: false, ...(relaxed && { relaxed }) }];
    if (immutability) checkResults.unshift({ name: 'immutability', passed: immutability.ok, integrity: true, changed: immutability.changed });
    const r = outcome.resolve({ result: signal, claim, checks: checkResults, retries: {},
      exhausted: !recovers(state), failureOutcomes: state.proc.checkOutcome });
    ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, check: name,
      signals: { result: { status: result.status }, claim, checks: checkResults },
      ...(immutability && !immutability.ok && { violations: immutability.changed }) });
    return { ...r, reason: checked.reason };
  },

  async commit(ctx, at, action, state) {
    const { record: rec, git, ticket } = ctx;
    const { node } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const message = render.commitMessage({ kind: state.proc.commitKinds[at.phase], title: ticket.title, ticket: ticket.number,
      summary: state.calls[at.phase].response.summary, vertex: at.vertex, harness: node.harness, model: node.model, effort: node.effort, marker: m });
    const empty = await bracket(rec, async () => {
      // A commit intended before a restart is replayed from its recorded tree and parent, never from what is staged now, so
      // a human edit made since stays in the worktree uncommitted. Reconciliation has held a moved branch.
      const intended = logged(rec, m, 'intent')?.payload;
      if (!intended && !await git.stageAll(rec.worktree) && at.phase === 'red') return true;
      const payload = intended ?? { message, tree: await git.writeTree(rec.worktree), parent: await git.headSha(rec.worktree) };
      const { sha } = await sideEffect(ctx, m, 'commit', payload, async (p) =>
        ({ sha: intended ? await git.commitTree(rec.worktree, p) : await git.commitStaged(rec.worktree, p.message) }));
      // Red Evidence is captured once, after the test commit, and reused in every PR body.
      if (at.phase === 'red') {
        const tests = (await git.runGit(['diff', '--name-only', '-z', payload.parent, sha], { cwd: rec.worktree })).stdout.split('\0').filter(Boolean);
        rec.outputs.red = { sha, tests, evidence: state.evidence.red };
      } else if (!rec.outputs.implementation.some((o) => o.vertex === at.vertex && o.visit === at.visit)) {
        // The implementer's report and Green Evidence outlive the Visit: the review Brief and every PR body re-render read them.
        rec.outputs.implementation.push({ vertex: at.vertex, visit: at.visit, sha, response: state.calls[at.phase].response, green: state.evidence.green });
        // The fix commit passed Test Immutability, so its only test changes are the named ones: it is the new baseline.
        // A fix with no edits makes no commit and leaves the baseline where it was.
        if (at.phase === 'fix' && sha) rec.outputs.testBaseline = sha;
      }
      await record.save(rec);
    });
    if (!empty) return effectDone(ctx, at, t0);
    // Nothing to commit means no tests were written: the Red Check's evidence is void and no recovery Phase follows.
    const { result, claim, signal } = state.calls.red;
    const checkResults = [{ name: CHECK_NAMES.red, passed: false, integrity: false }];
    const r = outcome.resolve({ result: signal, claim, checks: checkResults, retries: {}, exhausted: true, failureOutcomes: state.proc.checkOutcome });
    ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, check: r.check,
      signals: { result: { status: result.status }, claim, checks: checkResults } });
    return { ...r, reason: 'No tests were written.' };
  },

  async push(ctx, at) {
    const { record: rec, git } = ctx;
    const t0 = ctx.clock.now();
    await bracket(rec, async () => {
      // The commit the record proves was checked, not HEAD: a branch changed by hand is never published.
      const sha = record.lastCommit(rec)?.evidence.sha ?? await git.headSha(rec.worktree);
      await sideEffect(ctx, ctx.markerOf(at), 'push', { branch: rec.branch, sha }, async (p) => {
        await git.push(rec.worktree, p.branch, p.sha);
        const remoteSha = await git.remoteSha(rec.worktree, p.branch);
        if (remoteSha !== p.sha) throw new Error(`origin has ${p.branch} at ${remoteSha}, not the intended ${p.sha}`);
        return { remoteSha };
      });
    });
    return effectDone(ctx, at, t0);
  },

  // The Findings Hash of this review; one equal to an earlier review's by the same Vertex in this Execution is a repeat.
  async 'findings-hash'(ctx, at, action, state) {
    const { record: rec } = ctx;
    const t0 = ctx.clock.now();
    const { findings } = state.calls.review.response;
    const findingsHash = checks.findingsHash(findings);
    const repeat = rec.outputs.reviews.some((r) => r.vertex === at.vertex && r.findingsHash === findingsHash);
    rec.outputs.reviews.push({ vertex: at.vertex, visit: at.visit, findingsHash, findings });
    await record.save(rec);
    // shortcut: repeat is flagged but routes as changes until repeat routing lands (slice 4).
    const r = { outcome: state.decided?.r.outcome ?? 'ok', direction: 'advance', row: 'effect-completed' };
    ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, signals: {}, ...(repeat && { repeat: true }) });
    return r;
  },

  async comment(ctx, at, action, state) {
    const { record: rec, gh, cwd } = ctx;
    const { node, persona } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const body = render.reviewComment(state.calls.review.response,
      { harness: node.harness, model: node.model, effort: node.effort, persona: persona.name, hash: persona.hash.slice(0, 12) }, m);
    await bracket(rec, () => sideEffect(ctx, m, 'comment', { target: { kind: 'pr', number: rec.pr }, body, bodyHash: sha256(body) }, async (p) => {
      const url = await gh.comment(p.target.number, p.body, cwd);
      return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
    }));
    return effectDone(ctx, at, t0);
  },

  // Creates the PR after tdd, and re-renders its body after a fix or review with a provenance row per Vertex.
  async 'pr-upsert'(ctx, at) {
    const { record: rec, gh, ticket, cwd } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const impl = rec.outputs.implementation.at(-1);
    const body = render.prBody({
      ticket, marker: m, impl: { ...impl.response, red: rec.outputs.red.evidence, green: impl.green }, provenance: provenance(rec),
    });
    const payload = { branch: rec.branch, base: ctx.base, title: ticket.title, body, bodyHash: sha256(body) };
    await bracket(rec, () => sideEffect(ctx, m, 'pr-upsert', payload, async (p) => {
      const pr = await gh.upsertPr(p, cwd);
      rec.pr = pr.number;
      return { number: pr.number, url: pr.url };
    }));
    return effectDone(ctx, at, t0);
  },
};

function provenance(rec) {
  const rows = {};
  for (const s of Object.values(rec.sessions)) {
    const row = rows[s.vertex] ??= { vertex: s.vertex, harness: s.harness, model: s.model, effort: s.effort, persona: s.persona,
      hash: s.personaHash.slice(0, 12), calls: 0, input: 0, cached: 0, output: 0 };
    row.calls++;
    row.input += s.usage.input;
    row.cached += s.usage.cached;
    row.output += s.usage.output;
  }
  return Object.values(rows);
}

function effectDone(ctx, at, t0) {
  const r = { outcome: 'ok', direction: 'advance', row: 'effect-completed' };
  ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, signals: {} });
  return r;
}

// One deterministic Action of a Terminal: bracketed, write-ahead, with its own Action Event.
async function terminalAction(ctx, at, action, payload, effect) {
  const t0 = ctx.clock.now();
  await ctx.enter(at);
  const evidence = await bracket(ctx.record, () => sideEffect(ctx, ctx.markerOf(at), action, payload, effect));
  effectDone(ctx, at, t0);
  return evidence;
}

async function terminal(ctx, name, stop) {
  const { record: rec, gh, git, cwd, log, events: ev, labelPrefix = 'gg' } = ctx;
  const state = labels(labelPrefix).state;
  // Saved before the first Terminal Action, so a restart inside the Terminal runs the same Actions with the same ordinals
  // and ends with the same classification: held, fault with its error, or a run stop.
  if (stop) {
    rec.terminalStop = stop;
    await record.save(rec);
  } else stop = rec.terminalStop ?? null;
  const error = stop?.error;
  // A fault report has its own phase, so its Actions never replay the open intent of a Terminal it interrupted.
  const at = (ordinal) => ({ vertex: name, visit: 1, procedure: null, phase: error ? 'fault' : name, ordinal });
  // In a fault the report is best effort: a failing comment or label must not keep the state and ticket_end from landing.
  const tolerate = (p) => (error ? p.catch((e) => { if (e instanceof CrashError) throw e; log(`fault report failed: ${e?.message}`); }) : p);
  let ordinal = 0;
  if (name === 'done') {
    await terminalAction(ctx, at(++ordinal), 'pr-ready', { number: rec.pr }, async () => {
      await gh.markReady(rec.pr, cwd);
      return {};
    });
  }
  const reason = rec.terminalReason;
  // The blocked comment carries the Terminal Reason, so a blocked Ticket still gets exactly one comment.
  // The replan diagnosis goes to the ticket and to its epic, each carrying the Terminal Reason as the blocked comment does.
  const diagnosis = name === 'replan' && stop?.response;
  const comment = (number) => {
    const m = ctx.markerOf(at(++ordinal));
    const body = stop?.outcome === 'blocked' ? render.blockedComment(stop.response, m, reason)
      : diagnosis ? render.diagnosisComment(stop.response, m, reason) : render.terminalComment(name, reason, m, stop?.detail, stop?.interrupted);
    return tolerate(terminalAction(ctx, at(ordinal), 'comment', { target: { kind: 'issue', number }, body, bodyHash: sha256(body) }, async (p) => {
      const url = await gh.commentIssue(p.target.number, p.body, cwd);
      return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
    }));
  };
  await comment(rec.ticket);
  if (diagnosis && rec.epic) await comment(rec.epic);
  const change = { add: [state({ done: 'ready-for-qa', replan: 'needs-replan' }[name] ?? 'needs-human')], remove: [state('in-progress')] };
  let diffStats;
  await tolerate(terminalAction(ctx, at(++ordinal), 'label', { ticket: rec.ticket, ...change }, async (p) => {
    const ok = await gh.setLabels(p.ticket, { add: p.add, remove: p.remove }, cwd, { log, ev });
    if (name === 'done') diffStats = events.diffStats(await git.numstat(rec.worktree, rec.base));
    return { ok };
  }));
  rec.state = stop?.held ? 'held' : error ? 'fault' : name;
  await record.save(rec);
  ev('ticket_end', { run: ctx.run, execution: rec.execution, ticket: rec.ticket, outcome: name,
    ...(diffStats && { diffStats }), reason, ...(error && { error }), ...(stop?.interrupted && { interrupted: stop.interrupted }) });
  const failureClass = runStopOf(stop);
  return { outcome: name, ...(stop?.held && { held: true }), ...(error && { fault: true }), ...(failureClass && { runStop: { failureClass } }) };
}
