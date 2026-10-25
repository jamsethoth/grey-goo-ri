// Helpers the interpreter test files share.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as marker from '../../lib/marker.mjs';
import * as golden from './golden.mjs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as locks from '../../lib/locks.mjs';
import * as run from '../../lib/run.mjs';

export const TDD_PHASES = ['red', 'still-green', 'green', 'test-fix'];

export const FIRST_VISIT = [
  ['red', 1], ['red', 2], ['red', 3], ['green', 1], ['green', 2], ['green', 3], ['green', 4], ['green', 5],
].map(([phase, ordinal]) => ({ phase, ordinal, attempt: 1, outcome: 'ok' }));

export async function firstVisit(t, opts) {
  const g = await golden.setup(t, opts);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  return g;
}

export const intents = (rec, action) => rec.log.filter((e) => e.step === 'intent' && e.action === action);
export const steps = (rec, m) => rec.log.filter((e) => e.marker === m).map((e) => e.step);
export const actionMarker = (g, phase, ordinal) => marker.formatMarker({
  execution: g.rec.execution, vertex: 'implementer', visit: 1, phase, ordinal, run: g.rec.run, attempt: 1,
});

// The Terminal Reason must agree in the record and on ticket_end, and (unless the caller checks its own comment) be
// posted once on the ticket, write-ahead, with the comment's Action Marker.
export function terminalReasonOf(g, { comment = true } = {}) {
  const reason = g.rec.terminalReason;
  assert.ok(reason, 'the record holds a Terminal Reason');
  assert.deepEqual(g.readEvents().at(-1).reason, reason, 'ticket_end carries the same Terminal Reason');
  assert.equal(typeof reason.text, 'string');
  if (comment) {
    const posted = g.gh.comments.filter((c) => c.body.includes(`**Terminal Reason:** ${reason.text}`));
    assert.equal(posted.length, 1, 'the Terminal Reason is posted once');
    assert.match(posted[0].body, /^<!-- gg-action gg:\S+ -->$/m);
    assert.equal(intents(g.rec, 'comment').length, 1, 'through the write-ahead log');
  }
  return reason;
}

export const tddTrace = (g) => golden.trace(g.readEvents()).filter((e) => TDD_PHASES.includes(e.phase));
export const actionEvent = (g, phase, ordinal) => g.readEvents().find((e) => e.type === 'action' && e.phase === phase && e.ordinal === ordinal);

// T17's error paths: every non-advance row of the transition table, reached through the interpreter.
export const WRONG_ADD = 'export const add = () => 0;\n';
export const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';
export const attemptsOf = (g, phase, ordinal) => g.readEvents().filter((e) => e.type === 'action' && e.phase === phase && e.ordinal === ordinal);

export const neededHuman = (g) => g.gh.calls.some((c) => c.args.join(' ').includes('--add-label gg:state:needs-human'));

// T17: the review and fix Procedures on an inline Flow matching request 3.3's illustration.
export const REVIEWER_PERSONA = '# reviewer\nJudge the diff.\n';
export const finding = (severity, file, issue) => ({ severity, file, issue, fix: 'Make it right.' });
export const review = (claim, findings = [], extra = {}) => ({
  claim, summary: `The review says ${claim}.`, dodMet: true, tddEvidenceOk: true, findings, diagnosis: '', ...extra,
});
export const reviewed = (response, files = {}) => ({ files, response });
export const fixed = (files) => ({ files, response: { ...golden.greenResponse, summary: 'Address the findings.' } });

export const MAJOR = finding('major', 'lib/add.mjs', 'add ignores non-number input at line 1');

// implementer(tdd) -> reviewer(review); changes -> {implementer-fix, max 2, exhausted needs-human}; implementer-fix(fix) -> reviewer.
export async function reviewSetup(t, responses, opts) {
  const g = await reviewFlow(t, responses, opts);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  g.actions = g.events.filter((e) => e.type === 'action' && e.procedure);
  g.at = (vertex, visit, phase, ordinal) => g.actions.filter((e) => e.vertex === vertex && e.visit === visit && e.phase === phase && e.ordinal === ordinal);
  g.subjects = () => golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean).reverse();
  return g;
}

