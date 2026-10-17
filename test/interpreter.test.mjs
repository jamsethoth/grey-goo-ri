import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as marker from '../lib/marker.mjs';
import * as checks from '../lib/checks.mjs';
import * as briefs from '../lib/briefs.mjs';
import * as golden from './support/golden.mjs';

const TDD_PHASES = ['red', 'still-green', 'green', 'test-fix'];

const FIRST_VISIT = [
  ['red', 1], ['red', 2], ['red', 3], ['green', 1], ['green', 2], ['green', 3], ['green', 4], ['green', 5],
].map(([phase, ordinal]) => ({ phase, ordinal, attempt: 1, outcome: 'ok' }));

async function firstVisit(t) {
  const g = await golden.setup(t);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  return g;
}

const intents = (rec, action) => rec.log.filter((e) => e.step === 'intent' && e.action === action);
const steps = (rec, m) => rec.log.filter((e) => e.marker === m).map((e) => e.step);
const actionMarker = (g, phase, ordinal) => marker.formatMarker({
  execution: g.rec.execution, vertex: 'implementer', visit: 1, phase, ordinal, run: g.rec.run, attempt: 1,
});

test('golden: first-visit pass runs the tdd actions in order to done', async (t) => {
  const g = await firstVisit(t);

  assert.deepEqual(golden.trace(g.events).filter((e) => TDD_PHASES.includes(e.phase)), FIRST_VISIT);
  const end = g.events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'done');
  assert.equal(end.ticket, golden.TICKET);

  const actions = g.events.filter((e) => e.type === 'action' && TDD_PHASES.includes(e.phase));
  for (const e of actions) {
    const at = `${e.phase}/${e.ordinal}`;
    assert.equal(e.schema, 2, at);
    assert.equal(e.vertex, 'implementer', at);
    assert.equal(e.visit, 1, at);
    assert.equal(e.procedure, 'tdd', at);
    assert.equal(e.attempt, 1, at);
    assert.equal(e.direction, 'advance', at);
    assert.ok(e.signals != null, `${at} carries its signals`);
    assert.equal(typeof e.rule, 'string', at);
    assert.ok(e.rule.length > 0, at);
  }
  for (const [phase, session] of [['red', 'fake-session-1'], ['green', 'fake-session-2']]) {
    const e = actions.find((a) => a.phase === phase && a.ordinal === 1);
    assert.equal(e.agent, true, phase);
    assert.equal(e.sessionId, session, phase);
    assert.equal(e.lineage, null, `${phase} starts a fresh session`);
    assert.match(e.transcriptPath, new RegExp(`${session}\\.jsonl$`), phase);
    assert.equal(e.usage.cumulative.costUsd, null, `${phase}: absent cost capability is null`);
    assert.equal(e.usage.cumulative.reasoning, null, `${phase}: absent reasoning capability is null`);
    assert.equal(typeof e.usage.cumulative.input, 'number', phase);
  }
  for (const e of actions.filter((a) => a.ordinal !== 1)) assert.notEqual(e.agent, true, `${e.phase}/${e.ordinal} is deterministic`);

  // Two commits on the branch, each carrying both trailers.
  const messages = golden.sh(g.worktree, 'log', '--format=%B%x00', `${g.base}..HEAD`).split('\0').map((m) => m.trim()).filter(Boolean).reverse();
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^test: /);
  assert.match(messages[1], /^feat: /);
  for (const [i, m] of messages.entries()) {
    assert.ok(m.includes('Feature-Flow-Stage: implementer fake/model-x/high'), m);
    assert.ok(m.includes(`Gg-Action: ${actionMarker(g, i === 0 ? 'red' : 'green', 3)}`), m);
  }
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'));

  // The draft PR body carries the marker line, the red Evidence and the provenance row.
  const create = g.gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create.args.includes('--draft'));
  const body = g.gh.pr().body;
  assert.ok(body.includes(marker.markerComment(actionMarker(g, 'green', 5))), body);
  assert.ok(body.includes("Cannot find module 'lib/add.mjs'"), 'red evidence in the PR body');
  assert.match(body, /^\| implementer \| fake \| model-x \| high \| /m);
  assert.equal(g.gh.pr().isDraft, false, 'done marks the PR ready');

  assert.ok(g.rec.cursor.vertex === 'done' || (g.rec.cursor.phase === 'green' && g.rec.cursor.ordinal > 5), JSON.stringify(g.rec.cursor));
  assert.equal(g.rec.visits.implementer, 1);
});

test('the green call is a fresh session with the full brief', async (t) => {
  const g = await firstVisit(t);
  assert.equal(g.harness.calls.length, 2);
  const [red, green] = g.harness.calls;
  assert.equal(red.resume, null);
  assert.equal(green.resume, null);
  assert.ok(green.brief.includes('test/add.test.mjs'), 'committed test list in the green brief');
  assert.ok(green.brief.includes("Cannot find module 'lib/add.mjs'"), 'red output in the green brief');
  for (const call of [red, green]) {
    assert.equal(call.personaBytes, golden.PERSONA, 'persona bytes come from the visit snapshot');
    assert.equal(call.personaHash, red.personaHash);
  }
  const session = g.rec.sessions['implementer/1/green'];
  assert.ok(session, 'green session recorded under implementer/1/green');
  assert.equal(session.sessionId, 'fake-session-2');
  assert.match(session.transcriptPath, /fake-session-2\.jsonl$/);
  assert.equal(session.usage.input, 200);
  assert.equal(g.rec.sessions['implementer/1/red'].sessionId, 'fake-session-1');
});

test('every side-effect action leaves intent, evidence and completion with the full payload', async (t) => {
  const g = await firstVisit(t);
  const all = g.rec.log.filter((e) => e.step === 'intent');
  assert.ok(all.length > 0);
  for (const i of all) assert.deepEqual(steps(g.rec, i.marker), ['intent', 'evidence', 'complete'], `${i.action} ${i.marker}`);
  assert.deepEqual(record.openIntents(g.rec), []);

  const commits = intents(g.rec, 'commit');
  assert.equal(commits.length, 2);
  for (const c of commits) {
    assert.deepEqual(Object.keys(c.payload).sort(), ['message', 'parent', 'tree']);
    assert.ok(c.payload.message.includes(`Gg-Action: ${c.marker}`));
  }
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const evidenceOf = (m) => g.rec.log.find((e) => e.marker === m && e.step === 'evidence').evidence;
  assert.equal(evidenceOf(commits[1].marker).sha, head);

  const [push] = intents(g.rec, 'push');
  assert.deepEqual(push.payload, { branch: golden.BRANCH, sha: head });
  assert.equal(evidenceOf(push.marker).remoteSha, head);

  const [pr] = intents(g.rec, 'pr-upsert');
  assert.equal(pr.payload.branch, golden.BRANCH);
  assert.equal(pr.payload.base, 'main');
  assert.equal(typeof pr.payload.title, 'string');
  assert.ok(pr.payload.title.length > 0);
  assert.equal(pr.payload.body, g.gh.pr().body, 'the PR intent holds the body itself');
  assert.equal(typeof pr.payload.bodyHash, 'string');
  assert.deepEqual(evidenceOf(pr.marker), { number: 7, url: 'https://github.com/o/r/pull/7' });

  const labels = intents(g.rec, 'label');
  assert.ok(labels.length > 0, 'the done label write goes through the log');
  for (const l of labels) assert.deepEqual(Object.keys(l.payload).sort(), ['add', 'remove', 'ticket']);
  assert.ok(labels.some((l) => l.payload.ticket === golden.TICKET && l.payload.add.includes('gg:state:ready-for-qa') && l.payload.remove.includes('gg:state:in-progress')));
});

