import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { layerFile } from './config.mjs';
import * as briefs from './briefs.mjs';
import * as checks from './checks.mjs';
import * as events from './events.mjs';
import * as integrity from './integrity.mjs';
import { ENDS } from './labels.mjs';
import * as marker from './marker.mjs';
import * as outcome from './outcome.mjs';
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
// A Vertex with no agent Action has the implicit Claim ok, which requires all its Checks (R11f).
const IMPLICIT_OK = { result: { status: 'completed' }, claim: { valid: true, claim: 'ok' }, response: null,
  signal: { status: 'completed', response: { claim: 'ok' }, failure: null } };
// The transition table's view of an Action's Signals: the Integrity Assertions, then the Check signals.
const resolverChecks = (integrityRows, signals) => [
  ...integrityRows.map((row) => ({ name: row.name, passed: row.passed, integrity: true })),
  ...signals.map((s) => ({ name: s.id, passed: s.state === 'passed', integrity: false })),
];
// The claimed token: the agent's, or the implicit ok of a Vertex with no agent Action (R11f).
const tokenOf = (state) => state.claims[state.response?.claim ?? 'ok'];

// A pass ends at its last Check, or at the agent call when no Check follows it (T4). There a stop token, or a Check the
// claimed token requires that failed, decides the Visit (Q3d); a failure some failing Check can recover from starts the next
// pass instead, while `recover` has passes left. A pass whose required Checks passed leaves the decision to the `passed`
// table, once every Action has run. A final failure carries the first failing Check's signal for the Terminal Reason.
function settle(rec, at, state, input) {
  const r = outcome.resolve(input);
  if (r.row !== 'claimed' || state.checkFollows) return r;
  const token = tokenOf(state);
  const failing = token.stop ? [] : token.requires.filter((id) => state.checks[id]?.state !== 'passed');
  if (!token.stop && !failing.length) return r;
  const recoverable = failing.some((id) => state.runs[id].recoverable) && state.recovery < (state.proc.recover?.max ?? 0);
  const [first] = failing;
  return { ...outcome.decide({ ...input, checks: resolverChecks([], Object.values(state.checks)), token, procedure: state.proc,
    scope: scopeOf(rec, at, state), recoverable }), ...(first && { signal: state.checks[first], reason: state.runs[first].reason, output: state.runs[first].output }) };
}
// A recovery Brief's sections: each Check that failed in the pass before, with its output and how it failed (T4b). A Check
// with no recoverBrief gets gg's own section.
const sectionsOf = (ctx, state) => state.proc.actions.filter((a) => a.do === 'check' && state.checks[a.id]?.state === 'failed')
  .map((a) => ({ name: a.recoverBrief ?? 'recover-section.md', text: a.recoverBrief ? layerFile(ctx.files, a.recoverBrief) : render.engineTemplate('recover-section.md'),
    id: a.id, kind: a.kind, command: ctx.record.snapshot.commands[a.command], ...state.runs[a.id] }));

// Where an Outcome leaves the pinned Vertex (H7): the Vertex's route for it, then the Flow's, then the Vertex's "*", then
// the Flow's, else end: needs-human (R12c). Only the Procedure's Outcomes and harness exhaustion are routable; any other
// (an Integrity Violation, a run stop, the Action Cap) ends at needs-human whatever the routes say. An end's name is the
// next cursor's Vertex, which no Vertex may take (validate.mjs).
// The effective target (U5, request 3.3): a bounded Edge counts traversals per Execution in record.traversals and, once
// `max` is reached, routes to its `exhausted` target; a Vertex whose Visits reached its `maxVisits` passes on to its own
// `exhausted` target, which wins when the Edge into it is spent too. `spent` names each Bound passed, for the Terminal
// Reason.
const NEEDS_HUMAN = { end: 'needs-human' };
const nameOf = (target) => (typeof target === 'string' ? target : target.end);
function edge(ctx, out) {
  const { record: rec, flow } = ctx;
  const { vertex, outcomes, route, routes } = rec.snapshot;
  const routable = outcomes.includes(out) || outcome.ENGINE_OUTCOMES.includes(out);
  const target = (routable && [route?.[out], routes?.[out], route?.['*'], routes?.['*']].find((t) => t !== undefined)) || NEEDS_HUMAN;
  const bound = (id) => flow.ticket.vertices[id]?.maxVisits;
  const full = (id) => !!bound(id) && (rec.visits[id] ?? 0) >= bound(id);
  const spent = [];
  let next = target.to ?? nameOf(target);
  const key = target.to && `${vertex}->${target.to}:${out}`;
  const count = key ? rec.traversals[key] ?? 0 : 0;
  if (key && count >= target.max) {
    spent.push(`its Edge to ${target.to} had used its Bound of ${target.max} traversal${target.max === 1 ? '' : 's'}`);
    if (!full(target.to)) next = nameOf(target.exhausted);
  }
  // Admission rejects a loop of spent Vertices (H12); a run that meets one anyway ends at needs-human.
  for (const seen = new Set(); full(next); seen.add(next)) {
    if (seen.has(next)) return { next: 'needs-human', spent };
    spent.push(`${next} had used its Bound of ${bound(next)} Visit${bound(next) === 1 ? '' : 's'}`);
    next = nameOf(flow.ticket.vertices[next].exhausted);
  }
  return next === target.to ? { next, key, count: count + 1, spent } : { next, spent };
}
// A spent Bound's clause in a Terminal Reason, naming where the route went instead.
const spentText = (e) => (e.spent.length ? `, and ${e.spent.join(' and ')}, so the route ended at ${e.next}` : '');

