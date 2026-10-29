import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { PERSONAS_DIR } from './config.mjs';
import * as briefs from './briefs.mjs';
import * as checks from './checks.mjs';
import * as events from './events.mjs';
import * as integrity from './integrity.mjs';
import { ENDS } from './labels.mjs';
import * as marker from './marker.mjs';
import * as outcome from './outcome.mjs';
import * as procedures from './procedures.mjs';
import * as reconcile from './reconcile.mjs';
import * as record from './record.mjs';
import * as refs from './refs.mjs';
import * as render from './render.mjs';
import { CrashError, Decided, REMOTE, bracket, crashPoint, effectDone, fatal, finish, lockGuard, logged, lookup, sideEffect } from './effects.mjs';
import { abandon, decide, fault, hold, runStopOf, runStopped, stopText, terminal, terminalAt, terminalReason, whereOf } from './terminal.mjs';

export { CrashError };

// gg's own Protected Files; every shipped Harness adds the paths that configure it, whichever Harness an Agent uses,
// since a later Vertex on that Harness would load them (request 3.6).
const GG_PROTECTED_PATHS = ['.agents/', '.github/actions/', '.github/workflows/'];
// Built before preflight from every shipped Harness, so a malformed declaration fails here, by name, not as an unprotected path.
export function protectedFiles(harnesses) {
  const declared = Object.entries(harnesses).flatMap(([name, { protectedPaths: paths }]) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p)) throw new Error(`harness ${name} must declare protectedPaths as an array of paths`);
    return paths;
  });
  return [...new Set([...GG_PROTECTED_PATHS, ...declared])].sort();
}
// The green Action runs the declared `test` command, so its failure is gate-failed(test).
const CHECK_NAMES = { red: 'red', green: 'test' };
const CHECK_TITLES = { red: 'the Red Check', green: 'the Green Check' };

// A Vertex with no agent Action has the implicit Claim ok, which requires all its Checks (R11f).
const IMPLICIT_OK = { result: { status: 'completed' }, claim: { valid: true, claim: 'ok' }, response: null,
  signal: { status: 'completed', response: { claim: 'ok' }, failure: null } };
// The conditions of the Procedures' conditional Actions, read from the Check runs of this Visit.
const WHEN = {
  'red run passed': (state) => state.runs.red?.code === 0,
  'green run failed': (state) => state.runs.green?.passed === false && !state.relaxed.green,
};
// A failing Check is retried only through a recovery Phase that runs next; otherwise the Procedure has exhausted it.
const recovers = (state) => !!WHEN[state.next?.when]?.(state);

// Where an Outcome leaves the pinned Vertex (H7): the Vertex's route for it, then the Flow's, then the Vertex's "*", then
// the Flow's, else end: needs-human (R12c). Only the Procedure's Outcomes and harness exhaustion are routable; any other
// (an Integrity Violation, a run stop) ends at needs-human whatever the routes say. A bounded Edge counts traversals per
// Execution in record.traversals and, once `max` is reached, routes to its `exhausted` target instead. An end's name is
// the next cursor's Vertex, which no Vertex may take (validate.mjs).
const NEEDS_HUMAN = { end: 'needs-human' };
const nameOf = (target) => (typeof target === 'string' ? target : target.end);
function edge(rec, out) {
  const { vertex, procedure, route, routes } = rec.snapshot;
  const routable = procedures.PROCEDURES[procedure].outcomes.includes(out) || outcome.HARNESS_OUTCOMES.includes(out);
  const target = (routable && [route?.[out], routes?.[out], route?.['*'], routes?.['*']].find((t) => t !== undefined)) || NEEDS_HUMAN;
  if (!target.to) return { next: nameOf(target) };
  const key = `${vertex}->${target.to}:${out}`;
  const count = rec.traversals[key] ?? 0;
  return count < target.max ? { next: target.to, key, count: count + 1 } : { next: nameOf(target.exhausted), exhausted: true, target };
}

// Takes the Edge; the count is saved with the next Vertex's entry, before it runs, so a restart routes the same way.
function traverse(rec, out) {
  const e = edge(rec, out);
  if (e.key) rec.traversals[e.key] = e.count;
  return e;
}

// An Action's outputs (W2), one entry per Vertex, Visit and Action in Visit order. A recovery pass of the Action, or a
// resumed one, replaces its fields, so a reference reads the Action's last pass.
function setOutput(rec, at, value) {
  const entry = rec.outputs.find((o) => o.vertex === at.vertex && o.visit === at.visit && o.action === at.action);
  if (entry) Object.assign(entry.value, value);
  else rec.outputs.push({ vertex: at.vertex, visit: at.visit, action: at.action, value });
}

// Each input at Visit entry (S4, T6): the value from the latest Visit that produced any of its sources, with that
// Vertex, Visit and Action. An optional input none produced is absent (T10); a required one stops the Execution, which
// admission prevents once it checks inputs on every path (#116).
function resolveInputs(rec, vertexId, declared = {}) {
  return Object.fromEntries(Object.entries(declared).map(([name, { from, optional, pick }]) => {
    const sources = [from].flat().map((ref) => {
      const [vertex, action, ...path] = refs.parse(ref).steps ?? [];
      return { vertex, action, path: path.join('.') };
    });
    for (const o of rec.outputs.toReversed()) {
      for (const s of sources) {
        const value = o.vertex === s.vertex && o.action === s.action ? refs.read(o.value, s.path) : undefined;
        if (value === undefined) continue;
        return [name, { value: pick === undefined ? value : value.map((item) => refs.read(item, pick)), vertex: o.vertex, visit: o.visit, action: o.action }];
      }
    }
    if (!optional) throw new Error(`${vertexId}'s input ${name} has no value: no Visit produced ${[from].flat().join(' or ')}`);
    return [name, { absent: true }];
  }));
}

