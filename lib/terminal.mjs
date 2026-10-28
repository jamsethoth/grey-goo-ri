import { createHash } from 'node:crypto';
import * as events from './events.mjs';
import * as record from './record.mjs';
import * as render from './render.mjs';
import { labels } from './labels.mjs';
import { Decided, TERMINALS, bracket, effectDone, fatal, sideEffect } from './effects.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Reconciliation or admission could not proceed safely: the ticket goes to needs-human with the reason, and the record is
// kept as Held. `advice` follows the reason in the comment only; `fresh` marks a hold decided before any Execution ran,
// which may restart once it has landed.
export async function hold(ctx, { name = 'reconciliation', text, advice, detail, fresh }) {
  const rec = ctx.record;
  rec.terminalReason = { decidedBy: { hold: name }, outcome: null, rule: null, text };
  rec.cursor = { vertex: 'needs-human', visit: null, action: null, recovery: 0, attempt: 1 };
  return terminal(ctx, 'needs-human', { outcome: 'needs-human', response: null, at: null, held: true,
    ...(advice && { advice }), ...(detail && { detail }), ...(fresh && { fresh }) });
}

// A human's needs-human label overrides the record (request 3.5). Its abandonment is saved before any cleanup, which only
// removes in-progress, so nothing is posted or added; the abandoned state lands with ticket_end.
export async function abandon(ctx, { reason, inProgress }) {
  const rec = ctx.record;
  rec.terminalReason = { decidedBy: { human: labels(ctx.labelPrefix ?? 'gg').state('needs-human') }, outcome: null, rule: null, text: reason };
  return terminal(ctx, 'abandoned', { outcome: 'abandoned', abandoned: true, inProgress });
}

// An unexpected fault is never retried: the ticket goes to needs-human with the error, and the record is marked fault
// with its ticket_end.
// An account failure stops the whole run even when reporting it faults, so the caller can still stop every ticket.
export async function fault(ctx, err, prior) {
  const rec = ctx.record;
  const error = err?.message || String(err) || 'unknown error';
  const { vertex, visit, action, recovery } = rec.cursor;
  // The fault replaces the Terminal Reason, so the reason of a Terminal it interrupted travels in the fault comment.
  const interrupted = TERMINALS.includes(vertex) && rec.terminalReason ? { terminal: vertex, reason: rec.terminalReason } : null;
  rec.cursor = { vertex: 'needs-human', visit: null, action: null, recovery: 0, attempt: 1 };
  const where = action ? whereOf({ action, recovery }) : vertex;
  const spent = err?.retriesExhausted;
  const target = spent?.action === 'push' ? 'push' : 'GitHub';
  const what = spent && (spent.class === 'rate-limited' ? `A ${target} rate limit` : `A transient ${target} failure`) + (spent.status ? ` (HTTP ${spent.status})` : '');
  rec.terminalReason = { decidedBy: { vertex, visit, action, recovery }, outcome: null, rule: null,
    text: spent ? `${what} at ${where} persisted after ${spent.count} retries; the error is in this comment and on ticket_end.`
      : `An unexpected fault stopped the Execution at ${where}; the error is in this comment and on ticket_end.` };
  const runStop = runStopOf(prior);
  return terminal(ctx, 'needs-human', { outcome: 'fault', detail: error, error, ...(runStop && { runStop }), ...(interrupted && { interrupted }) });
}

// The failure class of a run stop, whether the stop is the run stop itself or a fault that interrupted its Terminal.
export const runStopOf = (stop) => (stop?.outcome === 'run-stop' ? stop.failureClass : stop?.runStop);

// Another Execution's run stop ends this one at needs-human before it starts another Action or Attempt (request 3.4).
export const runStopped = (ctx) => {
  const stop = ctx.runState?.stop;
  return stop ? { outcome: 'needs-human', direction: 'stop', row: 'run-stopped', failureClass: stop.failureClass, origin: stop.ticket } : null;
};

// Only the Visit that routes to a Terminal keeps its reason; the Signals stay on the deciding Action's Event.
export const terminalReason = ({ vertex, visit, action, recovery }, outcome, r, text) =>
  ({ decidedBy: { vertex, visit, action, recovery }, outcome, rule: r.row, text });

// An Action as a Terminal Reason names it: its id, and the recovery pass it ran in.
export const whereOf = ({ action, recovery }) => (recovery ? `${action} (recovery ${recovery})` : action);