// Takes the Edge; the count is saved with the next Vertex's entry, before it runs, so a restart routes the same way.
function traverse(ctx, out) {
  const e = edge(ctx, out);
  if (e.key) ctx.record.traversals[e.key] = e.count;
  return e;
}

// The Action Cap (request 3.3, V1): a Flow Attempt past it never runs, and the Execution ends at needs-human, whatever
// any Bound says. record.attempts counts the Flow's Attempts entered, the refused one included, so a restart refuses it
// again; engine reporting is not counted and still runs.
const capped = (ctx) => (ctx.record.attempts > ctx.flow.actionCap
  ? { outcome: 'needs-human', direction: 'stop', row: 'action-cap', rule: { table: 'fixed', row: 'action-cap' }, cap: ctx.flow.actionCap } : null);

// An Action's outputs (W2), one entry per Vertex, Visit and Action in Visit order. A recovery pass of the Action, or a
// resumed one, replaces its fields, so a reference reads the Action's last pass.
function setOutput(rec, at, value) {
  const entry = rec.outputs.find((o) => o.vertex === at.vertex && o.visit === at.visit && o.action === at.action);
  if (entry) Object.assign(entry.value, value);
  else rec.outputs.push({ vertex: at.vertex, visit: at.visit, action: at.action, value });
}

// Each input at Visit entry (S4, T6): the value from the latest Visit that produced any of its sources, with that
// Vertex, Visit and Action. An optional input none produced is absent (T10); a required one stops the Execution, which
// admission prevents by checking inputs on every route (Q7, H1-H4), so this is a backstop.
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

// What a Check parameter, a `with`, a rule or a template may name (U1, W2): the Vertex's own outputs by Action id, its
// inputs, the agent's response and Claim token, the pass (Recovery Number + 1, T4d) and each Check's state (`checks`, when
// given, are the states to read).
function scopeOf(rec, at, state, checks = state.checks) {
  return { ...record.visitScope(rec, at), response: state.response, claim: state.response?.claim ?? 'ok',
    pass: state.recovery + 1, check: Object.fromEntries(Object.values(checks).map((s) => [s.id, s.state])) };
}
const bind = (rec, at, action, state) => Object.fromEntries(Object.entries(action.with ?? {}).map(([name, ref]) => [name, refs.read(scopeOf(rec, at, state), ref)]));

// R1b: a Check counts only on the tree it checked, so a pass on an older tree reads as failed. A response or repeat Check
// reads no tree and never goes stale, so the worktree is read only when a signal has one (a git process: bracket it).
async function fresh(ctx, signals) {
  if (!signals.some((s) => s.tree)) return signals;
  const { tree } = await integrity.snapshot(ctx.record.worktree, ctx.git);
  return signals.map((s) => (s.tree && s.tree !== tree && s.state === 'passed' ? { ...s, state: 'failed' } : s));
}

const rollbackSet = (ctx, rec, baseline) => integrity.rollbackSet(baseline, ctx.protectedPaths, checks.testPathSet(rec.snapshot.testPaths));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// An agent Action's Session, which its recovery passes and retries resume.
const sessionKey = (at) => `${at.vertex}/${at.visit}/${at.action}`;