test('commits match the recorded intent tree', async (t) => {
  const g = await firstVisit(t);
  const commits = intents(g.rec, 'commit');
  assert.equal(commits.length, 2);
  for (const c of commits) {
    const { sha } = g.rec.log.find((e) => e.marker === c.marker && e.step === 'evidence').evidence;
    assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^{tree}`), c.payload.tree);
    assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^`), c.payload.parent);
    assert.equal(golden.sh(g.worktree, 'log', '-1', '--format=%B', sha).trim(), c.payload.message.trim());
  }
  assert.equal(commits[0].payload.parent, g.base);
  const red = golden.sh(g.worktree, 'ls-tree', '-r', '--name-only', commits[0].payload.tree);
  assert.ok(red.includes('test/add.test.mjs'));
  assert.ok(!red.includes('lib/add.mjs'), 'the test commit holds only the tests');
});

test('activity brackets every launched process', async (t) => {
  const g = await firstVisit(t);
  const kinds = new Set(g.activity.map((a) => a.what.split(/[ .]/)[0]));
  for (const k of ['harness', 'test', 'git', 'gh']) assert.ok(kinds.has(k), `${k} calls observed`);
  for (const a of g.activity) assert.equal(a.busy, true, `${a.what} ran while the worktree was busy`);
  const generations = [...new Set(g.activity.map((a) => a.generation))];
  assert.deepEqual(generations, [...generations].sort((x, y) => x - y), 'generations only rise');
  assert.ok(generations.length >= FIRST_VISIT.length, 'one busy generation per Action at least');
  for (let i = 1; i < generations.length; i++) assert.equal(generations[i] - generations[i - 1], 2, `rises by two per Action: ${generations}`);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.activity.filter((a) => a.what === 'harness').length, 2);
  assert.equal(g.rec.activity.busy, false);
});

test('the visit keeps the configuration pinned at entry when the node changes mid-visit', async (t) => {
  const g = await golden.setup(t);
  const vertex = g.flow.ticket.vertices.implementer;
  const run = g.harness.run;
  const seen = {};
  g.harness.run = async (call) => {
    seen[call.phase] = structuredClone({ node: call.node, access: call.access, persona: call.persona });
    if (call.phase === 'red') {
      vertex.node.model = 'model-y';
      vertex.node.access = 'read-only';
      vertex.options.requireTestPass = false;
      // Routing, Procedure and Declared Commands are pinned too: none of these may reach the rest of the Visit.
      vertex.procedure = 'fix';
      vertex.then = 'needs-human';
      g.options.commands.test = 'npm run other';
      call.node.effort = 'low';
      writeFileSync(g.personaPath, '# changed\n');
    }
    return run(call);
  };
  const { outcome } = await interpreter.runExecution(g.options);
  assert.deepEqual(seen.green, seen.red);
  assert.equal(seen.green.node.model, 'model-x');
  assert.equal(seen.green.access, 'workspace-write');
  assert.equal(seen.green.persona.bytes, golden.PERSONA);
  assert.equal(g.rec.snapshot.node.effort, 'high', 'a harness mutating its call does not reach the snapshot');
  assert.deepEqual(g.rec.snapshot.options, {});
  assert.match(golden.sh(g.worktree, 'log', '-1', '--format=%B'), /Feature-Flow-Stage: implementer fake\/model-x\/high/);
  assert.equal(outcome, 'done', 'routing follows the entry snapshot');
  assert.deepEqual([...new Set(g.readEvents().filter((e) => e.type === 'action' && e.procedure).map((e) => e.procedure))], ['tdd']);
  assert.ok(g.shells.every((s) => s.command === 'npm test'), `checks ran the pinned command: ${JSON.stringify(g.shells)}`);
  assert.equal(g.rec.snapshot.then, 'done');
  assert.equal(g.rec.snapshot.commands.test, 'npm test');
});

test('the red commit records a non-ASCII test path unquoted', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const red = responses['implementer/1/red/1'];
  red.files = { 'test/añadir.test.mjs': red.files['test/add.test.mjs'] };
  const g = await golden.setup(t, { responses });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'done');
  assert.deepEqual(g.rec.outputs.red.tests, ['test/añadir.test.mjs']);
});

test('a green call that changes the committed test is an integrity violation', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/green/1'].files['test/add.test.mjs'] = "import { add } from '../lib/add.mjs';\n// weakened\n";
  const g = await golden.setup(t, { responses });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'needs-human');
  const greenCheck = g.readEvents().find((e) => e.type === 'action' && e.phase === 'green' && e.ordinal === 2);
  assert.equal(greenCheck.outcome, 'integrity-violation');
  assert.equal(greenCheck.direction, 'stop');
  assert.deepEqual(greenCheck.violations, ['test/add.test.mjs']);
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', 'HEAD'), '2', 'no feat commit after the violation');
});

test('done removes in-progress and adds ready-for-qa', async (t) => {
  const g = await firstVisit(t);
  const args = g.gh.calls.map((c) => c.args);
  assert.ok(args.some((a) => a[0] === 'pr' && a[1] === 'ready' && a[2] === '7'), 'pr ready 7');
  const edit = args.find((a) => a[0] === 'issue' && a[1] === 'edit' && a[2] === String(golden.TICKET)
    && a.join(' ').includes('--add-label gg:state:ready-for-qa'));
  assert.ok(edit, 'issue edit adding ready-for-qa');
  assert.ok(edit.join(' ').includes('--remove-label gg:state:in-progress'));
  const end = g.events.find((e) => e.type === 'ticket_end');
  assert.equal(end.outcome, 'done');
  assert.equal(end.execution, g.rec.execution);
  assert.equal(end.run, g.rec.run);
  assert.ok(end.diffStats, 'ticket_end carries diff stats');
  assert.equal(end.diffStats.testFiles, 1);
});

// The Terminal Reason must agree in the record and on ticket_end, and (unless the caller checks its own comment) be
// posted once on the ticket, write-ahead, with the comment's Action Marker.
function terminalReasonOf(g, { comment = true } = {}) {
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

const tddTrace = (g) => golden.trace(g.readEvents()).filter((e) => TDD_PHASES.includes(e.phase));
const actionEvent = (g, phase, ordinal) => g.readEvents().find((e) => e.type === 'action' && e.phase === phase && e.ordinal === ordinal);

test('golden: a failed red retries still-green once then stops at needs-human with history', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  // The new test passes before any implementation exists, both times.
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.phase}/${e.ordinal}`), ['red/1', 'red/2', 'still-green/1', 'still-green/2']);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'still-green resumes the red session');
  const exhausted = actionEvent(g, 'still-green', 2);
  assert.equal(exhausted.outcome, 'red-failed');
  assert.equal(exhausted.rule, 'check-exhausted', 'the transition table derives red-failed');
  assert.equal(exhausted.direction, 'stop');
  assert.equal(actionEvent(g, 'red', 2).rule, 'check-failed', 'the first failing run retries through still-green');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', `${g.base}..HEAD`), '0', 'no commit on the branch');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the worktree is clean at the baseline head');
  assert.equal(g.rec.history.length, 1);
  assert.equal(g.rec.history[0].kind, 'red phase failed');
  assert.match(g.rec.history[0].text, /did not fail before implementation/);

  // The reset is a write-ahead side effect whose intent carries the baseline and the History item.
  const [reset] = intents(g.rec, 'reset');
  assert.equal(reset.marker, actionMarker(g, 'still-green', 2));
  assert.deepEqual({ ...reset.payload, untracked: undefined }, { baseline: g.base, history: g.rec.history[0], untracked: undefined });
  assert.deepEqual(reset.payload.untracked.files, {}, 'the rollback set of the first red call is saved too');
  assert.deepEqual(steps(g.rec, reset.marker), ['intent', 'evidence', 'complete']);
  assert.deepEqual(record.openIntents(g.rec), []);
  assert.equal(g.readEvents().at(-1).outcome, 'needs-human');

  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase: 'still-green', ordinal: 2 });
  assert.equal(reason.outcome, 'red-failed');
  assert.equal(reason.rule, 'check-exhausted');
  assert.equal(reason.text, "The red phase failed the Red Check (rule check-exhausted) and the agent's changes were discarded.");
  assert.match(g.gh.comments[0].body, /```\nThe new tests did not fail before implementation/, 'the diagnosis is posted fenced');
});

