import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import * as briefs from './briefs.mjs';
import * as checks from './checks.mjs';
import * as events from './events.mjs';
import * as integrity from './integrity.mjs';
import * as marker from './marker.mjs';
import * as outcome from './outcome.mjs';
import * as procedures from './procedures.mjs';
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
  const payload = { baseline, history, ...extra };
  await bracket(rec, () => sideEffect(rec, ctx.markerOf(at), 'reset', payload, async () => {
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
  try {
    return await fn();
  } finally {
    await integrity.markIdle(rec);
  }
}

async function sideEffect(rec, m, action, payload, effect) {
  await record.intent(rec, m, action, payload);
  const evidence = await effect();
  await record.evidence(rec, m, evidence);
  await record.complete(rec, m);
  return evidence;
}

export async function runExecution(opts) {
  const { flow, record: rec, events: ev, clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } } = opts;
  const ctx = { ...opts, clock };

  // Records one Action Event; `at` is the Action's identity (with its attempt), `fields` its outcome and payload.
  ctx.emit = (at, t0, fields) => ev('action', {
    flow: flow.name, configHash: rec.configHash, launchProfile: null, confinement: opts.harness.capabilities.confinement,
    ticket: rec.ticket, run: rec.run, execution: rec.execution, attempt: 1, durationMs: clock.now() - t0, ...at,
    ...(at.procedure && rec.snapshot?.options?.requireTestPass === false && { requireTestPass: false }), ...fields,
  });
  ctx.markerOf = (at) => marker.formatMarker({ execution: rec.execution, run: rec.run, attempt: 1, ...at });
  ctx.enter = async (at) => {
    rec.cursor = { vertex: at.vertex, visit: at.visit, phase: at.phase, ordinal: at.ordinal, attempt: at.attempt ?? 1 };
    await record.save(rec);
  };

  let stop = null;
  // An account failure stops the whole run even when reporting it faults, so the caller can still stop every ticket.
  const withRunStop = (end) => (stop?.outcome === 'run-stop' ? { ...end, runStop: { failureClass: stop.failureClass } } : end);
  try {
    let next = flow.ticket.entry;
    let reason = null;
    while (!TERMINALS.includes(next)) ({ next, stop, reason } = await runVisit(ctx, next));
    rec.cursor = { vertex: next, visit: null, phase: null, ordinal: 0, attempt: 1 };
    // Saved with the terminal cursor, before any Terminal side effect, so a crash inside the Terminal keeps it.
    rec.terminalReason = next === 'done' ? { ...reason, text: `${reason.text} PR #${rec.pr} is ready for review.` } : reason;
    await record.save(rec);
    return withRunStop(await terminal(ctx, next, stop));
  } catch (err) {
    if (err instanceof CrashError) throw err;
    return withRunStop(await fault(ctx, err));
  }
}

// An unexpected fault is never retried: the ticket goes to needs-human with the error, and the record is marked.
async function fault(ctx, err) {
  const rec = ctx.record;
  const error = err?.message || String(err) || 'unknown error';
  const { vertex, visit, phase, ordinal } = rec.cursor;
  rec.state = 'fault';
  rec.cursor = { vertex: 'needs-human', visit: null, phase: null, ordinal: 0, attempt: 1 };
  rec.terminalReason = { decidedBy: { vertex, visit, phase, ordinal }, outcome: null, rule: null,
    text: `An unexpected fault stopped the Execution at ${phase ? `${phase} ${ordinal}` : vertex}; the error is in this comment and on ticket_end.` };
  await record.save(rec);
  return { ...await terminal(ctx, 'needs-human', { outcome: 'fault', detail: error }, error), fault: true };
}

async function runVisit(ctx, vertexId) {
  const { flow, record: rec } = ctx;
  const vertex = flow.ticket.vertices[vertexId];
  const visit = rec.visits[vertexId] = (rec.visits[vertexId] ?? 0) + 1;
  // shortcut: the Persona is read from the node's path as given; Layer resolution arrives with T19.
  const bytes = await readFile(vertex.node.persona, 'utf8');
  // A copy of everything the Visit reads, so a Flow or command edited mid-Visit cannot reach its Actions, Checks or routing.
  rec.snapshot = structuredClone({ vertex: vertexId, visit, node: vertex.node, procedure: vertex.procedure, options: vertex.options,
    then: vertex.then ?? null, route: vertex.route ?? null, commands: ctx.commands,
    persona: { name: basename(vertex.node.persona), bytes, hash: sha256(bytes) } });
  // shortcut: nothing reloads configuration mid-Execution yet, so a change is not detected or logged at Vertex entry; log it against the Config Hash when gg run reloads between Vertices (T20).
  await record.save(rec);
  const snap = rec.snapshot;
  const proc = procedures.PROCEDURES[snap.procedure];

  // A failed red is rolled back to the baseline, which is safe only when the agent made every change (request 3.5):
  // unknown uncommitted changes are Held before any agent runs, and nothing is deleted.
  if (proc.actions.some((a) => a.phase === 'red') && !await bracket(rec, () => integrity.isCleanAt(rec.worktree, 'HEAD'))) {
    rec.history.push({ kind: 'held', text: 'The worktree had uncommitted changes before red; nothing was deleted.' });
    return { next: 'needs-human', stop: { outcome: 'needs-human', response: null, at: null }, reason: { decidedBy: { hold: 'dirty-worktree' },
      outcome: null, rule: null, text: 'The worktree had uncommitted changes before red, so no agent ran and nothing was deleted.' } };
  }
  const described = procedures.describe(snap.procedure, snap.options);
  const state = { proc, lineage: described.lineage, calls: {}, runs: {}, passed: [],
    relaxed: Object.fromEntries(described.checks.map((c) => [c.name, c.relaxed])) };
  let last = null;
  for (const [i, action] of described.actions.entries()) {
    if (action.when && !WHEN[action.when]?.(state)) continue;
    const at = { vertex: vertexId, visit, procedure: snap.procedure, phase: action.phase, ordinal: action.ordinal };
    await ctx.enter(at);
    state.next = described.actions[i + 1];
    const r = await KINDS[action.kind](ctx, at, action, state);
    last = { at, r };
    // check-failed fires only when a recovery Phase runs next (see `exhausted`), so the Visit continues into it.
    if (r.direction === 'advance' || r.row === 'check-failed') continue;
    // A stop Claim waits for its Phase's Check, so every Check still runs and is recorded with it (request 3.4).
    if (action.kind === 'call' && STOP_CLAIMS.includes(r.outcome) && state.next?.kind === 'check') continue;
    const out = r.outcome;
    if (out === 'red-failed') await discard(ctx, at, state.baseline, { kind: 'red phase failed', text: r.reason });
    // A Check's Integrity Violation (Test Immutability) is the preceding call's doing, so it rolls back to that Attempt's baseline.
    if (r.row === 'integrity-violation' && !r.surfaces) {
      const { baseline } = state.calls[at.phase];
      await discard(ctx, at, baseline.head, { kind: 'integrity violation',
        text: `${at.phase} ${at.ordinal} found a changed committed test; the worktree was restored to the baseline head of ${at.phase}.` }, { untracked: rollbackSet(baseline) });
    }
    // shortcut: misscoped takes the needs-human default too until the replan Terminal lands (T17).
    // The Red Check's diagnosis can quote agent-reported test names, so it is posted fenced, never in the reason text.
    return { next: snap.route?.[out] ?? 'needs-human',
      stop: { outcome: out, response: state.response, at, ...(out === 'red-failed' && { detail: r.reason }),
        ...(out === 'run-stop' && { failureClass: r.failureClass }) },
      reason: terminalReason(at, r.outcome, r, stopText(at, out, r)) };
  }
  const checked = state.passed.length ? `: ${state.passed.join(' and ')} passed` : '';
  return { next: snap.then ?? snap.route?.ok, stop: null,
    reason: terminalReason(last.at, last.r.outcome, last.r, `${vertexId} visit ${visit} completed every ${snap.procedure} Action${checked}.`) };
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
  return `${where} ended with ${out} (rule ${r.row}).`;
}

// One Attempt of an agent call: `resume` and `nudge` come from the Attempt before it, if any.
async function callAttempt(ctx, at, state, { lineage, resume, nudge }) {
  const { record: rec, harness, ticket, base, others = [] } = ctx;
  // Each call gets its own copy: a Harness that edits its call must not change the next one.
  const { node, persona, commands } = structuredClone(rec.snapshot);
  const m = ctx.markerOf(at);
  const red = rec.outputs.red;
  const brief = nudge ? briefs.nudgeBrief(nudge) : briefs[state.proc.briefs[at.phase]]({ ticket, base, commands, history: rec.history,
    testFiles: red?.tests, redOutput: red?.evidence.output, output: state.runs[at.phase === 'test-fix' ? 'green' : 'red']?.output });
  const call = {
    marker: m, vertex: at.vertex, visit: at.visit, phase: at.phase, attempt: at.attempt, node, persona, brief,
    schema: ['red', 'still-green'].includes(at.phase) ? briefs.RED_SCHEMA : briefs.IMPLEMENT_SCHEMA, cwd: rec.worktree,
    resume, access: node.access, network: node.network, tools: harness.resolveTools(node), timeouts: node.timeouts ?? {}, env: {},
  };
  const t0 = ctx.clock.now();
  // The snapshots are git processes in this worktree, so they run inside the busy interval too (request 3.6).
  const { response, result, failure, violations, baseline } = await bracket(rec, async () => {
    const baseline = await integrity.begin({ record: rec, others, protectedPaths: PROTECTED_PATHS, testPathspecs: checks.TEST_PATHSPECS });
    state.baseline ??= baseline.head;
    const out = await harness.run(call);
    const { violations } = await integrity.end({ baseline, record: rec, others, access: rec.snapshot.node.access, protectedPaths: PROTECTED_PATHS });
    return { ...out, violations, baseline };
  });
  rec.sessions[`${at.visit}/${at.phase}`] = { sessionId: result.sessionId, harness: node.harness, personaHash: persona.hash,
    transcriptPath: result.transcriptPath, usage: result.usage.cumulative };
  const claim = briefs.validateResponse(call.schema, response);
  // The transition table reads the three Signals of a call as one flat result.
  state.calls[at.phase] = { result, claim, response, baseline, signal: { status: result.status, response, failure } };
  state.response = response;
  const checkResults = [{ name: 'integrity', passed: violations.length === 0, integrity: true, violations }];
  const r = outcome.resolve({ result: state.calls[at.phase].signal, claim, checks: checkResults, retries: rec.retries[`${at.vertex}/${at.visit}/${at.phase}/${at.ordinal}`] ?? {} });
  ctx.emit(at, t0, {
    agent: true, harness: node.harness, cliVersion: null, model: node.model, effort: node.effort, personaHash: persona.hash,
    tools: call.tools, init: result.init, sessionId: result.sessionId, lineage: lineage ?? null,
    transcriptPath: result.transcriptPath, usage: result.usage, exitCode: result.exitCode, signal: result.signal,
    finalEventSubtype: result.finalEventSubtype, permissionDenials: result.permissionDenials, commandsRun: result.commandsRun,
    failureClass: r.failureClass, outcome: r.outcome, direction: r.direction, rule: r.row,
    signals: { result: { status: result.status, failureClass: r.failureClass }, claim, checks: checkResults },
    ...(r.check && { check: r.check, violations }),
  });
  await record.save(rec);
  const surfaces = violations.length ? [...new Set(violations.map((v) => v.surface))] : null;
  // A prohibited change never survives into a retry or the next Action, whatever the Harness Result (request 3.4).
  if (surfaces) {
    await discard(ctx, at, baseline.head, { kind: 'integrity violation',
      text: `Attempt ${at.attempt} of ${at.phase} ${at.ordinal} changed ${surfaces.join(' and ')}; the worktree was restored to its baseline head.` }, { untracked: rollbackSet(baseline) });
  }
  return { ...r, sessionId: result.sessionId, reason: claim.reason, surfaces };
}

const KINDS = {
  // Attempt retries (parse, timeout, transient) stay inside the Action: each is a new attempt of the same (phase, ordinal).
  async call(ctx, at, action, state) {
    const { record: rec, harness } = ctx;
    const key = `${at.vertex}/${at.visit}/${at.phase}/${at.ordinal}`;
    const lineage = state.lineage[at.phase];
    let resume = lineage ? rec.sessions[`${at.visit}/${lineage}`]?.sessionId ?? null : null;
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
      // Test Immutability is asserted with the Green Check: committed tests must still match the red commit.
      immutability: action.check === 'green' && rec.outputs.red ? await checks.testImmutability(rec.worktree, rec.outputs.red.sha) : null,
    }));
    state.runs[at.phase] = run;
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
      if (!await git.stageAll(rec.worktree) && at.phase === 'red') return true;
      const tree = await git.writeTree(rec.worktree);
      const parent = await git.headSha(rec.worktree);
      const { sha } = await sideEffect(rec, m, 'commit', { message, parent, tree }, async () => ({ sha: await git.commitStaged(rec.worktree, message) }));
      // Red Evidence is captured once, after the test commit, and reused in every PR body.
      if (at.phase === 'red') {
        const tests = (await git.runGit(['diff', '--name-only', '-z', parent, sha], { cwd: rec.worktree })).stdout.split('\0').filter(Boolean);
        rec.outputs.red = { sha, tests, evidence: state.evidence.red };
        await record.save(rec);
      }
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
      const sha = await git.headSha(rec.worktree);
      await sideEffect(rec, ctx.markerOf(at), 'push', { branch: rec.branch, sha }, async () => {
        await git.push(rec.worktree, rec.branch);
        return { remoteSha: await git.remoteSha(rec.worktree, rec.branch) };
      });
    });
    return effectDone(ctx, at, t0);
  },

  async 'pr-upsert'(ctx, at, action, state) {
    const { record: rec, gh, ticket, cwd } = ctx;
    const { node, persona } = rec.snapshot;
    const t0 = ctx.clock.now();
    const m = ctx.markerOf(at);
    const usage = Object.values(rec.sessions).filter((s) => s.personaHash === persona.hash)
      .reduce((u, s) => ({ input: u.input + s.usage.input, cached: u.cached + s.usage.cached, output: u.output + s.usage.output }), { input: 0, cached: 0, output: 0 });
    const body = render.prBody({
      ticket, marker: m,
      impl: { ...state.calls.green.response, red: rec.outputs.red.evidence, green: state.evidence.green },
      provenance: [{ vertex: at.vertex, harness: node.harness, model: node.model, effort: node.effort, persona: persona.name,
        hash: persona.hash.slice(0, 12), calls: Object.keys(state.calls).length, ...usage }],
    });
    const payload = { branch: rec.branch, base: ctx.base, title: ticket.title, body, bodyHash: sha256(body) };
    await bracket(rec, () => sideEffect(rec, m, 'pr-upsert', payload, async () => {
      const pr = await gh.upsertPr(payload, cwd);
      rec.pr = pr.number;
      return { number: pr.number, url: pr.url };
    }));
    return effectDone(ctx, at, t0);
  },
};