// An Integrity Violation leaves nothing behind and tells the next Brief why. Rollback is limited to what this Visit's
// agent made (request 3.5); the History item is saved with the reset's evidence, so Reconciliation adds it exactly once.
// It also passes what git clean leaves (integrity.rollbackSet), saved in the intent so a crash after the reset can still
// finish the restore.
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
    ticket: rec.ticket, run: ctx.run, execution: rec.execution, attempt: 1, durationMs: clock.now() - t0, ...at, ...fields,
  });
  ctx.markerOf = (at) => marker.formatMarker({ execution: rec.execution, run: rec.run, attempt: 1, ...at });
  ctx.enter = async (at) => {
    const c = rec.cursor;
    // A resume re-entering the cursor's own Action continues at its Attempt.
    const same = c.vertex === at.vertex && c.visit === at.visit && c.action === at.action && c.recovery === at.recovery;
    const attempt = at.attempt ?? (same ? c.attempt : 1);
    // A Flow Action (one with a Procedure) counts each new Attempt toward the Action Cap; a resumed one is not new.
    if (at.procedure && !(same && attempt === c.attempt)) rec.attempts = (rec.attempts ?? 0) + 1;
    rec.cursor = { vertex: at.vertex, visit: at.visit, action: at.action, recovery: at.recovery, attempt };
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
    const { agent, access, procedure, outcomes, route, inputs } = flow.ticket.vertices[vertexId];
    // The Persona's bytes from the Layer that names it; a Vertex without an Agent (publish) pins none.
    const bytes = agent && layerFile(ctx.files, agent.persona);
    // A copy of everything the Visit reads, so a Flow or command edited mid-Visit cannot reach its Actions, Checks or routing.
    // The Procedure is pinned by name and hash (S6): Reconciliation holds a resumed Visit whose Procedure changed.
    rec.snapshot = structuredClone({ vertex: vertexId, visit, agent, access, procedure: { name: procedure, hash: flow.procedures[procedure].hash },
      outcomes, route: route ?? null, routes: flow.ticket.routes ?? null, inputs: resolveInputs(rec, vertexId, inputs),
      commands: ctx.commands, testPaths: ctx.testPaths, persona: agent && { name: basename(agent.persona), bytes, hash: sha256(bytes) } });
    // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry; log it against the Config Hash when gg run reloads between Vertices (#184).
    await record.save(rec);
  }
  const snap = rec.snapshot;
  const proc = flow.procedures[snap.procedure.name];

  // A rollback (an Integrity Violation) is safe only when the agent made every change (request 3.5), and any
  // Vertex's agent may cause one whatever its access, so every Vertex starts only on a clean worktree or one an open intent
  // explains, as at admission (R2d); anything else is Held before any agent runs.
  if (!resuming && await bracket(rec, () => reconcile.dirtyState(rec, { git: ctx.git, worktree: rec.worktree, integrity: ctx.integrity }))) {
    rec.history.push({ kind: 'held', text: `The worktree had uncommitted changes before ${vertexId}; nothing was deleted.` });
    return { next: 'needs-human', stop: { outcome: 'needs-human', response: null, at: null }, reason: { decidedBy: { hold: 'dirty-worktree' },
      outcome: null, rule: null, text: `The worktree had uncommitted changes before ${vertexId}, so no agent ran and nothing was deleted.` } };
  }
  const { actions, claims } = proc;
  // Saved with the record, so a restart has the agent call and Check runs the remaining Actions read.
  // `call` is the agent Action's latest Attempt, `checks` each Check's latest signal, `runs` what the recovery Brief and the
  // Terminal Reason read.
  const state = rec.visitState = resuming ? rec.visitState : { recovery: 0, call: null, runs: {}, checks: {} };
  // Not enumerable, so the Procedure's data stays out of the saved record.
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  Object.defineProperty(state, 'claims', { value: claims, enumerable: false });
  const agent = actions.findIndex((a) => a.do === 'agent');
  let last = null;
  for (let i = resuming ? actions.findIndex((a) => a.id === rec.cursor.action) : 0; i < actions.length; i++) {
    const action = actions[i];
    // Every Action carries the Recovery Number of its pass.
    const at = { vertex: vertexId, visit, procedure: snap.procedure.name, action: action.id, recovery: state.recovery };
    await ctx.enter(at);
    state.checkFollows = actions.slice(i + 1).some((a) => a.do === 'check');
    // A result saved before a crash is routed again; its Action is not rerun, as a stop's rollback may have removed the work.
    const settled = state.settled?.action === at.action && state.settled.recovery === at.recovery ? state.settled.r : null;
    const r = settled ?? runStopped(ctx) ?? capped(ctx) ?? await KINDS[action.do](ctx, at, action, state);
    // A run stop routed again from its saved result still stops the other Executions.
    if (r.row === 'run-stop' && ctx.runState) ctx.runState.stop ??= { failureClass: r.failureClass, ticket: rec.ticket };
    last = { at, r };
    // The next pass resumes the agent's Session, then every Check runs again (T4a, R1a).
    if (r.row === 'recover') {
      state.recovery += 1;
      i = agent - 1;
      continue;
    }
    if (r.direction === 'advance') continue;
    const out = r.outcome;
    if (!settled) {
      state.settled = { action: at.action, recovery: at.recovery, r };
      await record.save(rec);
    }
    // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4): an
    // agent Attempt's violation, Test Immutability included, rolls back to that Attempt's baseline. The call's own marker is
    // complete, so its rollback is an Action of its own. A failure routed to an end leaves the work in place for the human
    // (U10).
    if (r.row === 'integrity-violation') {
      const { baseline } = state.call;
      await discard(ctx, { ...at, action: 'reset', attempt: r.attempt }, baseline.head, { kind: 'integrity violation',
        text: `Attempt ${r.attempt} of ${whereOf(at)} changed ${r.surfaces.join(' and ')}; the worktree was restored to its baseline head.` },
      { untracked: rollbackSet(ctx, rec, baseline) });
    }
    // A Check's reason can quote agent-reported test names, so it is posted fenced, never in the reason text; a Check
    // with no reason of its own (a failing command) posts its output.
    const detail = r.signal && r.rule.table === 'failed' ? r.reason ?? r.output : null;
    const e = traverse(ctx, out);
    const text = stopText(at, out, r);
    return { next: e.next,
      stop: { outcome: out, response: state.response, at, ...(detail && { detail }), ...(r.rule.table === 'stopped' && { stopped: true, comment: tokenOf(state)?.comment }),
        ...(out === 'run-stop' && { failureClass: r.failureClass }) },
      reason: terminalReason(at, r.outcome, r, e.spent.length ? `${text.replace(/\.$/, '')}${spentText(e)}.` : text) };
  }
  // The Visit's Outcome (Q3d): its required Checks passed, so the first `passed` row that matches, else `otherwise`, else the
  // Claim token; a Check counts only on the current tree.
  const { at } = last;
  const signals = Object.values(state.checks);
  const checked = proc.passed.length && signals.some((s) => s.tree) ? await bracket(rec, () => fresh(ctx, signals)) : signals;
  const { claim, signal } = state.call ?? IMPLICIT_OK;
  const { outcome: out, rule } = outcome.decide({ result: signal, claim, checks: resolverChecks([], checked), retries: {}, token: tokenOf(state),
    procedure: proc, scope: scopeOf(rec, at, state, checked) });
  const e = traverse(ctx, out);
  const passed = checked.filter((s) => s.state === 'passed').map((s) => s.id);
  const text = out !== 'ok' ? `${vertexId} visit ${visit} completed every ${snap.procedure.name} Action with outcome ${out}${spentText(e)}.`
    : `${vertexId} visit ${visit} completed every ${snap.procedure.name} Action${passed.length ? `: ${passed.join(' and ')} passed` : ''}.`;
  return { next: e.next, stop: null, reason: terminalReason(at, out, { rule }, text) };
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