test('a failed red rollback removes an ignored test file the red call added', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/red/1'].files['test/extra.test.mjs'] = 'extra';
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), 'test/extra.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'still-green', 2).outcome, 'red-failed');
  assert.ok(!existsSync(join(g.worktree, 'test', 'extra.test.mjs')), 'the ignored test the red call added is removed');
});

test('uncommitted changes before red are held at needs-human and nothing is deleted', async (t) => {
  const g = await golden.setup(t);
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  writeFileSync(join(g.worktree, tracked), 'a human edit\n');
  writeFileSync(join(g.worktree, 'notes.txt'), 'untracked human work\n');
  const before = golden.sh(g.worktree, 'status', '--porcelain', '--untracked-files=all');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain', '--untracked-files=all'), before, 'every pre-existing change survives');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(g.rec.history.at(-1)?.kind, 'held');
  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.equal(reason.outcome, null);
  assert.equal(reason.rule, null);
  assert.match(reason.text, /uncommitted changes before red/);
});

test('an assume-unchanged edit before red is held too, so a failed red cannot reset it away', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  golden.sh(g.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(g.worktree, tracked), 'a hidden human edit\n');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 0, 'no agent runs over unknown changes');
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(readFileSync(join(g.worktree, tracked), 'utf8'), 'a hidden human edit\n');
});

test('golden: a blocked claim with passing tests stops at needs-human', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', notes: 'The ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.gh.comments.length, 1, 'exactly one blocked comment');
  const [comment] = g.gh.comments;
  assert.equal(comment.target, 'issue');
  assert.equal(comment.number, golden.TICKET);
  assert.match(comment.body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.equal(intents(g.rec, 'comment').length, 1, 'the comment goes through the write-ahead log');
  const subjects = golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean);
  assert.ok(!subjects.some((s) => s.startsWith('feat:')), `no feat commit: ${subjects}`);
  const edit = g.gh.calls.map((c) => c.args.join(' '))
    .find((a) => a.startsWith(`issue edit ${golden.TICKET}`) && a.includes('--add-label gg:state:needs-human'));
  assert.ok(edit, 'issue edit adding needs-human');
  assert.ok(edit.includes('--remove-label gg:state:in-progress'));

  const check = actionEvent(g, 'green', 2);
  assert.ok(check, 'the Green Check runs and is recorded');
  assert.equal(check.signals.claim.claim, 'blocked');
  assert.equal(check.signals.checks.find((c) => c.name === 'test').passed, true);
  assert.equal(check.rule, 'blocked');
  assert.equal(check.outcome, 'blocked');

  // The blocked comment carries the Terminal Reason, so there is still exactly one comment.
  const reason = terminalReasonOf(g, { comment: false });
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase: 'green', ordinal: 2 });
  assert.equal(reason.outcome, 'blocked');
  assert.equal(reason.rule, 'blocked');
  assert.equal(reason.text, 'The agent made a blocked Claim at green; its notes in the blocked comment say why.');
  assert.ok(!reason.text.includes('contradicts'), 'unfenced agent text stays out of the Terminal Reason');
  assert.ok(comment.body.includes(`**Terminal Reason:** ${reason.text}`), comment.body);
});

// Retries now run, so a run stop is the stop whose Outcome differs from the needs-human Terminal it routes to.
test('a run stop keeps the deciding Action\'s own Outcome in the Terminal Reason', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/red/1'] = { ...responses['implementer/1/red/1'], failure: { class: 'auth' } };
  const g = await golden.setup(t, { responses });
  assert.equal((await interpreter.runExecution(g.options)).outcome, 'needs-human');

  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase: 'red', ordinal: 1 });
  assert.equal(reason.outcome, 'run-stop', 'the Action\'s Outcome, not the Terminal it routed to');
  assert.equal(reason.rule, 'run-stop');
});

test('agent-reported test names stay out of a red-failed Terminal Reason and are fenced in its comment', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const injected = 'missing\n\n## injected heading';
  responses['implementer/1/red/1'] = { ...responses['implementer/1/red/1'], response: { ...golden.redResponse, tests: [injected] } };
  responses['implementer/1/still-green/1'] = { files: {}, response: { ...golden.redResponse, tests: [injected] } };
  const g = await golden.setup(t, { responses });
  await interpreter.runExecution(g.options);

  const reason = terminalReasonOf(g);
  assert.equal(reason.outcome, 'red-failed');
  assert.ok(!reason.text.includes('injected'), reason.text);
  const [comment] = g.gh.comments;
  assert.ok(!/^## injected heading$/m.test(comment.body), 'the diagnosis cannot render as markdown');
  assert.ok(comment.body.includes('injected heading'), 'the diagnosis is still posted, fenced');
});

test('the Terminal Reason is saved before any Terminal side effect, so a crash marking the PR ready keeps it', async (t) => {
  const g = await golden.setup(t);
  // A CrashError, since any other throw is now an unexpected fault handled inside runExecution.
  g.options.gh = { ...g.options.gh, markReady: async () => { throw new interpreter.CrashError('crash'); } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);

  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(saved.cursor.vertex, 'done');
  assert.equal(saved.terminalReason?.outcome, 'ok');
  assert.match(saved.terminalReason.text, new RegExp(`PR #${saved.pr} is ready for review\\.$`));
});

test('done carries a Terminal Reason naming the passed Checks and the ready PR', async (t) => {
  const g = await firstVisit(t);
  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase: 'green', ordinal: 5 });
  assert.equal(reason.outcome, 'ok');
  assert.equal(reason.rule, 'effect-completed');
  assert.equal(reason.text,
    `implementer visit 1 completed every tdd Action: the Red Check and the Green Check passed. PR #${g.rec.pr} is ready for review.`);
});

// ff's red-gate e2e cases on the fake harness: red writes test/fail.test.mjs, the runner answers with `run`,
// and green writes lib/add.mjs, after which the suite passes.
async function redGate(t, { tests, run }) {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/red/1'] = {
    files: { 'test/fail.test.mjs': "import assert from 'node:assert';\nassert.fail('rejects bad input');\n" },
    response: { ...golden.redResponse, tests },
  };
  const g = await golden.setup(t, { responses });
  g.options.exec = {
    runShell: async (command, opts) => existsSync(join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs'))
      ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false }
      : { timedOut: false, ...run },
  };
  g.result = await interpreter.runExecution(g.options);
  g.subjects = () => golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean);
  return g;
}