export async function reviewFlow(t, responses, { exec, integrity, git } = {}) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses }, integrity, git });
  const reviewerPersona = join(g.root, 'personas', 'reviewer.md');
  writeFileSync(reviewerPersona, REVIEWER_PERSONA);
  const implementer = g.flow.ticket.vertices.implementer;
  g.flow.ticket.vertices = {
    implementer: { ...implementer, then: 'reviewer' },
    reviewer: {
      agent: { ...structuredClone(implementer.agent), model: 'model-r', persona: reviewerPersona, access: 'read-only' },
      procedure: 'review', options: {},
      route: { ok: 'done', changes: { to: 'implementer-fix', max: 2, exhausted: 'needs-human' }, misscoped: 'replan' },
    },
    'implementer-fix': { agent: structuredClone(implementer.agent), procedure: 'fix', options: {}, then: 'reviewer' },
  };
  if (exec) g.options.exec = exec;
  return g;
}

export const prReviewComments = (g) => g.gh.comments.filter((c) => c.number === g.gh.pr()?.number && /### gg review/.test(c.body));
export const ticketComments = (g) => g.gh.comments.filter((c) => c.target === 'issue' && c.number === golden.TICKET);

// A review or fix stop ends with one Terminal Reason in the record, on ticket_end and in exactly one ticket comment.
export function reviewStopReason(g) {
  const reason = g.rec.terminalReason;
  assert.ok(reason, 'the record holds a Terminal Reason');
  assert.deepEqual(g.events.at(-1).reason, reason, 'ticket_end carries the same Terminal Reason');
  const posted = ticketComments(g).filter((c) => c.body.includes(`**Terminal Reason:** ${reason.text}`));
  assert.equal(posted.length, 1, 'the Terminal Reason is posted once on the ticket');
  assert.match(posted[0].body, /^<!-- gg-action gg:\S+ -->$/m);
  return reason;
}

// #67: agent Attempts are write-ahead, and each record transition saves with its Event.
export const loadTicket = (g) => record.load(g.commonDir, 'ticket', golden.TICKET);
export const ticketRow = (g) => JSON.parse(record.openDb(g.commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(golden.TICKET).json);
export const attemptMarker = (g, vertex, visit, phase, ordinal, attempt = 1) =>
  marker.formatMarker({ execution: g.rec.execution, vertex, visit, phase, ordinal, run: g.rec.run, attempt });

// #66: GitHub writes and push retry recognised transient failures inside the Action, through the marker lookup.
export const PR = 7;
export const okReview = { 'reviewer/1/review/1': reviewed(review('ok')) };
export const REVIEW_COMMENT = 'reviewer/1/review/3';
export const commentPosts = (g, n = PR) => g.gh.calls.filter((c) => golden.isCommentPost(c.args, n));
export const onPr = (fields) => ({ matches: (args) => golden.isCommentPost(args, PR), ...fields });

// Crashes the `n`th review-comment POST as it launches, after the queued failures before it.
export function crashPost(g, n) {
  let posts = 0;
  g.options.gh.setGh(async (args, cwd, input) => {
    if (golden.isCommentPost(args, PR) && ++posts === n) throw new interpreter.CrashError('crash as the POST launched');
    return g.gh.gh(args, cwd, input);
  });
  return () => posts;
}

// Another holder takes the repo lock at the first lock attempt after `arm()`, so that attempt fails and waits; at the
// next attempt `during()` runs and the lock is released, and the waiting git write goes ahead behind a contended lock.
// The lock attempts are seen through locks.tryAcquire's mkdir of the lock directory.
export function contendRepoLock(t, commonDir, during) {
  const original = fsPromises.mkdir;
  let state = 'idle';
  let held = null;
  let own = false;
  fsPromises.mkdir = async (path, ...rest) => {
    if (!own && String(path) === join(commonDir, 'gg', 'locks')) {
      if (state === 'armed') {
        state = 'holding';
        own = true;
        held = await locks.tryAcquire(commonDir, 'repo');
        own = false;
      } else if (state === 'holding') {
        state = 'released';
        await during();
        await locks.release(held);
      }
    }
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.mkdir = original; syncBuiltinESMExports(); });
  return { arm: () => { state = 'armed'; }, state: () => state };
}

// The golden Execution on the orchestrator's locked git; `after(verb, n)` runs after the nth raw call of a verb.
export function lockedSetup(g, after) {
  const counts = {};
  const raw = Object.fromEntries(['writeTree', 'commitStaged', 'push'].map((verb) => [verb, async (...args) => {
    const out = await git[verb](...args);
    counts[verb] = (counts[verb] ?? 0) + 1;
    after(verb, counts[verb]);
    return out;
  }]));
  const git = g.options.git;
  g.options.git = run.lockedGit({ ...git, ...raw }, g.commonDir);
  return counts;
}