// An absent input reads as nothing, so a template renders it empty (T10).
const inputValues = (inputs) => Object.fromEntries(Object.entries(inputs).map(([name, i]) => [name, i.absent ? undefined : i.value]));
// What a Check parameter or a `with` may name (U1, W2): the Vertex's own outputs by Action id, and its inputs.
function scopeOf(rec, at) {
  const own = rec.outputs.filter((o) => o.vertex === at.vertex && o.visit === at.visit).map((o) => [o.action, o.value]);
  return { ...Object.fromEntries(own), inputs: inputValues(rec.snapshot.inputs) };
}
const bind = (rec, at, action) => Object.fromEntries(Object.entries(action.with ?? {}).map(([name, ref]) => [name, refs.read(scopeOf(rec, at), ref)]));

const rollbackSet = (ctx, rec, baseline) => integrity.rollbackSet(baseline, ctx.protectedPaths, checks.testPathSet(rec.snapshot.testPaths));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// An agent Action's Session, which its recovery passes and retries resume.
const sessionKey = (at) => `${at.vertex}/${at.visit}/${at.action}`;

// A failed red Phase or an Integrity Violation leaves nothing behind and tells the next Brief why. Rollback is limited
// to what this Visit's agent made (request 3.5); the History item is saved with the reset's evidence, so
// Reconciliation adds it exactly once. An Integrity Violation also passes what git clean leaves (integrity.rollbackSet),
// saved in the intent so a crash after the reset can still finish the restore.
async function discard(ctx, at, baseline, history, extra = {}) {
  const { record: rec, git } = ctx;
  // The worktree as the agent left it: at admission, only dirty state that still matches this is proven the agent's.
  // The ignored Protected Files and tests are in it too: the tree cannot see them, but the restore rewrites them.
  const left = await bracket(rec, async () => ({ ...await ctx.integrity.snapshot(rec.worktree),
    files: extra.untracked ? await ctx.integrity.ignoredFiles(rec.worktree, extra.untracked.within) : {} }));
  const payload = { baseline, history, ...extra, left: { head: left.head, index: left.index, tree: left.tree, files: left.files } };
  await bracket(rec, () => sideEffect(ctx, ctx.markerOf(at), 'reset', payload, async () => {
    await git.resetTo(rec.worktree, payload.baseline);
    if (payload.untracked) await ctx.integrity.restoreUntracked(rec.worktree, payload.untracked);
    // HEAD is read first: nothing awaited may sit between the History push and saving the evidence that proves it.
    const head = await git.headSha(rec.worktree);
    rec.history.push(payload.history);
    return { head };
  }));
}

const reportDecided = (rec) => !!(rec.terminalStop?.held || rec.terminalStop?.error || rec.terminalStop?.abandoned)
  && !events.hasTicketEnd(rec.commonDir, rec.execution);
// A hold, fault or abandonment decided and saved, at admission or by a Terminal, whose ticket_end has not landed: the next
// Run finishes its report.
export const pendingReport = (rec) => (!!rec.admission && !events.hasTicketEnd(rec.commonDir, rec.execution)) || reportDecided(rec);

// `fault`, an error the caller hit before the Execution could run, is reported as an unexpected fault without running it;
// `admission`, a hold or abandonment the caller decided, is its Terminal. `integrity` and `testImmutability` default to the
// real ones; a test whose subject is not git behaviour passes a fake.
// The wall clock. `every(ms, fn)` calls fn every ms until the stop function it returns is called.
export const WALL_CLOCK = {
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  every: (ms, fn) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
};