// One Attempt of the agent Action: `resume` and `nudge` come from the Attempt before it, if any.
async function callAttempt(ctx, at, action, state, { resume, nudge }) {
  const { record: rec, ticket, base, git } = ctx;
  const m = ctx.markerOf(at);
  // A completed Attempt is never run again; runVisit routes every saved result but a retry's, which ends up here.
  if (logged(rec, m, 'complete')) return logged(rec, m, 'evidence').evidence;
  const harness = ctx.harnessOf();
  // Each call gets its own copy: a Harness that edits its call must not change the next one.
  const { agent, access, persona, commands } = structuredClone(rec.snapshot);
  // A recovery pass gets the recovery Brief with a section for each Check that failed in the pass before it (T4b); a parse
  // retry gets gg's own nudge.
  const recovering = at.recovery > 0 && !nudge;
  const sections = recovering ? sectionsOf(ctx, state) : undefined;
  const name = recovering ? state.proc.recover.brief : action.brief;
  const brief = await (recovering ? briefs.recoveryBrief : briefs.brief)(nudge ? 'nudge.md' : name, nudge ? render.engineTemplate('nudge.md') : layerFile(ctx.files, name), {
    ...scopeOf(rec, at, state), ticket, base, commands, history: rec.history, sections, reason: nudge,
    // The branch diff and every test file changed since the Execution's first test commit, including a fix's named ones,
    // read git only for a Brief that names them.
    diff: () => bracket(rec, () => git.branchDiff(rec.worktree, base)),
    changedTestFiles: async () => (await bracket(rec, () => ctx.testImmutability(rec.worktree, rec.testCommits.first, rec.snapshot.testPaths))).changed });
  // `access` is the Vertex's, which the validator resolved (H9): read-only unless its Agent allows more and its Procedure
  // does not cap it. The Phase is the agent Action's id, and a recovery pass's call is the Phase recover.
  const schema = JSON.parse(layerFile(ctx.files, action.schema));
  const call = {
    marker: m, vertex: at.vertex, visit: at.visit, phase: at.recovery ? 'recover' : action.id, attempt: at.attempt, agent, persona, brief, schema, cwd: rec.worktree,
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
    // R3: a write Vertex's agent keeps every committed test as the last gg commit has it, or the Execution base before any;
    // a Procedure that writes tests is not held to it, and `tests: named` frees the tests its reference names.
    if (access !== 'read-only' && state.proc.tests !== 'write') {
      let { ok, changed } = await ctx.testImmutability(rec.worktree, rec.testCommits.baseline ?? baseline.head, rec.snapshot.testPaths);
      if (state.proc.tests?.named) {
        const named = new Set(refs.read({ ...record.visitScope(rec, at), response: out.response }, state.proc.tests.named) ?? []);
        changed = changed.filter((p) => !named.has(p));
        ok = changed.length === 0;
      }
      if (!ok) violations.push({ worktree: rec.worktree, surface: 'committed tests', before: null, after: changed });
    }
    return { ...out, violations, baseline };
  });
  rec.sessions[sessionKey(at)] = { sessionId: result.sessionId, harness: agent.harness, personaHash: persona.hash,
    transcriptPath: result.transcriptPath, usage: result.usage.cumulative,
    vertex: at.vertex, model: agent.model, effort: agent.effort, persona: persona.name };
  const claim = briefs.validateResponse(call.schema, response);
  if (claim.valid) setOutput(rec, at, { response });
  // The transition table reads the three Signals of a call as one flat result.
  state.call = { result, claim, response, baseline, signal: { status: result.status, response, failure } };
  state.response = response;
  const integrityRows = [{ name: 'integrity', passed: violations.length === 0, violations }];
  const key = marker.actionKeyOf(at);
  const r = settle(rec, at, state, { result: state.call.signal, claim, checks: resolverChecks(integrityRows, []), retries: rec.retries[key] ?? {} });
  // A retry spends its budget in the Attempt's completion, so a resumed Action never spends it twice.
  if (r.retryKind) (rec.retries[key] ??= {})[r.retryKind] = (rec.retries[key][r.retryKind] ?? 0) + 1;
  // A violation always stops (integrity-violation is the first row), so runVisit rolls it back with the other stops.
  const surfaces = violations.length ? [...new Set(violations.map((v) => v.surface))] : null;
  const done = { ...r, sessionId: result.sessionId, reason: claim.reason, surfaces, attempt: at.attempt };
  return finish(ctx, at, t0, done, {
    agent: true, harness: agent.harness, cliVersion: null, model: agent.model, effort: agent.effort, personaHash: persona.hash,
    tools: call.tools, init: result.init, sessionId: result.sessionId, lineage: at.recovery ? action.id : null,
    transcriptPath: result.transcriptPath, usage: result.usage, exitCode: result.exitCode, signal: result.signal,
    finalEventSubtype: result.finalEventSubtype, permissionDenials: result.permissionDenials, commandsRun: result.commandsRun,
    failureClass: r.failureClass, outcome: r.outcome, direction: r.direction, rule: r.rule,
    signals: { result: { status: result.status, failureClass: r.failureClass }, claim, checks: [], integrity: integrityRows },
    ...(violations.length && { violations }),
  }, m, { ...done, usage: result.usage.delta });
}