export function stopText(at, out, r) {
  const where = whereOf(at);
  const cls = r.failureClass ?? 'unknown';
  switch (r.row) {
    case 'integrity-violation': return r.surfaces
      ? `The agent's Attempt at ${where} broke an Integrity Assertion on ${r.surfaces.join(' and ')}, so the worktree was restored to its baseline head.`
      : `Test Immutability failed at ${where}: a committed test was changed.`;
    case 'parse-exhausted': return `The agent gave no valid Structured Response at ${where}, even after the return-the-result nudge.`;
    case 'timeout-exhausted': return `The harness call at ${where} timed out or was killed, and so did its retry.`;
    case 'transient-exhausted': return `The harness call at ${where} kept failing with class ${cls} until its retry budget ran out.`;
    case 'run-stop': return `The harness call at ${where} failed with class ${cls}, which stops the whole run.`;
    // A stop found during a backoff (`retrying`) leaves the Action's retry as saved.
    case 'run-stopped': return `The harness call of Ticket #${r.origin} failed with class ${cls}, which stops the whole run, so this Execution stopped `
      + (r.retrying ? `while waiting to retry ${where}; its retry is kept as saved.` : `before ${where}.`);
    case 'unknown-failure': return `The harness call at ${where} failed with class ${cls}, which is never retried.`;
  }
  if (out === 'gate-failed(test)') return `The Green Check failed at ${where} with no test-fix left (rule ${r.row}).`;
  if (out === 'red-failed') return `The red phase failed the Red Check (rule ${r.row}) and the agent's changes were discarded.`;
  // The agent's diagnosis stays out: the blocked comment posts it fenced, and it need not be one sentence.
  if (out === 'blocked') return `The agent made a blocked Claim at ${at.vertex}; its diagnosis in the blocked comment says why.`;
  if (out === 'misscoped') return `The agent made a misscoped Claim at ${at.vertex}; its diagnosis is posted with this reason.`;
  return `${where} ended with ${out} (rule ${r.row}).`;
}

// A Terminal's Action identity: `<report>-<step>`, Recovery Number 0. A fault report, a hold and an abandonment each have
// their own report, so their Actions never replay the open intent of an end they interrupted. An abandonment is reported
// under its State Label.
export const terminalAt = (name, stop) => (step) => ({ vertex: stop?.abandoned ? 'needs-human' : name, visit: 1, procedure: null,
  action: `${stop?.error ? 'fault' : stop?.held ? 'hold' : stop?.abandoned ? 'abandon' : 'end'}-${step}`, recovery: 0 });

// One deterministic Action of a Terminal: bracketed, write-ahead, with its own Action Event.
async function terminalAction(ctx, at, action, payload, effect) {
  const t0 = ctx.clock.now();
  await ctx.enter(at);
  const m = ctx.markerOf(at);
  const evidence = await bracket(ctx.record, () => sideEffect(ctx, m, action, payload, effect, true));
  await effectDone(ctx, at, t0, m);
  return evidence;
}

// A human override or conflict found before a retry ends the Execution as decided: abandoned or held.
export function decide(ctx, decided) {
  ctx.log(`#${ctx.record.ticket} ${decided.next}: ${decided.reason}`);
  if (decided.next === 'run-stopped') return runStoppedAt(ctx, decided.retrying);
  return decided.next === 'abandon' ? abandon(ctx, decided) : hold(ctx, { text: decided.reason });
}

// A run stop found during a backoff or a repo-lock wait ends the Execution at needs-human with the run-stopped reason,
// naming the Action it stopped; one stopped in a backoff is left with its retry as saved.
function runStoppedAt(ctx, retrying) {
  const rec = ctx.record;
  const r = runStopped(ctx);
  const at = rec.cursor;
  rec.terminalReason = terminalReason(at, r.outcome, r, stopText(at, r.outcome, { ...r, retrying }));
  rec.cursor = { vertex: 'needs-human', visit: null, action: null, recovery: 0, attempt: 1 };
  return terminal(ctx, 'needs-human', { outcome: 'needs-human', response: null, at: null });
}

// A decision found by a Terminal's own retry is taken here, as a fault report may run from runExecution's catch.
export async function terminal(ctx, name, stop) {
  try {
    return await terminalActions(ctx, name, stop);
  } catch (err) {
    if (err instanceof Decided) return decide(ctx, err.decided);
    throw err;
  }
}