const FAIL_OUTPUT = 'not ok 1 - rejects bad input\n# fail 1';

test('a red run whose runner cannot start is not committed; red-failed records the reason and the next attempt sees it', async (t) => {
  const g = await redGate(t, { tests: ['rejects bad input'], run: { code: 127, output: 'ff-no-such-runner-xyz: command not found' } });
  assert.ok(!g.subjects().some((s) => s.startsWith('test:')), 'no test: commit');
  assert.equal(actionEvent(g, 'red', 2).outcome, 'red-failed');
  assert.equal(actionEvent(g, 'red', 2).rule, 'check-exhausted');
  assert.equal(g.rec.history[0]?.kind, 'red phase failed');
  const reason = g.rec.history[0].text;
  assert.match(reason, /could not start/);

  // A second Execution of the same Ticket, its history carried over by the caller, shows the reason in its red Brief.
  const next = record.createExecution({
    commonDir: g.commonDir, ticket: golden.TICKET, epic: 1, flow: { name: g.flow.name, entry: g.flow.ticket.entry },
    configHash: 'cfg-hash', run: '20261015T000100Z-def456', worktree: g.worktree, branch: golden.BRANCH, base: 'main',
  });
  next.history = structuredClone(g.rec.history);
  await interpreter.runExecution({ ...g.options, record: next });
  const red = g.harness.calls.at(-1);
  assert.ok(red.brief.startsWith('RED PHASE'), 'the last call is the next red call');
  assert.ok(red.brief.includes(reason), 'history carries the reason into the next red brief');
});

test('a red run whose output names none of the reported tests is not committed', async (t) => {
  const g = await redGate(t, { tests: ['some other test'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.ok(!g.subjects().some((s) => s.startsWith('test:')));
  assert.equal(actionEvent(g, 'red', 2).outcome, 'red-failed');
  assert.match(g.rec.history[0]?.text ?? '', /does not mention any reported failing test/);
});

test('a red Phase that leaves nothing to commit fails red with "No tests were written."', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/red/1'] = { files: {}, response: { ...golden.redResponse, tests: ['rejects bad input'] } };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 1, output: FAIL_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'needs-human');
  const commit = actionEvent(g, 'red', 3);
  assert.equal(commit.outcome, 'red-failed');
  assert.equal(commit.rule, 'check-exhausted');
  assert.deepEqual(intents(g.rec, 'commit'), [], 'no commit intent for an empty commit');
  assert.deepEqual(g.rec.history, [{ kind: 'red phase failed', text: 'No tests were written.' }]);
  assert.equal(intents(g.rec, 'reset')[0].marker, actionMarker(g, 'red', 3));
});

test('a red run with a nonzero exit naming a reported test is committed as test:', async (t) => {
  const g = await redGate(t, { tests: ['rejects bad input'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.ok(g.subjects().some((s) => s.startsWith('test:')));
  assert.ok(!g.readEvents().some((e) => e.type === 'action' && e.outcome === 'red-failed'));
  assert.deepEqual(g.rec.history, []);
});

// T17's error paths: every non-advance row of the transition table, reached through the interpreter.
const WRONG_ADD = 'export const add = () => 0;\n';
const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';
const attemptsOf = (g, phase, ordinal) => g.readEvents().filter((e) => e.type === 'action' && e.phase === phase && e.ordinal === ordinal);
const ok = (files) => ({ files, response: golden.greenResponse });
const neededHuman = (g) => g.gh.calls.some((c) => c.args.join(' ').includes('--add-label gg:state:needs-human'));

// The suite passes only once lib/add.mjs really adds, so a wrong green fails the Green Check.
async function greenSetup(t, responses) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses } });
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
function stopReason(g, { phase, ordinal, outcome, rule, comment }) {
  const reason = terminalReasonOf(g, { comment });
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer', visit: 1, phase, ordinal });
  assert.equal(reason.outcome, outcome);
  assert.equal(reason.rule, rule);
  assert.doesNotMatch(reason.text, /ended with|cannot run yet/, `a sentence naming the failure: ${reason.text}`);
  return reason;
}

test('golden: an invalid structured response is retried once with a nudge then stops', async (t) => {
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'implementer/1/green/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: null },
    'implementer/1/green/2': { files: {}, response: { ...golden.greenResponse, claim: 'ok blocked' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const green = attemptsOf(g, 'green', 1);
  assert.deepEqual(green.map((e) => [e.attempt, e.rule]), [[1, 'parse-retry'], [2, 'parse-exhausted']]);
  assert.equal(green[1].outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 3);
  const [, first, nudge] = g.harness.calls;
  assert.equal(nudge.resume, 'fake-session-2', 'the nudge resumes the green session');
  assert.ok(first.brief.startsWith('GREEN PHASE'));
  assert.ok(!nudge.brief.startsWith('GREEN PHASE'), 'attempt 2 gets the nudge, not the green Brief again');
  assert.match(nudge.brief, /structured result/i);
  assert.notEqual(nudge.marker, first.marker, 'the marker names the attempt');
  assert.equal(g.rec.retries['implementer/1/green/1'].parse, 1);
  assert.ok(!golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').some((s) => s.startsWith('feat:')));
  stopReason(g, { phase: 'green', ordinal: 1, outcome: 'needs-human', rule: 'parse-exhausted' });
});

test('golden: an integrity violation restores the baseline and stops at needs-human', async (t) => {
  const g = await golden.setup(t);
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      golden.sh(g.worktree, 'add', '-A');
      golden.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
      g.agentCommit = golden.sh(g.worktree, 'rev-parse', 'HEAD');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 1);
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal(red.direction, 'stop');
  assert.ok(red.violations.some((v) => v.surface === 'head'), JSON.stringify(red.violations));
  assert.notEqual(g.agentCommit, g.base);
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.equal(golden.sh(g.worktree, 'branch', '--contains', g.agentCommit), '', 'the agent commit is gone from the branch');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '');
  assert.equal(g.harness.calls.length, 1, 'no retry after a violation');
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'integrity-violation', rule: 'integrity-violation' });
  assert.match(reason.text, /integrity/i);
  assert.match(g.gh.comments[0].body, /\bhead\b/, 'the comment names the surface');
  assert.ok(neededHuman(g), 'the ticket is at needs-human');
});

test('an integrity violation removes an injected ignored Protected File and restores a pre-existing one', async (t) => {
  const g = await golden.setup(t);
  mkdirSync(join(g.worktree, '.claude', 'skills', 'injected'), { recursive: true });
  writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(g.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      writeFileSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md'), 'injected\n');
      writeFileSync(local, '{"agent":true}\n');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 1);
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.violations.find((v) => v.surface === 'protected').after.sort(),
    ['.claude/settings.local.json', '.claude/skills/injected/SKILL.md']);
  assert.ok(!existsSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md')), 'the injected skill is removed');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', 'the pre-existing file keeps its baseline bytes');
});

