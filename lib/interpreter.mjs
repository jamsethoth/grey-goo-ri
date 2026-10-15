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
const WHEN = { 'red run passed': (state) => state.runs.red?.code === 0 };
// A failing Check is retried only through a recovery Phase that runs next; otherwise the Procedure has exhausted it.
const recovers = (state) => !!WHEN[state.next?.when]?.(state);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// A failed red Phase leaves nothing behind and tells the next red Brief why. Rollback is limited to what this Visit's
// agent made (request 3.5); the History item is saved with the reset's evidence, so Reconciliation adds it exactly once.
async function discardRed(ctx, at, state, reason) {
  const { record: rec, git } = ctx;
  const payload = { baseline: state.baseline, history: { kind: 'red phase failed', text: reason } };
  await bracket(rec, () => sideEffect(rec, ctx.markerOf(at), 'reset', payload, async () => {
    await git.resetTo(rec.worktree, payload.baseline);
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
  const { flow, record: rec, events: ev, clock = { now: Date.now } } = opts;
  const ctx = { ...opts, clock };

  // Records one Action Event; `at` is the Action's identity, `fields` its outcome and payload.
  ctx.emit = (at, t0, fields) => ev('action', {
    flow: flow.name, configHash: rec.configHash, launchProfile: null, confinement: opts.harness.capabilities.confinement,
    ticket: rec.ticket, run: rec.run, execution: rec.execution, attempt: 1, durationMs: clock.now() - t0, ...at, ...fields,
  });
  ctx.markerOf = (at) => marker.formatMarker({ execution: rec.execution, run: rec.run, attempt: 1, ...at });
  ctx.enter = async (at) => {
    rec.cursor = { vertex: at.vertex, visit: at.visit, phase: at.phase, ordinal: at.ordinal, attempt: 1 };
    await record.save(rec);
  };

  let next = flow.ticket.entry;
  let stop = null;
  let reason = null;
  while (!TERMINALS.includes(next)) ({ next, stop, reason } = await runVisit(ctx, next));
  rec.cursor = { vertex: next, visit: null, phase: null, ordinal: 0, attempt: 1 };
  // Saved with the terminal cursor, before any Terminal side effect, so a crash inside the Terminal keeps it.
  rec.terminalReason = next === 'done' ? { ...reason, text: `${reason.text} PR #${rec.pr} is ready for review.` } : reason;
  await record.save(rec);
  return terminal(ctx, next, stop);
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
  const state = { proc, lineage: described.lineage, calls: {}, runs: {}, passed: [] };
  let last = null;
  // shortcut: test-fix and Attempt retries are skipped; any other retry ends the Procedure (T16).
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
    const out = r.direction === 'retry' ? 'needs-human' : r.outcome;
    if (out === 'red-failed') await discardRed(ctx, at, state, r.reason);
    // shortcut: misscoped takes the needs-human default too until the replan Terminal lands (T17).
    return { next: snap.route?.[out] ?? 'needs-human', stop: { outcome: out, response: state.response, at },
      reason: terminalReason(at, out, r, stopText(at, out, r, state)) };
  }
  const checked = state.passed.length ? `: ${state.passed.join(' and ')} passed` : '';
  return { next: snap.then ?? snap.route?.ok, stop: null,
    reason: terminalReason(last.at, last.r.outcome, last.r, `${vertexId} visit ${visit} completed every ${snap.procedure} Action${checked}.`) };
}

// Only the Visit that routes to a Terminal keeps its reason; the Signals stay on the deciding Action's Event.
const terminalReason = ({ vertex, visit, phase, ordinal }, outcome, r, text) =>
  ({ decidedBy: { vertex, visit, phase, ordinal }, outcome, rule: r.row, text });

const sentence = (s) => `${String(s ?? '').trim().replace(/\.$/, '')}.`;

function stopText(at, out, r, state) {
  const where = `${at.phase} ${at.ordinal}`;
  if (out === 'red-failed') return `The red phase failed and the agent's changes were discarded: ${sentence(r.reason)}`;
  if (out === 'blocked') return `The ${at.phase} Claim was blocked: ${sentence(state.response?.notes)}`;
  if (r.direction === 'retry') return `${where} needed a retry (rule ${r.row}) that this Procedure cannot run yet.`;
  return `${where} ended with ${out} (rule ${r.row}).`;
}

const KINDS = {
  async call(ctx, at, action, state) {
    const { record: rec, harness, ticket, base, others = [] } = ctx;
    // Each call gets its own copy: a Harness that edits its call must not change the next one.
    const { node, persona, commands } = structuredClone(rec.snapshot);
    const m = ctx.markerOf(at);
    const red = rec.outputs.red;
    const brief = briefs[state.proc.briefs[at.phase]]({ ticket, base, commands, history: rec.history,
      testFiles: red?.tests, redOutput: red?.evidence.output, output: state.runs.red?.output });
    const lineage = state.lineage[at.phase];
    const call = {
      marker: m, vertex: at.vertex, visit: at.visit, phase: at.phase, attempt: 1, node, persona, brief,
      schema: ['red', 'still-green'].includes(at.phase) ? briefs.RED_SCHEMA : briefs.IMPLEMENT_SCHEMA, cwd: rec.worktree,
      resume: lineage ? rec.sessions[`${at.visit}/${lineage}`]?.sessionId ?? null : null,
      access: node.access, network: node.network, tools: harness.resolveTools(node), timeouts: node.timeouts ?? {}, env: {},
    };
    const t0 = ctx.clock.now();
    // The snapshots are git processes in this worktree, so they run inside the busy interval too (request 3.6).
    const { response, result, failure, violations } = await bracket(rec, async () => {
      const baseline = await integrity.begin({ record: rec, others });
      state.baseline ??= baseline.head;
      const out = await harness.run(call);
      const { violations } = await integrity.end({ baseline, record: rec, others, access: rec.snapshot.node.access, protectedPaths: PROTECTED_PATHS });
      return { ...out, violations };
    });
    rec.sessions[`${at.visit}/${at.phase}`] = { sessionId: result.sessionId, harness: node.harness, personaHash: persona.hash,
      transcriptPath: result.transcriptPath, usage: result.usage.cumulative };
    const claim = briefs.validateResponse(call.schema, response);
    // The transition table reads the three Signals of a call as one flat result.
    state.calls[at.phase] = { result, claim, response, signal: { status: result.status, response, failure } };
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
    return r;
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
    const evidence = checks.evidence(commands.test, run);
    if (passed) state.evidence = { ...state.evidence, [action.check]: evidence };
    if (passed && !state.passed.includes(CHECK_TITLES[action.check])) state.passed.push(CHECK_TITLES[action.check]);
    const checkResults = [{ name, passed, integrity: false }];
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

async function terminal(ctx, name, stop) {
  const { record: rec, gh, git, cwd, log, events: ev, labelPrefix = 'gg' } = ctx;
  const state = labels(labelPrefix).state;
  const at = (ordinal) => ({ vertex: name, visit: 1, procedure: null, phase: name, ordinal });
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
  const body = stop?.outcome === 'blocked' ? render.blockedComment(stop.response, m, reason) : render.terminalComment(name, reason, m);
  await terminalAction(ctx, at(ordinal), 'comment', { target: { kind: 'issue', number: rec.ticket }, body, bodyHash: sha256(body) }, async () => {
    const url = await gh.commentIssue(rec.ticket, body, cwd);
    return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
  });
  const change = { add: [state(name === 'done' ? 'ready-for-qa' : 'needs-human')], remove: [state('in-progress')] };
  let diffStats;
  await terminalAction(ctx, at(++ordinal), 'label', { ticket: rec.ticket, ...change }, async () => {
    const ok = await gh.setLabels(rec.ticket, change, cwd, { log, ev });
    if (name === 'done') diffStats = events.diffStats(await git.numstat(rec.worktree, rec.base));
    return { ok };
  });
  rec.state = name;
  await record.save(rec);
  ev('ticket_end', { run: rec.run, execution: rec.execution, ticket: rec.ticket, outcome: name,
    ...(diffStats && { diffStats }), reason });
  return { outcome: name };
}