export async function runExecution(opts) {
  const { flow, record: rec, events: ev, clock = WALL_CLOCK } = opts;
  // Missing, nothing would be protected.
  if (!opts.protectedPaths) throw new Error('runExecution needs protectedPaths');
  // A resumed record keeps the Run that wrote its markers, while its Events belong to the Run resuming it.
  const ctx = { ...opts, clock, run: opts.run ?? rec.run, runState: opts.runState ?? { stop: null, remoteNotBefore: 0 },
    integrity: opts.integrity ?? integrity.withGit(opts.git),
    testImmutability: opts.testImmutability ?? ((cwd, baseline, globs) => checks.testImmutability(cwd, baseline, { globs, git: opts.git })) };
  // Reconciliation looks for a remote effect as a retry does: a failed lookup is retried on the Action's budget.
  if (opts.git && Object.hasOwn(opts.git, 'withGuard')) ctx.git = opts.git.withGuard((verb, args, git) => lockGuard(ctx, verb, args, git));
  const find = (entry, c) => (REMOTE.includes(entry.action) ? lookup(ctx, entry, c) : reconcile.findEffect(entry, c));
  ctx.publicText ??= render.publicTextFor({ worktree: rec.worktree, commonDir: rec.commonDir, cwd: opts.cwd });
  // Each Visit runs on its pinned Agent's Harness; `harness` alone serves a caller with a single one. A Vertex without an
  // Agent (publish) runs on none, and a fault before the first Visit has no pinned Agent, so their deterministic Actions
  // record no confinement.
  ctx.harnessOf = () => (rec.snapshot?.agent === null ? null : opts.harnesses?.[rec.snapshot?.agent.harness] ?? opts.harness);

  // Records one Action Event; `at` is the Action's identity (with its attempt), `fields` its outcome and payload.
  ctx.emit = (at, t0, fields) => ev('action', {
    flow: flow.name, configHash: rec.configHash, launchProfile: null, confinement: ctx.harnessOf()?.capabilities.confinement ?? null,
    ticket: rec.ticket, run: ctx.run, execution: rec.execution, attempt: 1, durationMs: clock.now() - t0, ...at,
    ...(at.procedure && rec.snapshot?.options?.requireTestPass === false && { requireTestPass: false }), ...fields,
  });
  ctx.markerOf = (at) => marker.formatMarker({ execution: rec.execution, run: rec.run, attempt: 1, ...at });
  ctx.enter = async (at) => {
    const c = rec.cursor;
    // A resume re-entering the cursor's own Action continues at its Attempt.
    const same = c.vertex === at.vertex && c.visit === at.visit && c.action === at.action && c.recovery === at.recovery;
    rec.cursor = { vertex: at.vertex, visit: at.visit, action: at.action, recovery: at.recovery, attempt: at.attempt ?? (same ? c.attempt : 1) };
    await record.save(rec);
  };

  let stop = null;
  const pending = reportDecided(rec);
  ctx.laterRunReport = pending;
  // A decision admission saved with the record is reported as decided, never decided again.
  const admission = opts.admission ?? rec.admission;
  try {
    if (opts.fault) throw opts.fault;
    if (admission?.kind === 'fault') throw new Error(admission.error);
    if (admission?.kind === 'hold') return await hold(ctx, admission);
    if (admission?.kind === 'abandon') return await abandon(ctx, admission);
    if (pending) {
      const name = rec.terminalStop.abandoned ? 'abandoned' : 'needs-human';
      // A needs-human or abandonment report is a comment and a label.
      const markers = ['comment', 'label'].map((effect) => ctx.markerOf(terminalAt(name, rec.terminalStop)(effect)));
      const decided = await reconcile.terminalEffects(rec, { gh: opts.gh, labelPrefix: opts.labelPrefix ?? 'gg', cwd: opts.cwd, markers, find });
      if (decided.next === 'abandon') return await abandon(ctx, decided);
      return await terminal(ctx, name);
    }
    // A record that has entered a Vertex is resumed, so GitHub and git are reconciled with it first.
    if (Object.keys(rec.visits).length) {
      const decided = await bracket(rec, () => reconcile.reconcile({ record: rec, flow, git: ctx.git, integrity: ctx.integrity, gh: opts.gh,
        labelPrefix: opts.labelPrefix ?? 'gg', cwd: opts.cwd, find }));
      if (decided.next !== 'continue') opts.log(`#${rec.ticket} ${decided.next}: ${decided.reason}${decided.advice ? ` ${decided.advice}` : ''}`);
      if (decided.next === 'abandon') return await abandon(ctx, decided);
      if (decided.next === 'hold') return await hold(ctx, { name: decided.name, text: decided.reason, advice: decided.advice });
    }
    // The persisted cursor, not the Flow's entry: a restart continues at the Action it names with the Edge counts already taken.
    let next = rec.cursor.vertex;
    let reason = null;
    while (!ENDS.includes(next)) {
      ({ next, stop, reason } = await runVisit(ctx, next, rec.cursor.visit));
      if (ENDS.includes(next)) break;
      rec.cursor = { vertex: next, visit: (rec.visits[next] ?? 0) + 1, action: null, recovery: 0, attempt: 1 };
      // Saved with the traversal count, so a crash before the next Vertex runs routes the same way.
      await record.save(rec);
    }
    // The Terminal cursor, reason and stop are one save, before any Terminal side effect, so a crash inside the Terminal
    // keeps all three. A resume inside the Terminal has them saved already.
    if (reason) {
      rec.cursor = { vertex: next, visit: null, action: null, recovery: 0, attempt: 1 };
      rec.terminalReason = next === 'ready-for-qa' ? { ...reason, text: `${reason.text} PR #${rec.pr} is ready for review.` } : reason;
      rec.terminalStop = stop;
      await record.save(rec);
    }
    return await terminal(ctx, next);
  } catch (err) {
    if (fatal(err)) throw err;
    if (err instanceof Decided) return await decide(ctx, err.decided);
    // A decided hold, abandonment or resumed fault stays as decided when its report fails: its open intents are the next
    // Run's to reconcile, so nothing is reported twice.
    if (pending || rec.terminalStop?.held || rec.terminalStop?.abandoned) {
      const failureClass = runStopOf(rec.terminalStop);
      return { outcome: rec.terminalStop.abandoned ? 'abandoned' : 'needs-human', fault: true, error: err?.message || String(err),
        ...(failureClass && { runStop: { failureClass } }) };
    }
    return await fault(ctx, err, stop ?? rec.terminalStop);
  }
}