// Each Action kind (procedures.ACTION_KEYS) by its `do`.
const KINDS = {
  // Attempt retries (parse, timeout, transient) stay inside the Action: each is a new attempt of the same (action, recovery).
  async agent(ctx, at, action, state) {
    const { record: rec } = ctx;
    const harness = ctx.harnessOf();
    // A recovery pass resumes its agent Action's own Session.
    const parent = at.recovery ? rec.sessions[sessionKey(at)] : null;
    let resume = parent?.sessionId ?? null;
    // A Session cannot be resumed without its transcript, so the pass starts fresh, with the recovery Brief.
    if (parent && !(parent.transcriptPath && existsSync(parent.transcriptPath))) {
      ctx.log(`#${rec.ticket} ${marker.actionKeyOf(at)}: the ${action.id} transcript is missing, so recovery ${at.recovery} starts a fresh Session`);
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
        const over = capped(ctx);
        if (over) return over;
      }
      const r = await callAttempt(ctx, { ...at, attempt }, action, state, { resume, nudge });
      if (r.direction !== 'retry') return r;
      if (r.retryAfterMs) await ctx.clock.sleep(r.retryAfterMs);
    }
  },

  // A declared Check (R1, R4): its kind checks, and its result is the Check signal { id, kind, state, tree }. Evidence is an
  // output only when it passed (N9); a failure's output reaches the recovery Brief and the Terminal Reason instead.
  async check(ctx, at, action, state) {
    const { record: rec } = ctx;
    const t0 = ctx.clock.now();
    const { result, claim, signal } = state.call ?? IMPLICIT_OK;
    const kind = CHECKS[action.kind];
    const work = async () => {
      const tree = kind.tree ? (await integrity.snapshot(rec.worktree, ctx.git)).tree : null;
      const out = { ...await kind.run(ctx, at, action, state, tree), tree };
      // A Check must leave the tree it checked as it found it (T1b).
      if (out.ran && tree && (await integrity.snapshot(rec.worktree, ctx.git)).tree !== tree) {
        Object.assign(out, { passed: false, recoverable: false, failure: null, reason: `The ${action.kind} Check ${action.id} changed the worktree, so its result does not count.` });
      }
      return out;
    };
    // Only a worktree Check starts processes in the worktree, so only it is bracketed (request 3.6).
    const checked = kind.tree ? await bracket(rec, work) : await work();
    const s = { id: action.id, kind: action.kind, state: checked.passed ? 'passed' : 'failed', tree: checked.tree };
    if (action.reuse === 'tree' && checked.ran) {
      record.saveCheckResult(rec.commonDir, { tree: s.tree, command: checked.evidence.command, state: s.state, marker: ctx.markerOf(at), output: checked.output });
    }
    state.checks[action.id] = s;
    // `recoverable: false` on the Check opts out of its kind's recoverable failures (T4c).
    state.runs[action.id] = { output: checked.output, reason: checked.reason, failure: checked.failure ?? null,
      recoverable: !checked.passed && !!checked.recoverable && action.recoverable !== false };
    if (checked.passed && checked.evidence) setOutput(rec, at, { evidence: checked.evidence });
    // A failing pass drops an earlier pass's evidence, so nothing reads a pass the last one contradicts (N9).
    else if (!checked.passed) delete rec.outputs.find((o) => o.vertex === at.vertex && o.visit === at.visit && o.action === at.action)?.value.evidence;
    if (checked.outputs) setOutput(rec, at, checked.outputs);
    // A failure's output is diagnosis, not proof: it travels with the signal on the Event and to the Terminal comment (N9).
    const output = s.state === 'failed' ? checked.output : undefined;
    const r = settle(rec, at, state, { result: signal, claim, checks: resolverChecks([], [s]), retries: {} });
    return finish(ctx, at, t0, { reason: checked.reason, signal: s, ...(output && { output }), ...r }, { check: action.id,
      signals: { result: { status: result.status }, claim, checks: [{ ...s, ...(output && { output }) }], integrity: [] } });
  },

  async commit(ctx, at, action, state) {
    const { record: rec, git, ticket } = ctx;
    const { agent } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const { result, claim, signal, response } = state.call;
    const message = render.commitMessage({ kind: action.type, title: ticket.title, ticket: ticket.number,
      summary: response.summary, vertex: at.vertex, harness: agent.harness, model: agent.model, effort: agent.effort, marker: m }, ctx.publicText);
    // The outputs are recorded with the commit's completion and Event, outside the bracket so its idle save cannot publish them first.
    const committed = await bracket(rec, async () => {
      // A commit intended before a restart is replayed from its recorded tree and parent, never from what is staged now, so
      // a human edit made since stays in the worktree uncommitted. Reconciliation has held a moved branch.
      const intended = logged(rec, m, 'intent')?.payload;
      // A commit counts only the required Checks that passed on the tree it would commit (R1b, S2).
      const stale = intended ? [] : (await fresh(ctx, tokenOf(state).requires.map((id) => state.checks[id]))).filter((s) => s.state !== 'passed');
      if (stale.length) return { stale };
      if (!intended) await git.stageAll(rec.worktree);
      const payload = intended ?? { message, tree: await git.writeTree(rec.worktree), parent: await git.headSha(rec.worktree) };
      const { sha } = await sideEffect(ctx, m, 'commit', payload, async (p) =>
        ({ sha: intended ? await git.commitTree(rec.worktree, p) : await git.commitStaged(rec.worktree, p.message) }), true);
      // The paths the commit changed (U2, K7); with nothing to commit it is a no-op with no path.
      return { sha, files: sha ? await git.changedPaths(rec.worktree, payload.parent, sha) : [] };
    });
    if (committed.stale) {
      const [s] = committed.stale;
      const r = outcome.decide({ result: signal, claim, checks: resolverChecks([], committed.stale), retries: {}, token: tokenOf(state), procedure: state.proc,
        scope: scopeOf(rec, at, state, { ...state.checks, ...Object.fromEntries(committed.stale.map((c) => [c.id, c])) }) });
      return finish(ctx, at, t0, { ...r, reason: `The ${s.kind} Check ${s.id} passed on tree ${s.tree}, which is no longer the worktree's, so nothing was committed.`, signal: s },
        { check: s.id, signals: { result: { status: result.status }, claim, checks: committed.stale, integrity: [] } });
    }
    const { sha, files } = committed;
    setOutput(rec, at, { files });
    // R3c: every gg commit is the new Test Immutability baseline, since each passed it or wrote tests. R3d: the first test
    // commit is the first that changed a path under testPaths. A commit with nothing to commit moves neither.
    if (sha) rec.testCommits.baseline = sha;
    if (sha && files.some(checks.testPathMatcher(rec.snapshot.testPaths))) rec.testCommits.first ??= sha;
    return effectDone(ctx, at, t0, m);
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

  async comment(ctx, at, action, state) {
    const { record: rec, gh, cwd } = ctx;
    const { agent, persona } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    // A Procedure with no agent Action has no Agent to name.
    const body = await render.publicBody(layerFile(ctx.files, action.body), { ...scopeOf(rec, at, state),
      ...(agent && { agent: { harness: agent.harness, model: agent.model, effort: agent.effort, persona: persona.name, hash: persona.hash.slice(0, 12) } }) },
    m, ctx.publicText);
    // `target: ticket` comments on the Ticket; the review's comment goes to the PR (W5).
    const target = action.target === 'ticket' ? { kind: 'issue', number: rec.ticket } : { kind: 'pr', number: rec.pr };
    await bracket(rec, () => sideEffect(ctx, m, 'comment', { target, body, bodyHash: sha256(body) }, async (p) => {
      const url = await (p.target.kind === 'pr' ? gh.comment : gh.commentIssue)(p.target.number, p.body, cwd);
      return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
    }, true));
    return effectDone(ctx, at, t0, m);
  },

  // Creates the PR after implement, and re-renders its body after a fix or review with a provenance row per Vertex.
  async 'pr-upsert'(ctx, at, action, state) {
    const { record: rec, gh, ticket, cwd } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    // A `with` name shadows the scope's own (implement's `green` is its agent Action's output).
    const body = await render.publicBody(layerFile(ctx.files, action.body), { ...scopeOf(rec, at, state), ...bind(rec, at, action, state), ticket,
      provenance: () => render.provenance(rec) }, m, ctx.publicText);
    const payload = { branch: rec.branch, base: ctx.base, title: ctx.publicText(ticket.title), body, bodyHash: sha256(body) };
    await bracket(rec, () => sideEffect(ctx, m, 'pr-upsert', payload, async (p) => {
      const pr = await gh.upsertPr(p, cwd);
      rec.pr = pr.number;
      return { number: pr.number, url: pr.url };
    }, true));
    return effectDone(ctx, at, t0, m);
  },

  // A publishing Action (R11d, T1a): it marks ready only the last commit the record proves pushed, and only if every
  // worktree Check the claimed token requires passed on that commit's tree. The target is saved in the intent, so a retry
  // or a resume publishes the same commit, and each launch checks it again, with the PR's head (M1).
  async 'pr-ready'(ctx, at, action, state) {
    const { record: rec, gh, cwd } = ctx;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const checked = tokenOf(state).requires.map((id) => state.checks[id]).filter((c) => c?.tree);
    const [first] = checked;
    const tree = first && checked.every((c) => c.state === 'passed' && c.tree === first.tree) ? first.tree : null;
    const target = { number: rec.pr, sha: record.lastCommit(rec)?.evidence.sha ?? null, tree };
    await bracket(rec, () => sideEffect(ctx, m, 'pr-ready', target, async (p) => {
      const why = await unpublishable(ctx, p);
      if (why) throw new Decided({ next: 'hold', name: 'unchecked-publish', reason: `PR #${p.number} was not marked ready: ${why}; nothing was published.` });
      await gh.markReady(p.number, cwd);
      return {};
    }, true));
    return effectDone(ctx, at, t0, m);
  },
};

