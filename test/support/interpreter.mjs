// Helpers the interpreter test files share.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from './golden.mjs';
import * as locks from '../../lib/locks.mjs';
import * as run from '../../lib/run.mjs';

export const TDD_VERTICES = ['red', 'green'];

export const FIRST_VISIT = [
  ['red', 'red'], ['red', 'red-check'], ['red', 'commit'], ['green', 'green'], ['green', 'test'], ['green', 'commit'], ['green', 'push'], ['green', 'pr'],
].map(([vertex, action]) => ({ vertex, action, recovery: 0, attempt: 1, outcome: 'ok' }));

export async function firstVisit(t, opts) {
  const g = await golden.setup(t, opts);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  return g;
}

export const intents = (rec, action) => rec.log.filter((e) => e.step === 'intent' && e.action === action);
export const steps = (rec, m) => rec.log.filter((e) => e.marker === m).map((e) => e.step);
export const actionMarker = (g, vertex, action, recovery = 0) => golden.markerOf(g.rec, vertex, 1, action, recovery);

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

export const tddTrace = (g) => golden.trace(g.readEvents()).filter((e) => TDD_VERTICES.includes(e.vertex));
const isAction = (e, vertex, action, recovery) => e.type === 'action' && e.vertex === vertex && e.action === action && e.recovery === recovery;
export const actionEvent = (g, vertex, action, recovery = 0) => g.readEvents().find((e) => isAction(e, vertex, action, recovery));

// T17's error paths: every non-advance row of the transition table, reached through the interpreter.
export const WRONG_ADD = 'export const add = () => 0;\n';
export const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';
export const attemptsOf = (g, vertex, action, recovery = 0) => g.readEvents().filter((e) => isAction(e, vertex, action, recovery));

export const ok = (files) => ({ files, response: golden.greenResponse });

// The suite passes only once lib/add.mjs really adds, so a wrong green fails the Green Check.
export async function greenSetup(t, responses, integrity, git) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses }, integrity, git });
  g.options.exec = {
    runShell: async (command, opts) => {
      const file = join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs');
      if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
      return readFileSync(file, 'utf8').includes('a + b')
        ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
    },
  };
  return g;
}

// A stop's Terminal Reason names the deciding Action, that Action's Outcome and rule, and a sentence of its own.
export function stopReason(g, { vertex, action, recovery = 0, outcome, rule, comment }) {
  const reason = terminalReasonOf(g, { comment });
  assert.deepEqual(reason.decidedBy, { vertex, visit: 1, action, recovery });
  assert.equal(reason.outcome, outcome);
  assert.deepEqual(reason.rule, rule);
  assert.doesNotMatch(reason.text, /ended with|cannot run yet/, `a sentence naming the failure: ${reason.text}`);
  return reason;
}

// The Ticket branch as the injected git holds it: commit messages since the base, oldest first, and their subjects.
export async function branchMessages(g) {
  const log = await g.options.git.commitLog(g.worktree, golden.BRANCH);
  return log.filter((c) => c.sha !== g.base).map((c) => c.message).reverse();
}
export const subjects = async (g) => (await branchMessages(g)).map((m) => m.split('\n')[0]);
export const headSha = (g) => g.options.git.headSha(g.worktree);
// The Ticket branch's commit on origin, or null. A test that holds the repo lock passes the unlocked git.
export const originSha = (g, git = g.options.git) => git.remoteSha(g.mainRoot, golden.BRANCH);

// T17: the review and fix Procedures on an inline Flow matching request 3.3's illustration.
export const REVIEWER_PERSONA = '# reviewer\nJudge the diff.\n';
export const finding = (severity, file, issue) => ({ severity, file, issue, fix: 'Make it right.' });
export const review = (claim, findings = [], extra = {}) => ({
  claim, summary: `The review says ${claim}.`, dodMet: true, tddEvidenceOk: true, findings, diagnosis: '', ...extra,
});
export const reviewed = (response, files = {}) => ({ files, response });
export const fixed = (files) => ({ files, response: { ...golden.greenResponse, summary: 'Address the findings.' } });

export const MAJOR = finding('major', 'lib/add.mjs', 'add ignores non-number input at line 1');

// red(tests-fail) -> green(implement) -> reviewer(review); ok -> publish; changes -> {implementer-fix, max 2, exhausted
// needs-human}; repeat -> {senior-dev, max 1, exhausted needs-human}; implementer-fix(fix) and senior-dev(fix, maxVisits
// 1, exhausted needs-human) -> reviewer.
export async function reviewSetup(t, responses, opts) {
  const g = await reviewFlow(t, responses, opts);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  g.actions = g.events.filter((e) => e.type === 'action' && e.procedure);
  g.at = (vertex, visit, action, recovery = 0) => g.actions.filter((e) => e.visit === visit && isAction(e, vertex, action, recovery));
  return g;
}

export const REVIEW_INPUTS = golden.implInputs(['green', 'implementer-fix', 'senior-dev']);
// The fix reads the latest review's Findings, their file paths as its named tests, and the Red Evidence for the PR body.
export const FIX_INPUTS = {
  findings: { from: 'reviewer.review.response.findings' },
  testFiles: { from: 'reviewer.review.response.findings', pick: 'file' },
  red: { from: 'red.red-check.evidence' },
};

// `configure`, when given, edits the review configuration further.
export async function reviewFlow(t, responses, { exec, integrity, git, configure } = {}) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses }, integrity, git });
  golden.configure(g, (c) => {
    c.files['reviewer.md'] = golden.layerFile(REVIEWER_PERSONA);
    c.agents.reviewer = { ...golden.implementerAgent('reviewer.md'), model: 'model-r', access: 'read-only' };
    const { vertices } = c.flows.golden.ticket;
    vertices.green.route = { ok: 'reviewer' };
    vertices.reviewer = { use: 'reviewer', procedure: 'review', inputs: REVIEW_INPUTS,
      route: { ok: 'publish', changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } },
        repeat: { to: 'senior-dev', max: 1, exhausted: { end: 'needs-human' } } } };
    vertices['implementer-fix'] = { use: 'implementer', procedure: 'fix', inputs: FIX_INPUTS, route: { ok: 'reviewer' } };
    vertices['senior-dev'] = { use: 'implementer', procedure: 'fix', maxVisits: 1, exhausted: { end: 'needs-human' }, inputs: FIX_INPUTS,
      route: { ok: 'reviewer' } };
    vertices.publish.inputs = REVIEW_INPUTS;
  });
  if (configure) golden.configure(g, configure);
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
// The saved row read without awaiting, for a getter that cannot await.
export const ticketRow = (g) => JSON.parse(record.openDb(g.commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(golden.TICKET).json);
export const attemptMarker = (g, ...at) => golden.markerOf(g.rec, ...at);

// #66: GitHub writes and push retry recognised transient failures inside the Action, through the marker lookup.
export const PR = 7;
export const okReview = { 'reviewer/1/review/1': reviewed(review('ok')) };
export const REVIEW_COMMENT = 'reviewer/1/comment/0';
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
export function contendRepoLock(t, commonDir, during) {
  let state = 'idle';
  let held = null;
  const previous = locks.setAttemptWrapper(async (lock, attempt) => {
    if (lock.commonDir !== commonDir || lock.name !== 'repo') return attempt();
    if (state === 'armed') {
      state = 'holding';
      held = await attempt();
      return null;
    }
    if (state === 'holding') {
      state = 'released';
      await during();
      await locks.release(held);
    }
    return attempt();
  });
  t.after(() => locks.setAttemptWrapper(previous));
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