async function runVisit(ctx, vertexId, visit) {
  const { flow, record: rec } = ctx;
  // A cursor inside this Visit's Actions is a restart: the Visit continues on its pinned snapshot and saved state.
  const resuming = rec.cursor.action !== null && rec.snapshot?.vertex === vertexId && rec.snapshot.visit === visit && !!rec.visitState;
  rec.visits[vertexId] = visit;
  if (!resuming) {
    const { agent, procedure, options, route, inputs } = flow.ticket.vertices[vertexId];
    // shortcut: Personas resolve against the shipped defaults only; user and repo Layers arrive in slice 5.
    // A Vertex without an Agent (publish) pins no Persona.
    const bytes = agent && await readFile(isAbsolute(agent.persona) ? agent.persona : join(PERSONAS_DIR, agent.persona), 'utf8');
    // A copy of everything the Visit reads, so a Flow or command edited mid-Visit cannot reach its Actions, Checks or routing.
    rec.snapshot = structuredClone({ vertex: vertexId, visit, agent, procedure, options, route: route ?? null, routes: flow.ticket.routes ?? null,
      inputs: resolveInputs(rec, vertexId, inputs),
      commands: ctx.commands, testPaths: ctx.testPaths, persona: agent && { name: basename(agent.persona), bytes, hash: sha256(bytes) } });
    // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry; log it against the Config Hash when gg run reloads between Vertices (T20).
    await record.save(rec);
  }
  const snap = rec.snapshot;
  const proc = procedures.PROCEDURES[snap.procedure];

  // A rollback (a failed red, an Integrity Violation) is safe only when the agent made every change (request 3.5), and any
  // Vertex's agent may cause one whatever its access, so every Vertex starts only on a clean worktree or one an open intent
  // explains, as at admission (R2d); anything else is Held before any agent runs.
  if (!resuming && await bracket(rec, () => reconcile.dirtyState(rec, { git: ctx.git, worktree: rec.worktree, integrity: ctx.integrity }))) {
    rec.history.push({ kind: 'held', text: `The worktree had uncommitted changes before ${vertexId}; nothing was deleted.` });
    return { next: 'needs-human', stop: { outcome: 'needs-human', response: null, at: null }, reason: { decidedBy: { hold: 'dirty-worktree' },
      outcome: null, rule: null, text: `The worktree had uncommitted changes before ${vertexId}, so no agent ran and nothing was deleted.` } };
  }
  const described = procedures.describe(snap.procedure, snap.options);
  // Saved with the record, so a restart has the calls and Check runs the remaining Actions read.
  const state = rec.visitState = resuming ? rec.visitState : { lineage: described.lineage, recovery: 0, calls: {}, runs: {}, passed: [],
    relaxed: Object.fromEntries(described.checks.map((c) => [c.name, c.relaxed])) };
  // Not enumerable, so the Procedure's data stays out of the saved record.
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  const c = rec.cursor;
  const start = resuming ? described.actions.findIndex((a) => a.id === c.action && (a.recovery ?? c.recovery) === c.recovery) : 0;
  let last = null;
  for (const [i, action] of described.actions.entries()) {
    if (i < start) continue;
    if (action.when && !WHEN[action.when]?.(state)) continue;
    // The Actions after a recovery pass carry its Recovery Number.
    const at = { vertex: vertexId, visit, procedure: snap.procedure, action: action.id, recovery: state.recovery = action.recovery ?? state.recovery };
    await ctx.enter(at);
    state.next = described.actions[i + 1];
    // A result saved before a crash is routed again; its Action is not rerun, as a stop's rollback may have removed the work.
    const settled = state.settled?.action === at.action && state.settled.recovery === at.recovery ? state.settled.r : null;
    const r = settled ?? runStopped(ctx) ?? await KINDS[action.kind](ctx, at, action, state);
    // A run stop routed again from its saved result still stops the other Executions.
    if (r.row === 'run-stop' && ctx.runState) ctx.runState.stop ??= { failureClass: r.failureClass, ticket: rec.ticket };
    last = { at, r };
    // A call that advances with a non-ok Outcome (a review's changes) decides where the Visit routes once it completes.
    if (action.kind === 'call' && r.direction === 'advance' && r.outcome !== 'ok') state.decided = last;
    // check-failed fires only when a recovery Phase runs next (see `exhausted`), so the Visit continues into it.
    if (r.direction === 'advance' || r.row === 'check-failed') continue;
    // A stop Claim waits for its Phase's Check, so every Check still runs and is recorded with it (request 3.4).
    if (action.kind === 'call' && outcome.STOP_CLAIMS.includes(r.outcome) && state.next?.kind === 'check') continue;
    const out = r.outcome;
    if (!settled) {
      state.settled = { action: at.action, recovery: at.recovery, r };
      await record.save(rec);
    }
    // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4).
    if (r.surfaces) {
      const { baseline } = state.calls[action.phase];
      // The call's own marker is complete, so its rollback is an Action of its own.
      await discard(ctx, { ...at, action: 'reset', attempt: r.attempt }, baseline.head, { kind: 'integrity violation',
        text: `Attempt ${r.attempt} of ${whereOf(at)} changed ${r.surfaces.join(' and ')}; the worktree was restored to its baseline head.` }, { untracked: rollbackSet(ctx, rec, baseline) });
    }
    // The first red call's baseline: still-green's would count red's additions as the owner's.
    if (out === 'red-failed') await discard(ctx, at, state.first.head, { kind: 'red phase failed', text: r.reason }, { untracked: rollbackSet(ctx, rec, state.first) });
    // A Check's Integrity Violation (Test Immutability) is the preceding call's doing, so it rolls back to that Attempt's baseline.
    if (r.row === 'integrity-violation' && !r.surfaces) {
      const { baseline } = state.calls[action.phase];
      await discard(ctx, at, baseline.head, { kind: 'integrity violation',
        text: `${whereOf(at)} found a changed committed test; the worktree was restored to the baseline head of the agent call before it.` }, { untracked: rollbackSet(ctx, rec, baseline) });
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

// While an agent call runs its heartbeat is saved about every 60 s on the clock: a file modified after the last one is
// not the agent's (ADR 0011). A heartbeat that cannot be saved stops and fails the call.
async function withHeartbeat(ctx, run) {
  const rec = ctx.record;
  let failed = null;
  const stop = ctx.clock.every(60_000, () => {
    rec.heartbeat = new Date(ctx.clock.now()).toISOString();
    record.save(rec).catch((err) => {
      failed ??= err;
      stop();
    });
  });
  try {
    const out = await run();
    if (failed) throw failed;
    return out;
  } finally {
    stop();
    rec.heartbeat = null;
  }
}

// One Attempt of an agent call: `resume` and `nudge` come from the Attempt before it, if any.
async function callAttempt(ctx, at, { phase }, state, { lineage, resume, nudge }) {
  const { record: rec, ticket, base, git } = ctx;
  const m = ctx.markerOf(at);
  // A completed Attempt is never run again; runVisit routes every saved result but a retry's, which ends up here.
  if (logged(rec, m, 'complete')) return logged(rec, m, 'evidence').evidence;
  const harness = ctx.harnessOf();
  // Each call gets its own copy: a Harness that edits its call must not change the next one.
  const { agent, persona, commands } = structuredClone(rec.snapshot);
  // shortcut: the shipped Briefs name their inputs through these fixed context names; they name inputs directly once
  // Briefs load from the Layer (#116).
  const inputs = inputValues(rec.snapshot.inputs);
  const review = rec.snapshot.inputs.findings;
  const findings = inputs.findings ? [{ kind: `review findings from ${review.vertex} visit ${review.visit}`,
    text: inputs.findings.map((f) => `- ${f.severity} in ${f.file}: ${f.issue}\n  Fix: ${f.fix}`).join('\n') }] : [];
  const brief = await briefs.brief(nudge ? 'nudge.md' : state.proc.briefs[phase], { ticket, base, commands, history: [...rec.history, ...findings],
    testFiles: inputs.tests, redOutput: inputs.red?.output, output: state.runs[phase === 'test-fix' ? 'green' : 'red']?.output,
    // The reviewer judges tddEvidenceOk, so the report carries the captured Red and Green Evidence, as the PR body does.
    impl: inputs.report ? { ...inputs.report, red: inputs.red, green: inputs.green } : null, reason: nudge,
    // The branch diff and every test file changed since the Execution's first test commit, including a fix's named ones,
    // read git only for a Brief that names them.
    diff: () => bracket(rec, () => git.branchDiff(rec.worktree, base)),
    changedTestFiles: async () => (await bracket(rec, () => ctx.testImmutability(rec.worktree, rec.testCommits.first, rec.snapshot.testPaths))).changed });
  // A review is read-only whatever the Agent says, so a reviewer cannot ship unreviewed edits.
  const access = state.proc.access ?? agent.access;
  const schema = phase === 'review' ? briefs.REVIEW_SCHEMA : ['red', 'still-green'].includes(phase) ? briefs.RED_SCHEMA : briefs.IMPLEMENT_SCHEMA;
  const call = {
    marker: m, vertex: at.vertex, visit: at.visit, phase, attempt: at.attempt, agent, persona, brief, schema, cwd: rec.worktree,
    resume, access, network: agent.network, tools: harness.resolveTools(agent), timeouts: agent.timeouts ?? {}, env: {},
  };
  const t0 = ctx.clock.now();
  // The snapshots are git processes in this worktree, so they run inside the busy interval too (request 3.6).
  const { response, result, failure, violations, baseline } = await bracket(rec, async () => {
    // Read once per Attempt, so begin and end guard the same worktrees, including any created since admission.
    const others = typeof ctx.others === 'function' ? await ctx.others() : ctx.others ?? [];
    const baseline = await ctx.integrity.begin({ record: rec, others, protectedPaths: ctx.protectedPaths, testPaths: checks.testPathSet(rec.snapshot.testPaths) });
    state.first ??= baseline;
    crashPoint(ctx, m, 'before-intent');
    // Write-ahead with its baseline: an Attempt whose intent is open at resume is an Interrupted Attempt, held rather than
    // run again on a new baseline.
    rec.heartbeat = new Date(ctx.clock.now()).toISOString();
    await record.intent(rec, m, 'call', { baseline });
    const out = await withHeartbeat(ctx, () => harness.run(call));
    const { violations } = await ctx.integrity.end({ baseline, record: rec, others, access, protectedPaths: ctx.protectedPaths });
    return { ...out, violations, baseline };
  });
  rec.sessions[sessionKey(at)] = { sessionId: result.sessionId, harness: agent.harness, personaHash: persona.hash,
    transcriptPath: result.transcriptPath, usage: result.usage.cumulative,
    vertex: at.vertex, model: agent.model, effort: agent.effort, persona: persona.name };
  const claim = briefs.validateResponse(call.schema, response);
  if (claim.valid) setOutput(rec, at, { response });
  // The transition table reads the three Signals of a call as one flat result.
  state.calls[phase] = { result, claim, response, baseline, signal: { status: result.status, response, failure } };
  state.response = response;
  const checkResults = [{ name: 'integrity', passed: violations.length === 0, integrity: true, violations }];
  // A check on the Structured Response itself runs only on a completed Attempt with a valid Claim (request 3.4).
  if (state.proc.checks.includes('review-pass') && result.status === 'completed' && claim.valid) {
    checkResults.push({ name: 'review-pass', passed: checks.reviewPass(response).passed, integrity: false });
  }
  const key = marker.actionKeyOf(at);
  const r = outcome.resolve({ result: state.calls[phase].signal, claim, checks: checkResults,
    retries: rec.retries[key] ?? {}, routes: state.proc.checkOutcome });
  // A retry spends its budget in the Attempt's completion, so a resumed Action never spends it twice.
  if (r.retryKind) (rec.retries[key] ??= {})[r.retryKind] = (rec.retries[key][r.retryKind] ?? 0) + 1;
  // A violation always stops (integrity-violation is the first row), so runVisit rolls it back with the other stops.
  const surfaces = violations.length ? [...new Set(violations.map((v) => v.surface))] : null;
  const done = { ...r, sessionId: result.sessionId, reason: claim.reason, surfaces, attempt: at.attempt };
  return finish(ctx, at, t0, done, {
    agent: true, harness: agent.harness, cliVersion: null, model: agent.model, effort: agent.effort, personaHash: persona.hash,
    tools: call.tools, init: result.init, sessionId: result.sessionId, lineage: lineage ?? null,
    transcriptPath: result.transcriptPath, usage: result.usage, exitCode: result.exitCode, signal: result.signal,
    finalEventSubtype: result.finalEventSubtype, permissionDenials: result.permissionDenials, commandsRun: result.commandsRun,
    failureClass: r.failureClass, outcome: r.outcome, direction: r.direction, rule: r.row,
    signals: { result: { status: result.status, failureClass: r.failureClass }, claim, checks: checkResults },
    ...(r.check && { check: r.check }), ...(violations.length && { violations }),
    ...(edge(rec, r.outcome).exhausted && { exhausted: true }),
  }, m, { ...done, usage: result.usage.delta });
}

const KINDS = {
  // Attempt retries (parse, timeout, transient) stay inside the Action: each is a new attempt of the same (action, recovery).
  async call(ctx, at, action, state) {
    const { record: rec } = ctx;
    const harness = ctx.harnessOf();
    const lineage = state.lineage[action.phase];
    // A recovery pass resumes its agent Action's own Session.
    const parent = lineage ? rec.sessions[sessionKey(at)] : null;
    let resume = parent?.sessionId ?? null;
    // A Session cannot be resumed without its transcript, so the Phase starts fresh with the full Brief.
    if (parent && !(parent.transcriptPath && existsSync(parent.transcriptPath))) {
      ctx.log(`#${rec.ticket} ${marker.actionKeyOf(at)}: the ${lineage} transcript is missing, so ${action.phase} starts a fresh Session with the full Brief`);
      resume = null;
    }
    let nudge = null;
    // A resumed Action continues at the Attempt its cursor names, after the saved result of the one before.
    for (let attempt = rec.cursor.attempt; ; attempt++) {
      if (attempt > 1) {
        // A record saved before Attempts were write-ahead has no such result: its saved Session resumes with the full
        // Brief, or starts fresh when its transcript is gone, and its spent budget is already in record.retries.
        const saved = rec.sessions[sessionKey(at)];
        const prev = logged(rec, ctx.markerOf({ ...at, attempt: attempt - 1 }), 'evidence')?.evidence
          ?? { sessionId: saved ? (saved.transcriptPath && existsSync(saved.transcriptPath) ? saved.sessionId : null) : resume };
        if (harness.capabilities.resume?.supported) resume = prev.sessionId;
        nudge = prev.row === 'parse-retry' ? prev.reason : null;
        const stopped = runStopped(ctx);
        if (stopped) return stopped;
        await ctx.enter({ ...at, attempt });
      }
      const r = await callAttempt(ctx, { ...at, attempt }, action, state, { lineage, resume, nudge });
      if (r.direction !== 'retry') return r;
      if (r.retryAfterMs) await ctx.clock.sleep(r.retryAfterMs);
    }
  },

  async check(ctx, at, action, state) {
    const { record: rec, exec } = ctx;
    const { commands } = rec.snapshot;
    const t0 = ctx.clock.now();
    const call = state.calls[action.phase];
    const { result, claim, response, signal } = call ?? IMPLICIT_OK;
    const { run, immutability, tree } = await bracket(rec, async () => ({
      run: await checks.greenCheck(commands.test, rec.worktree, { runShell: exec.runShell }),
      // Test Immutability is asserted with the Green Check: committed tests must still match the baseline commit. A Visit
      // with no agent call changed nothing to assert.
      immutability: action.check === 'green' && call && rec.testCommits.baseline ? await ctx.testImmutability(rec.worktree, rec.testCommits.baseline, rec.snapshot.testPaths) : null,
      // The tree the Check ran on, which a publishing Action that requires it compares with the commit it publishes (T1a).
      tree: state.proc.actions.some((a) => a.requires === action.check) ? (await integrity.snapshot(rec.worktree, ctx.git)).tree : null,
    }));
    // A `tests: named` Procedure may change the tests its parameter names; any other test change is a violation.
    if (immutability && state.proc.tests?.named) {
      const named = new Set(refs.read(scopeOf(rec, at), state.proc.tests.named));
      immutability.changed = immutability.changed.filter((p) => !named.has(p));
      immutability.ok = immutability.changed.length === 0;
    }
    const evidence = checks.evidence(commands.test, run);
    state.runs[action.check] = { ...run, output: evidence.output, tree };
    const name = CHECK_NAMES[action.check];
    const checked = action.check === 'red' ? checks.redCheck(run, response?.tests ?? []) : { ok: run.passed };
    const passed = checked.ok;
    const relaxed = state.relaxed[action.check];
    if (passed || relaxed) setOutput(rec, at, { evidence });
    if (passed && !state.passed.includes(CHECK_TITLES[action.check])) state.passed.push(CHECK_TITLES[action.check]);
    const checkResults = [{ name, passed, integrity: false, ...(relaxed && { relaxed }) }];
    if (immutability) checkResults.unshift({ name: 'immutability', passed: immutability.ok, integrity: true, changed: immutability.changed });
    const r = outcome.resolve({ result: signal, claim, checks: checkResults, retries: {},
      exhausted: !recovers(state), failureOutcomes: state.proc.checkOutcome });
    return finish(ctx, at, t0, { ...r, reason: checked.reason }, { check: name,
      signals: { result: { status: result.status }, claim, checks: checkResults },
      ...(immutability && !immutability.ok && { violations: immutability.changed }) });
  },

  async commit(ctx, at, action, state) {
    const { record: rec, git, ticket } = ctx;
    const { agent } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const message = render.commitMessage({ kind: state.proc.commitKinds[action.phase], title: ticket.title, ticket: ticket.number,
      summary: state.calls[action.phase].response.summary, vertex: at.vertex, harness: agent.harness, model: agent.model, effort: agent.effort, marker: m }, ctx.publicText);
    // The outputs are recorded with the commit's completion and Event, outside the bracket so its idle save cannot publish them first.
    const committed = await bracket(rec, async () => {
      // A commit intended before a restart is replayed from its recorded tree and parent, never from what is staged now, so
      // a human edit made since stays in the worktree uncommitted. Reconciliation has held a moved branch.
      const intended = logged(rec, m, 'intent')?.payload;
      if (!intended && !await git.stageAll(rec.worktree) && action.phase === 'red') return null;
      const payload = intended ?? { message, tree: await git.writeTree(rec.worktree), parent: await git.headSha(rec.worktree) };
      const { sha } = await sideEffect(ctx, m, 'commit', payload, async (p) =>
        ({ sha: intended ? await git.commitTree(rec.worktree, p) : await git.commitStaged(rec.worktree, p.message) }), true);
      // The paths the commit changed (U2, K7); with nothing to commit there is no commit and no path.
      return { sha, files: sha ? await git.changedPaths(rec.worktree, payload.parent, sha) : [] };
    });
    if (committed) {
      const { sha, files } = committed;
      setOutput(rec, at, { files });
      // A fix commit passed Test Immutability, so its only test changes are the named ones: like red's, it is the new
      // baseline. A fix with no edits makes no commit and leaves the baseline where it was.
      if (sha && (action.phase === 'red' || action.phase === 'fix')) rec.testCommits.baseline = sha;
      if (sha && action.phase === 'red') rec.testCommits.first ??= sha;
      return effectDone(ctx, at, t0, m);
    }
    // Nothing to commit means no tests were written: the Red Check's evidence is void and no recovery Phase follows.
    setOutput(rec, at, { files: [] });
    const { result, claim, signal } = state.calls.red;
    const checkResults = [{ name: CHECK_NAMES.red, passed: false, integrity: false }];
    const r = outcome.resolve({ result: signal, claim, checks: checkResults, retries: {}, exhausted: true, failureOutcomes: state.proc.checkOutcome });
    return finish(ctx, at, t0, { ...r, reason: 'No tests were written.' }, { check: r.check,
      signals: { result: { status: result.status }, claim, checks: checkResults } });
  },

  async push(ctx, at) {
    const { record: rec, git } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    await bracket(rec, async () => {
      // The commit the record proves was checked, not HEAD: a branch changed by hand is never published.
      const sha = record.lastCommit(rec)?.evidence.sha ?? await git.headSha(rec.worktree);
      await sideEffect(ctx, m, 'push', { branch: rec.branch, sha }, async (p) => {
        await git.push(rec.worktree, p.branch, p.sha);
        const remoteSha = await git.remoteSha(rec.worktree, p.branch);
        if (remoteSha !== p.sha) throw new Error(`origin has ${p.branch} at ${remoteSha}, not the intended ${p.sha}`);
        return { remoteSha };
      }, true);
    });
    return effectDone(ctx, at, t0, m);
  },

  // The Findings Hash of this review; one equal to an earlier review's by the same Vertex in this Execution is a repeat.
  // The hash is an output of this Action, saved with its Event.
  async 'findings-hash'(ctx, at, action, state) {
    const { record: rec } = ctx;
    const t0 = ctx.clock.now();
    const { findings } = state.calls.review.response;
    const findingsHash = checks.findingsHash(findings);
    const repeat = rec.outputs.some((o) => o.vertex === at.vertex && o.action === at.action && o.visit !== at.visit && o.value.findingsHash === findingsHash);
    setOutput(rec, at, { findingsHash });
    // shortcut: repeat is flagged but routes as changes until repeat routing lands (slice 4).
    const r = { outcome: state.decided?.r.outcome ?? 'ok', direction: 'advance', row: 'effect-completed' };
    return finish(ctx, at, t0, r, repeat ? { repeat: true } : {});
  },

  async comment(ctx, at, action, state) {
    const { record: rec, gh, cwd } = ctx;
    const { agent, persona } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const body = await render.reviewComment(bind(rec, at, action).review,
      { harness: agent.harness, model: agent.model, effort: agent.effort, persona: persona.name, hash: persona.hash.slice(0, 12) }, m, ctx.publicText);
    // `target: ticket` comments on the Ticket; the review's comment goes to the PR (W5).
    const target = action.target === 'ticket' ? { kind: 'issue', number: rec.ticket } : { kind: 'pr', number: rec.pr };
    await bracket(rec, () => sideEffect(ctx, m, 'comment', { target, body, bodyHash: sha256(body) }, async (p) => {
      const url = await (p.target.kind === 'pr' ? gh.comment : gh.commentIssue)(p.target.number, p.body, cwd);
      return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
    }, true));
    return effectDone(ctx, at, t0, m);
  },

  // Creates the PR after implement, and re-renders its body after a fix or review with a provenance row per Vertex.
  async 'pr-upsert'(ctx, at, action) {
    const { record: rec, gh, ticket, cwd } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const { report, red, green } = bind(rec, at, action);
    const body = await render.prBody({ ticket, marker: m, impl: { ...report, red, green }, provenance: render.provenance(rec) }, ctx.publicText);
    const payload = { branch: rec.branch, base: ctx.base, title: ctx.publicText(ticket.title), body, bodyHash: sha256(body) };
    await bracket(rec, () => sideEffect(ctx, m, 'pr-upsert', payload, async (p) => {
      const pr = await gh.upsertPr(p, cwd);
      rec.pr = pr.number;
      return { number: pr.number, url: pr.url };
    }, true));
    return effectDone(ctx, at, t0, m);
  },

  // A publishing Action (R11d, T1a): it marks ready only the last commit the record proves pushed, and only if the Check it
  // requires passed on that commit's tree. The target is saved in the intent, so a retry or a resume publishes the same
  // commit, and each launch checks it again, with the PR's head (M1).
  async 'pr-ready'(ctx, at, action, state) {
    const { record: rec, gh, cwd } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const checked = state.runs[action.requires];
    const target = { number: rec.pr, sha: record.lastCommit(rec)?.evidence.sha ?? null, tree: checked?.passed ? checked.tree : null };
    await bracket(rec, () => sideEffect(ctx, m, 'pr-ready', target, async (p) => {
      const why = await unpublishable(ctx, p);
      if (why) throw new Decided({ next: 'hold', name: 'unchecked-publish', reason: `PR #${p.number} was not marked ready: ${why}; nothing was published.` });
      await gh.markReady(p.number, cwd);
      return {};
    }, true));
    return effectDone(ctx, at, t0, m);
  },
};

// Why the target cannot be marked ready, or null: the worktree must be clean at the commit, and the PR's head that commit
// on gg's branch in this repository. A head that cannot be read proves nothing, so it holds too.
// shortcut: the head read and GitHub's ready call are not atomic, so a push between them cannot be excluded, as with
// GitHub's own required checks; close it if GitHub gains a ready call conditioned on the head.
async function unpublishable(ctx, { sha, tree, number }) {
  const { record: rec, git, gh, cwd } = ctx;
  if (!sha) return 'the record proves no pushed commit';
  const published = await git.treeOf(rec.worktree, sha);
  if (tree !== published) return `its Check passed on tree ${tree}, not on tree ${published} of commit ${sha}`;
  const now = await integrity.snapshot(rec.worktree, git);
  if (now.head !== sha || now.index !== published || now.tree !== published) return `the worktree is not clean at commit ${sha}`;
  let pr;
  try {
    pr = await gh.viewPr(number, cwd);
  } catch (err) {
    return `its head could not be read (${String(err?.message ?? err).split('\n')[0]})`;
  }
  if (pr.isCrossRepository !== false || pr.headRefName !== rec.branch || pr.headRefOid !== sha) {
    return `its head is ${pr.headRefName} at ${pr.headRefOid}${pr.isCrossRepository === false ? '' : ' in another repository'}, not ${rec.branch} at ${sha}`;
  }
  return null;
}