async function terminalActions(ctx, name, stop) {
  const { record: rec, gh, git, cwd, log, events: ev, labelPrefix = 'gg' } = ctx;
  const state = labels(labelPrefix).state;
  // Saved before the first Terminal Action, so a restart inside the Terminal runs the same Actions under the same ids and
  // ends with the same classification: held, fault with its error, or a run stop.
  // The save that decides a hold, fault or abandonment also retires the admission decision it reports.
  if (stop) {
    rec.terminalStop = stop;
    delete rec.admission;
    await record.save(rec);
  } else stop = rec.terminalStop ?? null;
  const error = stop?.error;
  const at = terminalAt(name, stop);
  // In a fault the report is best effort: a failing comment or label must not keep the state and ticket_end from landing.
  const tolerate = (p) => (error ? p.catch((e) => { if (fatal(e) || e instanceof Decided) throw e; log(`#${rec.ticket} fault report failed: ${e?.message}`); }) : p);
  if (name === 'done') {
    await terminalAction(ctx, at('pr-ready'), 'pr-ready', { number: rec.pr }, async (p) => {
      await gh.markReady(p.number, cwd);
      return {};
    });
  }
  const reason = rec.terminalReason;
  // The blocked comment carries the Terminal Reason, so a blocked Ticket still gets exactly one comment.
  // The replan diagnosis goes to the ticket and to its epic, each carrying the Terminal Reason as the blocked comment does.
  const diagnosis = name === 'replan' && stop?.response;
  // A hold's advice is for the human reading its comment, not part of its one-sentence Terminal Reason.
  const shown = stop?.advice ? { ...reason, text: `${reason.text}\n\n${stop.advice}` } : reason;
  const comment = async (number, step) => {
    const m = ctx.markerOf(at(step));
    const body = stop?.outcome === 'blocked' || diagnosis ? await render.stopComment(name, stop.outcome, stop.response, m, reason, ctx.publicText)
      : await render.terminalComment(name, shown, m, stop?.detail, stop?.interrupted, ctx.publicText);
    return tolerate(terminalAction(ctx, at(step), 'comment', { target: { kind: 'issue', number }, body, bodyHash: sha256(body) }, async (p) => {
      const url = await gh.commentIssue(p.target.number, p.body, cwd);
      return { id: Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null };
    }));
  };
  // An abandonment posts nothing.
  if (!stop?.abandoned) await comment(rec.ticket, 'comment');
  if (diagnosis && rec.epic) await comment(rec.epic, 'epic-comment');
  const change = { add: stop?.abandoned ? [] : [state({ done: 'ready-for-qa', replan: 'needs-replan' }[name] ?? 'needs-human')],
    remove: [state('in-progress')] };
  // Read outside the label's effect, which a Terminal resumed after it does not run again.
  const diffStats = name === 'done' ? events.diffStats(await bracket(rec, () => git.diffStats(rec.worktree, rec.base)), rec.snapshot.testPaths) : null;
  if (!stop?.abandoned || stop.inProgress) {
    await tolerate(terminalAction(ctx, at('label'), 'label', { ticket: rec.ticket, ...change }, async (p) => {
      const ok = await gh.setLabels(p.ticket, { add: p.add, remove: p.remove }, cwd, { log, ev });
      // A hold or abandonment lands only with its label, so a failed one stays open for the next Run.
      if (!ok && (stop?.held || stop?.abandoned)) throw new Error(`label update ${JSON.stringify({ add: p.add, remove: p.remove })} failed`);
      return { ok };
    }));
  }
  rec.state = stop?.abandoned ? 'abandoned' : stop?.held ? 'held' : error ? 'fault' : name;
  // The final state and ticket_end commit together: a Terminal has landed in both or in neither.
  await record.save(rec, () => ev('ticket_end', { run: ctx.run, execution: rec.execution, ticket: rec.ticket, outcome: name,
    ...(diffStats && { diffStats }), reason, ...(error && { error }), ...(stop?.interrupted && { interrupted: stop.interrupted }) }));
  const failureClass = runStopOf(stop);
  return { outcome: name, ...(stop?.held && { held: true }), ...(error && { fault: true }), ...(failureClass && { runStop: { failureClass } }) };
}
