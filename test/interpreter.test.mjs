import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as marker from '../lib/marker.mjs';
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
  const session = g.rec.sessions['1/green'];
  assert.ok(session, 'green session recorded under 1/green');
  assert.equal(session.sessionId, 'fake-session-2');
  assert.match(session.transcriptPath, /fake-session-2\.jsonl$/);
  assert.equal(session.usage.input, 200);
  assert.equal(g.rec.sessions['1/red'].sessionId, 'fake-session-1');
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