function effectDone(ctx, at, t0) {
  const r = { outcome: 'ok', direction: 'advance', row: 'effect-completed' };
  ctx.emit(at, t0, { outcome: r.outcome, direction: r.direction, rule: r.row, signals: {} });
  return r;
}

// One deterministic Action of a Terminal: bracketed, write-ahead, with its own Action Event.
async function terminalAction(ctx, at, action, payload, effect) {
  const t0 = ctx.clock.now();
  await ctx.enter(at);
  const evidence = await bracket(ctx.record, () => sideEffect(ctx.record, ctx.markerOf(at), action, payload, effect));
  effectDone(ctx, at, t0);
  return evidence;
}

async function terminal(ctx, name, stop, error) {
  const { record: rec, gh, git, cwd, log, events: ev, labelPrefix = 'gg' } = ctx;
  const state = labels(labelPrefix).state;
  const at = (ordinal) => ({ vertex: name, visit: 1, procedure: null, phase: name, ordinal });
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
  const m = ctx.markerOf(at(++ordinal));
  const body = stop?.outcome === 'blocked' ? render.blockedComment(stop.response, m, reason) : render.terminalComment(name, reason, m, stop?.detail);
  await tolerate(terminalAction(ctx, at(ordinal), 'comment', { target: { kind: 'issue', number: rec.ticket }, body, bodyHash: sha256(body) }, async () => {
    const url = await gh.commentIssue(rec.ticket, body, cwd);
    return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
  }));
  const change = { add: [state(name === 'done' ? 'ready-for-qa' : 'needs-human')], remove: [state('in-progress')] };
  let diffStats;
  await tolerate(terminalAction(ctx, at(++ordinal), 'label', { ticket: rec.ticket, ...change }, async () => {
    const ok = await gh.setLabels(rec.ticket, change, cwd, { log, ev });
    if (name === 'done') diffStats = events.diffStats(await git.numstat(rec.worktree, rec.base));
    return { ok };
  }));
  rec.state = error ? 'fault' : name;
  await record.save(rec);
  ev('ticket_end', { run: rec.run, execution: rec.execution, ticket: rec.ticket, outcome: name,
    ...(diffStats && { diffStats }), reason, ...(error && { error }) });
  return { outcome: name };
}