// The Check kinds (procedures.CHECK_KEYS; R4, U13, T4c). `run` returns whether the Check passed and, on a failure,
// whether a recovery pass can fix it (and, for a kind with several such failures, which: `failure`), with its reason and
// output; `ran` when it ran a command. A `tree` kind reads the worktree, so its result holds only on the tree it checked
// (R1b); the others read the agent's response.
const commandLine = (ctx, action) => ctx.record.snapshot.commands[action.command];
const CHECKS = {
  // A Declared Command's exit. With `reuse: tree`, a pass this repository recorded for the same tree and command line
  // stands in for the run, and its output says which run (L8, L13); a failure is never reused.
  command: { tree: true, async run(ctx, at, action, state, tree) {
    const line = commandLine(ctx, action);
    const reused = action.reuse === 'tree' ? record.reusablePass(ctx.record.commonDir, tree, line) : null;
    if (reused) {
      const output = `Reused the passing run of ${reused.marker} on this tree.\n${reused.output}`;
      return { passed: true, ran: false, output, evidence: { command: line, output } };
    }
    const run = await checks.greenCheck(line, ctx.record.worktree, { runShell: ctx.exec.runShell });
    const evidence = checks.evidence(line, run);
    // A non-zero exit is recoverable; a timeout or a command that could not start is not (T4c).
    return { passed: run.passed, ran: true, recoverable: !run.timedOut && run.code !== null && run.code !== 127, output: evidence.output, evidence };
  } },
  // The named tests fail before implementation. A test file under testPaths must have changed since the Visit's baseline,
  // added, modified, deleted or renamed, untracked included; if none did, the command is not run (U2, K7, V8).
  'tests-fail': { tree: true, async run(ctx, at, action, state) {
    const { record: rec, git } = ctx;
    const { testPaths } = rec.snapshot;
    const tracked = (await git.changedSince(rec.worktree, state.first?.head ?? await git.headSha(rec.worktree))).filter(checks.testPathMatcher(testPaths));
    // An untracked test, ignored ones included, counts only if it differs from the baseline's: build output left under a
    // test glob before the Visit is not a test written in it.
    const before = state.first?.tests ?? {};
    const now = await integrity.untrackedFiles(rec.worktree, checks.testPathSet(testPaths), git);
    const untracked = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((p) => !integrity.sameFile(before[p], now[p]));
    if (!tracked.length && !untracked.length) {
      return { passed: false, ran: false, recoverable: true, failure: 'unchanged', reason: "No file under testPaths changed since the Visit's baseline, so no test was written." };
    }
    const line = commandLine(ctx, action);
    const run = await checks.greenCheck(line, rec.worktree, { runShell: ctx.exec.runShell });
    const red = checks.redCheck(run, refs.read(scopeOf(rec, at, state), action.names) ?? []);
    // A pass found by the test's name alone, with no per-test statuses, says so for the reviewer (J8).
    const evidence = { ...checks.evidence(line, run), ...(red.ok && red.heuristic && { heuristic: true }) };
    // Named tests that passed, or that the output does not name, are recoverable (T4c, N5); a timeout or a runner that
    // could not start is not.
    return { passed: red.ok, ran: true, recoverable: !!red.failure, failure: red.failure ?? null, reason: red.reason, output: evidence.output, evidence };
  } },
  // Conditions on the agent's response, `all-of` passing when each holds (R4a, P5d).
  response: { tree: false, async run(ctx, at, action, state) {
    const { passed, reasons } = checks.responseCheck(state.response, action);
    return { passed, ran: false, reason: reasons.join('\n') || undefined };
  } },
  // Fails when the list repeats one an earlier Visit of this Vertex recorded in this Execution (R4c); its hash is an output.
  repeat: { tree: false, async run(ctx, at, action, state) {
    const hash = checks.findingsHash(refs.read(scopeOf(ctx.record, at, state), action.list) ?? [], action.fields);
    const repeat = ctx.record.outputs.some((o) => o.vertex === at.vertex && o.action === at.action && o.visit !== at.visit && o.value.findingsHash === hash);
    return { passed: !repeat, ran: false, outputs: { findingsHash: hash } };
  } },
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