test('a failing green check runs test-fix once then derives gate-failed(test)', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' }),
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.phase}/${e.ordinal}`),
    ['red/1', 'red/2', 'red/3', 'green/1', 'green/2', 'test-fix/1', 'test-fix/2']);
  assert.equal(actionEvent(g, 'green', 2).rule, 'check-failed', 'the first failure recovers through test-fix');
  assert.ok(tddTrace(g).every((e) => e.attempt === 1), 'test-fix is its own Actions, not another Attempt');
  const fix = g.harness.calls[2];
  assert.equal(fix.resume, 'fake-session-2', 'test-fix resumes the green session');
  assert.ok(fix.brief.includes(GREEN_FAIL_OUTPUT), 'test-fix gets the failing output');
  const exhausted = actionEvent(g, 'test-fix', 2);
  assert.equal(exhausted.outcome, 'gate-failed(test)');
  assert.equal(exhausted.rule, 'check-exhausted');
  assert.equal(g.rec.visits.implementer, 1, 'no Edge was traversed for the retry');
  const reason = stopReason(g, { phase: 'test-fix', ordinal: 2, outcome: 'gate-failed(test)', rule: 'check-exhausted' });
  assert.match(reason.text, /Green Check/);
});

test('a test-fix that changes the committed test is rolled back to its baseline and stops', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/add.test.mjs': '// weakened\n' }),
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(g, 'test-fix', 2);
  assert.equal(check.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'no forbidden edit or implementation file survives');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'), 'the committed test bytes are restored');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', 'HEAD'), '2', 'the red commit survives');
});

// Ignored paths survive git clean, so the rollback removes the ignored tests the agent added and only those.
function excludeTests(g, ...paths) {
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), paths.join(String.fromCharCode(10)));
}

test('a test-fix that adds an ignored test file has it removed by the rollback', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/injected.test.mjs': 'injected' }),
  });
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'test-fix', 2).violations, ['test/injected.test.mjs']);
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});

test('an ignored test file that was there before the call gets its bytes back from the rollback', async (t) => {
  const g = await greenSetup(t, { 'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/owner.test.mjs': 'agent' }) });
  excludeTests(g, 'test/owner.test.mjs');
  mkdirSync(join(g.worktree, 'test'), { recursive: true });
  writeFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'owner');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'green', 2).violations, ['test/owner.test.mjs']);
  assert.equal(readFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'utf8'), 'owner');
});

test('an integrity violation on a Protected File also removes an ignored test file the same Attempt added', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'test/injected.test.mjs': 'injected', 'AGENTS.md': 'agent' }),
  });
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'test-fix', 1).outcome, 'integrity-violation');
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});

test('a timed-out result gets one fresh attempt then needs-human', async (t) => {
  const red = golden.firstVisitResponses['implementer/1/red/1'];
  const g = await golden.setup(t, { responses: {
    'implementer/1/red/1': { ...red, result: { status: 'timed-out' } },
    'implementer/1/red/2': { ...red, result: { status: 'timed-out' } },
  } });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 1).map((e) => [e.attempt, e.rule]), [[1, 'timeout-retry'], [2, 'timeout-exhausted']]);
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.harness.calls[1].resume, 'fake-session-1', 'the fresh Attempt resumes the session');
  assert.equal(g.rec.retries['implementer/1/red/1'].timeout, 1);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'timeout-exhausted' });
  assert.match(reason.text, /timed out/);
});

test('a transient failure is retried within budget honouring retryAfterMs', async (t) => {
  const failed = { files: {}, response: null, failure: { class: 'transient', retryAfterMs: 5 } };
  const g = await golden.setup(t, { responses: {
    'implementer/1/red/1': failed, 'implementer/1/red/2': failed, 'implementer/1/red/3': failed,
  } });
  const sleeps = [];
  const { clock } = g.options;
  g.options.clock = { now: clock.now, sleep: async (ms) => { sleeps.push(ms); return clock.sleep(ms); } };
  const start = clock.now();
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(attemptsOf(g, 'red', 1).map((e) => [e.attempt, e.rule]),
    [[1, 'transient-retry'], [2, 'transient-retry'], [3, 'transient-exhausted']]);
  assert.equal(g.harness.calls.length, 3);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(clock.now() - start, 10, 'the injected clock advanced by retryAfterMs each time');
  assert.equal(g.rec.retries['implementer/1/red/1'].transient, 2);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'transient-exhausted' });
  assert.match(reason.text, /transient/);
});

test('an auth failure stops the run with its class', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(actionEvent(g, 'red', 1).failureClass, 'auth');
  assert.ok(neededHuman(g));
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'run-stop', rule: 'run-stop' });
  assert.match(reason.text, /auth/);
});

test('an auth failure keeps its run stop when the terminal comment fails', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth');
  assert.ok(neededHuman(g));
});

const terminalMarker = (g, phase, ordinal) => marker.formatMarker({
  execution: g.rec.execution, vertex: 'needs-human', visit: 1, phase, ordinal, run: g.rec.run, attempt: 1,
});

test('a fault interrupting a Terminal comment posts its own comment with the error and the interrupted Terminal Reason', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
  const real = g.options.gh.commentIssue;
  let calls = 0;
  g.options.gh = { ...g.options.gh, commentIssue: async (...a) => { if (calls++ === 0) throw new Error('gh comment down'); return real(...a); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(result.runStop?.failureClass, 'auth');
  const [posted, ...rest] = ticketComments(g);
  assert.equal(rest.length, 0);
  assert.match(posted.body, /gh comment down/, 'the fault comment carries the error, as its Terminal Reason says');
  assert.match(posted.body, /\*\*Interrupted:\*\* the needs-human Terminal, whose Terminal Reason was: .*auth/,
    'the run stop reason survives its failed comment');
  assert.ok(posted.body.includes(terminalMarker(g, 'fault', 1)), 'the fault report has its own Action Marker');
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(record.openIntents(rec).map((e) => e.marker), [terminalMarker(g, 'needs-human', 1)],
    'the intent of the interrupted comment stays open, and the fault report never replays it');
  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.interrupted.terminal, 'needs-human');
  assert.match(end.interrupted.reason.text, /auth/, 'ticket_end keeps the interrupted Terminal Reason too');
});

test('a crash inside the fault report replays its comment once on resume', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  const m = terminalMarker(g, 'fault', 1);
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point: 'after-effect' } }));
  const mid = await record.load(g.commonDir, 'ticket', golden.TICKET);
  const result = await interpreter.runExecution({ ...g.options, record: mid });

  assert.equal(result.fault, true);
  const posted = ticketComments(g);
  assert.equal(posted.length, 1, 'posted exactly once');
  assert.match(posted[0].body, /harness exploded/);
  assert.doesNotMatch(posted[0].body, /Interrupted/, 'a fault inside a Visit interrupted no Terminal');
  assert.ok(!('interrupted' in g.readEvents().find((e) => e.type === 'ticket_end')));
  assert.deepEqual(record.openIntents(await record.load(g.commonDir, 'ticket', golden.TICKET)), []);
});

test('an unknown failure goes to needs-human without retry', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'unknown' } } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.runStop, undefined);
  assert.equal(g.harness.calls.length, 1, 'no retry');
  assert.equal(attemptsOf(g, 'red', 1).length, 1);
  const reason = stopReason(g, { phase: 'red', ordinal: 1, outcome: 'needs-human', rule: 'unknown-failure' });
  assert.match(reason.text, /unknown/);
});

test('a rejecting harness is an unexpected fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal(g.harness.calls.length, 1, 'never retried');
  assert.equal(g.rec.state, 'fault');
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault', 'the record is marked on disk');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-human');
  assert.match(end.error, /harness exploded/);
  assert.ok(neededHuman(g), 'the ticket goes to needs-human');
});

test('a fault whose terminal comment also fails is still recorded as a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error('harness exploded') } } });
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new Error('gh comment down'); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.match(end.error, /harness exploded/);
  assert.ok(neededHuman(g), 'the label is still attempted');
});

test('a harness rejecting with an empty error is still a fault', async (t) => {
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: new Error() } } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true);
  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'fault');
  const end = g.readEvents().at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.ok(end.error, 'ticket_end carries a non-empty error');
});

test('a CrashError propagates untouched', async (t) => {
  const crash = new interpreter.CrashError('injected crash');
  const g = await golden.setup(t, { responses: { 'implementer/1/red/1': { throw: crash } } });
  await assert.rejects(interpreter.runExecution(g.options), (err) => err === crash);

  assert.equal((await record.load(g.commonDir, 'ticket', golden.TICKET)).state, 'active');
  assert.ok(!g.gh.calls.some((c) => c.args[0] === 'issue'), 'no label change and no comment');
  assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
});

test('blocked after still-green stops', async (t) => {
  const g = await golden.setup(t, { responses: {
    ...structuredClone(golden.firstVisitResponses),
    'implementer/1/still-green/1': { files: {}, response: { ...golden.redResponse, claim: 'blocked', notes: 'The tests cannot fail first.' } },
  } });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 2);
  assert.equal(g.gh.comments.length, 1);
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  stopReason(g, { phase: 'still-green', ordinal: 2, outcome: 'blocked', rule: 'blocked', comment: false });
});

test('blocked after test-fix stops', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': { files: {}, response: { ...golden.greenResponse, claim: 'blocked', notes: 'The test is wrong.' } },
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 3, 'red, green and test-fix');
  assert.equal(g.gh.comments.length, 1);
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  assert.equal(actionEvent(g, 'test-fix', 2)?.rule, 'blocked', 'the Green Check after test-fix still runs');
  stopReason(g, { phase: 'test-fix', ordinal: 2, outcome: 'blocked', rule: 'blocked', comment: false });
});

test('requireTestPass false is recorded on every event and does not block advance', async (t) => {
  const g = await greenSetup(t, { 'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) });
  g.flow.ticket.vertices.implementer.options = { requireTestPass: false };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  const check = actionEvent(g, 'green', 2);
  assert.equal(check.signals.checks.find((c) => c.name === 'test').passed, false, 'the failing Green Check is recorded');
  assert.equal(check.direction, 'advance');
  assert.ok(!tddTrace(g).some((e) => e.phase === 'test-fix'), 'a relaxed Green Check needs no recovery');
  assert.ok(golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').some((s) => s.startsWith('feat:')));
  const visit = g.readEvents().filter((e) => e.type === 'action' && e.procedure === 'tdd');
  assert.ok(visit.length > 0);
  for (const e of visit) assert.equal(e.requireTestPass, false, `${e.phase}/${e.ordinal}`);
});

test('a persona edit between green and test-fix does not reach the test-fix call', async (t) => {
  const g = await greenSetup(t, {
    'implementer/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'implementer/1/test-fix/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
  });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'green') writeFileSync(g.personaPath, '# edited mid-visit\n');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  assert.equal(g.harness.calls.length, 3);
  assert.equal(g.harness.calls[2].personaBytes, golden.PERSONA, 'test-fix gets the bytes pinned at Visit entry');
  assert.equal(g.harness.calls[2].personaHash, g.harness.calls[1].personaHash);
});

// T17: the review and fix Procedures on an inline Flow matching request 3.3's illustration.
const REVIEWER_PERSONA = '# reviewer\nJudge the diff.\n';
const finding = (severity, file, issue) => ({ severity, file, issue, fix: 'Make it right.' });
const review = (claim, findings = [], extra = {}) => ({
  claim, summary: `The review says ${claim}.`, dodMet: true, tddEvidenceOk: true, findings, diagnosis: '', ...extra,
});
const reviewed = (response, files = {}) => ({ files, response });
const fixed = (files) => ({ files, response: { ...golden.greenResponse, summary: 'Address the findings.' } });
const RIGHT_ADD = 'export const add = (a, b) => a + b;\n';
const MAJOR = finding('major', 'lib/add.mjs', 'add ignores non-number input at line 1');

// implementer(tdd) -> reviewer(review); changes -> {implementer-fix, max 2, exhausted needs-human}; implementer-fix(fix) -> reviewer.
async function reviewSetup(t, responses, opts) {
  const g = await reviewFlow(t, responses, opts);
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();
  g.actions = g.events.filter((e) => e.type === 'action' && e.procedure);
  g.at = (vertex, visit, phase, ordinal) => g.actions.filter((e) => e.vertex === vertex && e.visit === visit && e.phase === phase && e.ordinal === ordinal);
  g.subjects = () => golden.sh(g.worktree, 'log', '--format=%s', `${g.base}..HEAD`).split('\n').filter(Boolean).reverse();
  return g;
}

async function reviewFlow(t, responses, { exec } = {}) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...responses } });
  const reviewerPersona = join(g.root, 'personas', 'reviewer.md');
  writeFileSync(reviewerPersona, REVIEWER_PERSONA);
  const implementer = g.flow.ticket.vertices.implementer;
  g.flow.ticket.vertices = {
    implementer: { ...implementer, then: 'reviewer' },
    reviewer: {
      node: { ...structuredClone(implementer.node), model: 'model-r', persona: reviewerPersona, access: 'read-only' },
      procedure: 'review', options: {},
      route: { ok: 'done', changes: { to: 'implementer-fix', max: 2, exhausted: 'needs-human' }, misscoped: 'replan' },
    },
    'implementer-fix': { node: structuredClone(implementer.node), procedure: 'fix', options: {}, then: 'reviewer' },
  };
  if (exec) g.options.exec = exec;
  return g;
}

const prReviewComments = (g) => g.gh.comments.filter((c) => c.number === g.gh.pr()?.number && /### gg review/.test(c.body));
const ticketComments = (g) => g.gh.comments.filter((c) => c.target === 'issue' && c.number === golden.TICKET);

// A review or fix stop ends with one Terminal Reason in the record, on ticket_end and in exactly one ticket comment.
function reviewStopReason(g) {
  const reason = g.rec.terminalReason;
  assert.ok(reason, 'the record holds a Terminal Reason');
  assert.deepEqual(g.events.at(-1).reason, reason, 'ticket_end carries the same Terminal Reason');
  const posted = ticketComments(g).filter((c) => c.body.includes(`**Terminal Reason:** ${reason.text}`));
  assert.equal(posted.length, 1, 'the Terminal Reason is posted once on the ticket');
  assert.match(posted[0].body, /^<!-- gg-action gg:\S+ -->$/m);
  return reason;
}

test('golden: a changes verdict routes into the fix vertex and back to review then done', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok', [finding('minor', 'lib/add.mjs', 'name the parameters')])),
  });

  assert.equal(g.result.outcome, 'done');
  const seq = (vertex, visit, phase, n) => Array.from({ length: n }, (_, i) => `${vertex}/${visit}/${phase}/${i + 1}`);
  assert.deepEqual(g.actions.map((e) => `${e.vertex}/${e.visit}/${e.phase}/${e.ordinal}`), [
    ...seq('implementer', 1, 'red', 3), ...seq('implementer', 1, 'green', 5),
    ...seq('reviewer', 1, 'review', 4),
    ...seq('implementer-fix', 1, 'fix', 5),
    ...seq('reviewer', 2, 'review', 4),
  ]);
  for (const e of g.actions) assert.equal(e.attempt, 1, `${e.vertex}/${e.phase}/${e.ordinal}`);
  assert.deepEqual(g.actions.filter((e) => e.vertex === 'reviewer').map((e) => e.procedure), Array(8).fill('review'));
  assert.deepEqual(g.actions.filter((e) => e.vertex === 'implementer-fix').map((e) => e.procedure), Array(5).fill('fix'));
  assert.equal(g.at('reviewer', 1, 'review', 1)[0].outcome, 'changes');
  assert.equal(g.at('reviewer', 1, 'review', 1)[0].rule, 'claim-route', 'a changes claim routes through claim-route');
  assert.equal(g.at('reviewer', 2, 'review', 1)[0].outcome, 'ok');

  // The review is a read-only call with the diff and the captured Red and Green Evidence in its Brief.
  const [review1, fix, review2] = g.harness.calls.slice(2);
  assert.equal(review1.access, 'read-only');
  assert.ok(review1.brief.includes('a + b'), 'the diff is in the review Brief');
  assert.ok(review1.brief.includes(JSON.stringify(golden.RED_OUTPUT)), 'the Red Evidence is in the review Brief');
  assert.ok(review1.brief.includes(JSON.stringify(golden.GREEN_OUTPUT)), 'the Green Evidence is in the review Brief');
  assert.equal(review1.personaBytes, REVIEWER_PERSONA);
  // fix/1 is a fresh Session whose Brief carries the review Findings.
  assert.equal(fix.resume, null, 'fix never resumes');
  assert.ok(fix.brief.includes(MAJOR.issue), 'the Findings are in the fix Brief');
  assert.equal(fix.access, 'workspace-write');
  assert.equal(g.at('implementer-fix', 1, 'fix', 1)[0].lineage, null);
  assert.equal(review2.access, 'read-only');

  assert.deepEqual(g.subjects().map((s) => s.split(':')[0]), ['test', 'feat', 'fix']);
  assert.match(golden.sh(g.worktree, 'log', '-1', '--format=%B'), /Feature-Flow-Stage: implementer-fix fake\/model-x\/high/);
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'), 'fix/4 pushed');

  const comments = prReviewComments(g);
  assert.equal(comments.length, 2, 'two review comments on the PR');
  for (const c of comments) assert.match(c.body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.match(g.gh.pr().body, /^\| reviewer \| fake \| model-r \| high \| /m, 'the PR body carries the reviewer provenance row');
  assert.equal(g.gh.pr().isDraft, false);

  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 1);
  assert.deepEqual(g.rec.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
  assert.deepEqual(g.rec.outputs.reviews.map((r) => [r.vertex, r.visit]), [['reviewer', 1], ['reviewer', 2]]);
  assert.equal(g.events.at(-1).type, 'ticket_end');
  assert.equal(g.events.at(-1).outcome, 'done');
});

test('a restart at the review-to-fix boundary runs the pending fix with the saved edge count', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  g.flow.ticket.vertices.reviewer.route.changes.max = 1;
  const run = g.harness.run;
  let crashed = false;
  g.harness.run = async (call) => {
    if (call.phase === 'fix' && !crashed) { crashed = true; throw new interpreter.CrashError('crash'); }
    return run(call);
  };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(saved.traversals['reviewer->implementer-fix:changes'], 1);
  assert.equal(saved.cursor.vertex, 'implementer-fix');

  const before = g.harness.calls.length;
  const result = await interpreter.runExecution({ ...g.options, record: saved });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(g.harness.calls.slice(before).map((c) => (c.brief.startsWith('FIX ROUND') ? 'fix' : c.access)), ['fix', 'read-only'],
    'the restart runs the pending fix, then review, not the entry');
  assert.equal(saved.traversals['reviewer->implementer-fix:changes'], 1);
  assert.deepEqual(saved.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
});

test('two reviewer vertices keep their own sessions and provenance rows', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('ok')),
    'reviewer-2/1/review/1': reviewed(review('ok')),
  });
  const { vertices } = g.flow.ticket;
  vertices.reviewer.route = { ...vertices.reviewer.route, ok: 'reviewer-2' };
  vertices['reviewer-2'] = { ...structuredClone(vertices.reviewer), route: { ...vertices.reviewer.route, ok: 'done' } };
  vertices['reviewer-2'].node.model = 'model-s';
  g.result = await interpreter.runExecution(g.options);

  assert.equal(g.result.outcome, 'done');
  assert.ok(g.rec.sessions['reviewer/1/review'] && g.rec.sessions['reviewer-2/1/review'], JSON.stringify(Object.keys(g.rec.sessions)));
  assert.match(g.gh.pr().body, /^\| reviewer \| fake \| model-r \| high \| /m, 'the first reviewer row survives');
  assert.match(g.gh.pr().body, /^\| reviewer-2 \| fake \| model-s \| high \| /m);
});

test('the changes edge exhausts after max traversals to needs-human', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
    'reviewer/2/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'second problem')])),
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // two\n' }),
    'reviewer/3/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'third problem')])),
  });

  assert.equal(g.result.outcome, 'needs-human');
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 2, 'two changes verdicts traverse the edge twice');
  assert.equal(g.rec.visits['implementer-fix'], 2);
  assert.equal(g.rec.visits.reviewer, 3);
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX ROUND')).length, 2, 'no third fix call');
  assert.ok(!g.actions.some((e) => e.vertex === 'implementer-fix' && e.visit === 3));
  const third = g.actions.filter((e) => e.vertex === 'reviewer' && e.visit === 3);
  assert.ok(third.some((e) => e.exhausted === true), 'the deciding Action Event records exhausted');
  assert.ok(!g.actions.filter((e) => e.vertex === 'reviewer' && e.visit < 3).some((e) => e.exhausted), 'only the third review exhausts');
  assert.ok(neededHuman(g));

  const reason = reviewStopReason(g);
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.decidedBy.visit, 3);
  assert.equal(reason.outcome, 'changes');
});

test('review ok without evidence is changes through the review-pass check', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('ok', [finding('blocker', 'lib/add.mjs', 'add drops the second argument')])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => b + a;\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });

  const decided = g.actions.filter((e) => e.vertex === 'reviewer' && e.visit === 1 && e.check === 'review-pass');
  assert.equal(decided.length, 1, 'review-pass is evaluated once on the Structured Response');
  assert.equal(decided[0].rule, 'check-failed');
  assert.equal(decided[0].outcome, 'changes');
  assert.equal(decided[0].signals.claim.claim, 'ok', 'the agent claimed ok');
  assert.equal(decided[0].signals.checks.find((c) => c.name === 'review-pass').passed, false);
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 1, 'the changes edge is taken');
  assert.equal(g.result.outcome, 'done');
});

test('a repeated findings hash is flagged', async (t) => {
  const same = [MAJOR, finding('major', 'test/add.test.mjs', 'the test   misses negatives on line 3')];
  const reworded = [finding('major', 'test/add.test.mjs', 'the test misses negatives on line 9'), { ...MAJOR, issue: 'add ignores non-number input at line 7' }];
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', same)),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // tried\n' }),
    'reviewer/2/review/1': reviewed(review('changes', reworded)),
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // again\n' }),
    'reviewer/3/review/1': reviewed(review('ok')),
  });

  const [first, second] = g.rec.outputs.reviews;
  assert.deepEqual([first.vertex, first.visit, second.vertex, second.visit], ['reviewer', 1, 'reviewer', 2]);
  assert.equal(first.findingsHash, checks.findingsHash(same));
  assert.equal(second.findingsHash, first.findingsHash, 'normalised Findings hash the same');
  const hashed = (visit) => g.at('reviewer', visit, 'review', 2)[0];
  assert.notEqual(hashed(1).repeat, true, 'the first review is not a repeat');
  assert.equal(hashed(2).repeat, true, 'the second review is flagged as a repeat');
  assert.equal(hashed(2).outcome, 'changes', 'repeat is not routed in this slice');
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 2);
  assert.equal(g.result.outcome, 'done');
});

test('test-fix after fix resumes the fix session', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': WRONG_ADD }),
    'implementer-fix/1/test-fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  }, {
    exec: {
      runShell: async (command, opts) => {
        const file = join(opts?.cwd ?? '', 'lib', 'add.mjs');
        if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
        return readFileSync(file, 'utf8').includes('a + b')
          ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
      },
    },
  });

  assert.equal(g.at('implementer-fix', 1, 'fix', 2)[0]?.rule, 'check-failed');
  const fixCall = g.at('implementer-fix', 1, 'fix', 1)[0];
  const testFix = g.at('implementer-fix', 1, 'test-fix', 1)[0];
  assert.ok(testFix, 'test-fix/1 runs after the failing Green Check');
  assert.equal(testFix.lineage, 'fix', 'test-fix descends from the fix Phase');
  const call = g.harness.calls.find((c) => c.marker.includes(':test-fix:'));
  assert.equal(call.resume, fixCall.sessionId, 'test-fix resumes the fix session');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT));
  assert.equal(g.result.outcome, 'done');
});

test('a fix that changes an unnamed test is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n', 'test/add.test.mjs': '// weakened\n' }),
  });

  assert.equal(g.result.outcome, 'needs-human');
  const check = g.at('implementer-fix', 1, 'fix', 2)[0];
  assert.equal(check?.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
  assert.ok(!g.subjects().some((s) => s.startsWith('fix:')), 'no fix commit');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the fix edit is rolled back');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'));
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer-fix', visit: 1, phase: 'fix', ordinal: 2 });
  assert.equal(reason.outcome, 'integrity-violation');
});

test('a fix that changes a named test moves the immutability baseline', async (t) => {
  const TEST_EDIT = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
    'implementer-fix/1/fix/1': fixed({ 'test/add.test.mjs': TEST_EDIT }),
    'reviewer/2/review/1': reviewed(review('changes', [MAJOR])),
    // Leaves the test as fix 1 committed it: only a moved baseline lets this pass Test Immutability.
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/3/review/1': reviewed(review('ok')),
  });

  assert.equal(g.result.outcome, 'done');
  for (const visit of [1, 2]) {
    const check = g.at('implementer-fix', visit, 'fix', 2)[0];
    assert.equal(check?.outcome, 'ok', `fix visit ${visit}: ${check?.rule}`);
    assert.ok(!check.violations, `fix visit ${visit} has no violations`);
  }
  assert.deepEqual(g.subjects().map((s) => s.split(':')[0]), ['test', 'feat', 'fix', 'fix']);
  assert.equal(readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8'), TEST_EDIT);
  const reviews = g.harness.calls.filter((c) => c.access === 'read-only');
  assert.equal(reviews.length, 3);
  assert.ok(!reviews[0].brief.includes('## Test files changed since the red commit'), 'nothing changed before the fix');
  for (const r of reviews.slice(1)) {
    assert.ok(r.brief.includes('## Test files changed since the red commit\n- test/add.test.mjs'), 'every later review Brief lists the changed test');
  }
});

test('a fix with no edits keeps the moved immutability baseline', async (t) => {
  const TEST_EDIT = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
    'implementer-fix/1/fix/1': fixed({ 'test/add.test.mjs': TEST_EDIT }),
    'reviewer/2/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/2/fix/1': fixed({}),
    'reviewer/3/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/3/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/4/review/1': reviewed(review('ok')),
  });
  g.flow.ticket.vertices.reviewer.route.changes.max = 3;
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  const checks = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'implementer-fix' && e.phase === 'fix' && e.ordinal === 2);
  assert.deepEqual(checks.map((e) => [e.visit, e.outcome]), [[1, 'ok'], [2, 'ok'], [3, 'ok']]);
});

test('misscoped lands in replan with the diagnosis on ticket and epic', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const g = await reviewSetup(t, { 'reviewer/1/review/1': reviewed(review('misscoped', [], { diagnosis })) });

  assert.equal(g.result.outcome, 'replan');
  assert.equal(g.rec.state, 'replan');
  const end = g.events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'replan');
  const edit = g.gh.calls.map((c) => c.args.join(' '))
    .find((a) => a.startsWith(`issue edit ${golden.TICKET}`) && a.includes('--add-label gg:state:needs-replan'));
  assert.ok(edit, 'issue edit adding needs-replan');
  assert.ok(edit.includes('--remove-label gg:state:in-progress'));
  assert.ok(!neededHuman(g));

  const onTicket = ticketComments(g);
  assert.equal(onTicket.length, 1, 'the diagnosis comment carries the Terminal Reason, no second comment');
  assert.ok(onTicket[0].body.includes(diagnosis));
  const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.rec.epic);
  assert.equal(onEpic.length, 1, 'the diagnosis is posted on the epic');
  assert.ok(onEpic[0].body.includes(diagnosis));
  const reason = reviewStopReason(g);
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.outcome, 'misscoped');
  assert.ok(!reason.text.includes(diagnosis), 'agent text stays fenced, out of the Terminal Reason');
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX ROUND')).length, 0);
});

test('a review that changes the tree is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  });

  assert.equal(g.result.outcome, 'needs-human');
  const call = g.at('reviewer', 1, 'review', 1)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(call.violations.some((v) => v.surface === 'tree'), JSON.stringify(call.violations));
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
  // The reset checks the file out again, so core.autocrlf may give it CRLF line endings on Windows.
  assert.equal(readFileSync(join(g.worktree, 'lib', 'add.mjs'), 'utf8').replace(/\r\n/g, '\n'), RIGHT_ADD);
  assert.equal(prReviewComments(g).length, 0, 'no review comment after a violation');
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'reviewer', visit: 1, phase: 'review', ordinal: 1 });
  assert.equal(reason.outcome, 'integrity-violation');
  assert.match(g.gh.comments.at(-1).body, /\btree\b/);
});

test('a review on a workspace-write node is still read-only', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  });
  g.flow.ticket.vertices.reviewer.node.access = 'workspace-write';
  g.result = await interpreter.runExecution(g.options);
  const events = g.readEvents();

  assert.equal(g.result.outcome, 'needs-human');
  const reviewCall = g.harness.calls.find((c) => c.schema === briefs.REVIEW_SCHEMA);
  assert.equal(reviewCall.access, 'read-only', 'the Harness runs the review read-only');
  const call = events.find((e) => e.type === 'action' && e.vertex === 'reviewer' && e.phase === 'review' && e.ordinal === 1);
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(call.violations.some((v) => v.surface === 'tree'), JSON.stringify(call.violations));
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
});
