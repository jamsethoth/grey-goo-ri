import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  firstVisit, intents, steps, actionMarker, terminalReasonOf, actionEvent, loadTicket, branchMessages, subjects, headSha,
  greenSetup, ok, WRONG_ADD,
} from '../support/interpreter.mjs';

const DONE = ['intent', 'evidence', 'complete'];

test('a persona file name is read from the shipped personas directory', async (t) => {
  const g = await golden.setup(t);
  for (const vertex of Object.values(g.flow.ticket.vertices).filter((v) => v.agent)) vertex.agent.persona = 'implementer.md';
  await interpreter.runExecution(g.options);
  const shipped = readFileSync(new URL('../../defaults/personas/implementer.md', import.meta.url), 'utf8');
  assert.equal(g.harness.calls[0].personaBytes, shipped);
});

test('every side-effect action leaves intent, evidence and completion with the full payload', async (t) => {
  const g = await firstVisit(t);
  assert.deepEqual(g.rec.log.filter((e) => e.step === 'intent').map((i) => [i.action, steps(g.rec, i.marker)]), [
    ['call', DONE], ['commit', DONE], ['call', DONE], ['commit', DONE], ['push', DONE], ['pr-upsert', DONE], ['pr-upsert', DONE],
    ['pr-ready', DONE], ['comment', DONE], ['label', DONE],
  ]);
  assert.deepEqual(record.openIntents(g.rec), []);

  // Each agent Attempt is write-ahead too, its intent carrying the baseline the Integrity Assertion compares against,
  // which a resume reads back from the State Database.
  const calls = intents(g.rec, 'call');
  assert.deepEqual(calls.map((c) => c.marker), [actionMarker(g, 'red', 'red'), actionMarker(g, 'green', 'green')]);
  const saved = intents(await loadTicket(g), 'call');
  assert.deepEqual(saved.map((c) => c.payload.baseline), calls.map((c) => c.payload.baseline), 'each baseline reads back as it was taken');
  assert.equal(saved[0].payload.baseline.head, g.base, 'red compares against the base');

  const commits = intents(g.rec, 'commit');
  assert.equal(commits.length, 2);
  assert.deepEqual(Object.keys(commits[0].payload).sort(), ['message', 'parent', 'tree']);
  assert.ok(commits[0].payload.message.includes(`Gg-Action: ${commits[0].marker}`), commits[0].payload.message);
  assert.deepEqual(Object.keys(commits[1].payload).sort(), ['message', 'parent', 'tree']);
  assert.ok(commits[1].payload.message.includes(`Gg-Action: ${commits[1].marker}`), commits[1].payload.message);
  const head = await headSha(g);
  const evidenceOf = (m) => g.rec.log.find((e) => e.marker === m && e.step === 'evidence').evidence;
  assert.equal(evidenceOf(commits[1].marker).sha, head);

  const [push] = intents(g.rec, 'push');
  assert.deepEqual(push.payload, { branch: golden.BRANCH, sha: head });
  assert.equal(evidenceOf(push.marker).remoteSha, head);

  // publish's re-render is the PR body GitHub shows.
  const pr = intents(g.rec, 'pr-upsert').at(-1);
  assert.equal(pr.payload.branch, golden.BRANCH);
  assert.equal(pr.payload.base, 'main');
  assert.equal(pr.payload.title, 'Add two numbers');
  assert.equal(pr.payload.body, g.gh.pr().body, 'the PR intent holds the body itself');
  assert.equal(typeof pr.payload.bodyHash, 'string');
  assert.deepEqual(evidenceOf(pr.marker), { number: 7, url: 'https://github.com/o/r/pull/7' });

  // pr-ready's saved target: the pushed commit and the tree publish's Check passed on.
  assert.deepEqual(intents(g.rec, 'pr-ready').map((r) => r.payload), [{ number: 7, sha: head, tree: await g.options.git.treeOf(g.worktree, head) }]);

  assert.deepEqual(intents(g.rec, 'label').map((l) => l.payload),
    [{ ticket: golden.TICKET, add: ['gg:state:ready-for-qa'], remove: ['gg:state:in-progress'] }], 'the ready-for-qa label write goes through the log');
});

// green's Visit has two calls when the first fails the Green Check: green, then its recovery pass.
test('the visit keeps the configuration pinned at entry when the agent changes mid-visit', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
  });
  g.options.testPaths = ['test/**'];
  const { runShell } = g.options.exec;
  const commands = [];
  // green's own snapshot, as its last Check saw it: publish pins its own after.
  let pinned;
  g.options.exec = { runShell: (command, opts) => {
    commands.push(command);
    if (g.rec.cursor.vertex === 'green') pinned = structuredClone(g.rec.snapshot);
    return runShell(command, opts);
  } };
  const vertex = g.flow.ticket.vertices.green;
  const run = g.harness.run;
  const seen = {};
  g.harness.run = async (call) => {
    seen[call.phase] = structuredClone({ agent: call.agent, access: call.access, persona: call.persona });
    if (call.phase === 'green') {
      vertex.agent.model = 'model-y';
      vertex.agent.access = 'read-only';
      vertex.options.edited = true;
      // Routing, Procedure and Declared Commands are pinned too: none of these may reach the rest of the Visit.
      vertex.procedure = 'fix';
      vertex.route = { ok: { end: 'needs-human' } };
      g.options.commands.test = 'npm run other';
      g.options.testPaths.push('lib/**');
      call.agent.effort = 'low';
      writeFileSync(g.personaPath, '# changed\n');
    }
    return run(call);
  };
  const { outcome } = await interpreter.runExecution(g.options);
  assert.deepEqual(seen.recover, seen.green);
  assert.equal(seen.recover.agent.model, 'model-x');
  assert.equal(seen.recover.access, 'workspace-write');
  assert.equal(seen.recover.persona.bytes, golden.PERSONA);
  assert.equal(pinned.agent.effort, 'high', 'a harness mutating its call does not reach the snapshot');
  assert.deepEqual(pinned.options, {});
  assert.match((await branchMessages(g)).at(-1), /Feature-Flow-Stage: green fake\/model-x\/high/);
  assert.equal(outcome, 'ready-for-qa', 'routing follows the entry snapshot');
  assert.deepEqual([...new Set(g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'green').map((e) => e.procedure))], ['implement']);
  assert.deepEqual(commands, ['npm test', 'npm test', 'npm test', 'npm run other'], "green's Checks ran its pinned command; publish pins the edited one");
  assert.deepEqual(pinned.route, { ok: 'publish' });
  assert.equal(pinned.commands.test, 'npm test');
  assert.deepEqual(pinned.testPaths, ['test/**']);
});

test('the red commit records a non-ASCII test path unquoted', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const red = responses['red/1/red/1'];
  red.files = { 'test/añadir.test.mjs': red.files['test/add.test.mjs'] };
  const g = await golden.setup(t, { responses });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(g.rec.outputs.find((o) => o.vertex === 'red' && o.action === 'commit').value.files, ['test/añadir.test.mjs']);
});

test('ready-for-qa removes in-progress and adds its label', async (t) => {
  const g = await golden.setup(t);
  g.gh.labels.add('gg:state:in-progress');
  await interpreter.runExecution(g.options);

  assert.equal(g.gh.pr().number, 7);
  assert.equal(g.gh.pr().isDraft, false, 'PR 7 is ready');
  assert.deepEqual([...g.gh.labels], ['gg:state:ready-for-qa']);
  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.execution, g.rec.execution);
  assert.equal(end.run, g.rec.run);
  assert.ok(end.diffStats, 'ticket_end carries diff stats');
  assert.equal(end.diffStats.testFiles, 1);
});

test('ready-for-qa counts the files under the pinned testPaths as tests in its diff stats', async (t) => {
  const g = await golden.setup(t);
  g.options.testPaths = ['test/**', 'lib/**'];
  await interpreter.runExecution(g.options);

  const end = g.readEvents().find((e) => e.type === 'ticket_end');
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.diffStats.files, 2);
  assert.equal(end.diffStats.testFiles, 2, 'lib/add.mjs counts as a test because the pinned testPaths name lib/');
});

test('golden: a blocked claim with passing tests stops at needs-human', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'].response = { ...golden.greenResponse, claim: 'blocked', diagnosis: 'The ticket contradicts itself.' };
  const g = await golden.setup(t, { responses });
  g.gh.labels.add('gg:state:in-progress');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.gh.comments.length, 1, 'exactly one blocked comment');
  const [comment] = g.gh.comments;
  assert.equal(comment.target, 'issue');
  assert.equal(comment.number, golden.TICKET);
  assert.match(comment.body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.equal(intents(g.rec, 'comment').length, 1, 'the comment goes through the write-ahead log');
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)'], 'no feat commit');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'needs-human replaces in-progress');

  const check = actionEvent(g, 'green', 'test');
  assert.ok(check, 'the Green Check runs and is recorded');
  assert.equal(check.signals.claim.claim, 'blocked');
  assert.deepEqual(check.signals.checks.map((c) => [c.id, c.state]), [['test', 'passed']]);
  assert.deepEqual(check.rule, { table: 'stopped', row: null });
  assert.equal(check.outcome, 'blocked');

  // The blocked comment carries the Terminal Reason, so there is still exactly one comment.
  const reason = terminalReasonOf(g, { comment: false });
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 0 });
  assert.equal(reason.outcome, 'blocked');
  assert.deepEqual(reason.rule, { table: 'stopped', row: null });
  assert.equal(reason.text, 'The agent made a blocked Claim at green; its diagnosis in the blocked comment says why.');
  assert.ok(!reason.text.includes('contradicts'), 'unfenced agent text stays out of the Terminal Reason');
  assert.ok(comment.body.includes(`**Terminal Reason:** ${reason.text}`), comment.body);
});

test("agent-reported test names stay out of a failed red's Terminal Reason and are fenced in its comment", async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const injected = 'missing\n\n## injected heading';
  responses['red/1/red/1'] = { ...responses['red/1/red/1'], response: { ...golden.redResponse, tests: [injected] } };
  responses['red/1/recover/1'] = { files: {}, response: { ...golden.redResponse, tests: [injected] } };
  const g = await golden.setup(t, { responses });
  await interpreter.runExecution(g.options);

  const reason = terminalReasonOf(g);
  assert.equal(reason.outcome, 'failed');
  assert.ok(!reason.text.includes('injected'), reason.text);
  const [comment] = g.gh.comments;
  assert.ok(!/^## injected heading$/m.test(comment.body), 'the diagnosis cannot render as markdown');
  assert.ok(comment.body.includes('injected heading'), 'the diagnosis is still posted, fenced');
});

test('the Terminal Reason is saved before any Terminal side effect, so a crash posting the end comment keeps it', async (t) => {
  const g = await golden.setup(t);
  // A CrashError, since any other throw is now an unexpected fault handled inside runExecution.
  g.options.gh = { ...g.options.gh, commentIssue: async () => { throw new interpreter.CrashError('crash'); } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);

  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(saved.cursor.vertex, 'ready-for-qa');
  assert.equal(saved.terminalReason?.outcome, 'ok');
  assert.match(saved.terminalReason.text, new RegExp(`PR #${saved.pr} is ready for review\\.$`));
});

test('ready-for-qa carries a Terminal Reason naming the passed Checks and the ready PR', async (t) => {
  const g = await firstVisit(t);
  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'publish', visit: 1, action: 'pr-ready', recovery: 0 });
  assert.equal(reason.outcome, 'ok');
  assert.deepEqual(reason.rule, { table: 'passed', row: null }, 'no passed row matched, so the token ok');
  assert.equal(reason.text, `publish visit 1 completed every publish Action: test passed. PR #${g.rec.pr} is ready for review.`);
});

// ff's red-gate e2e cases on the fake harness: red writes test/fail.test.mjs, the runner answers with `run`,
// and green writes lib/add.mjs, after which the suite passes. A recoverable failure's recovery pass changes nothing.
async function redGate(t, { tests, run }) {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'] = {
    files: { 'test/fail.test.mjs': "import assert from 'node:assert';\nassert.fail('rejects bad input');\n" },
    response: { ...golden.redResponse, tests },
  };
  responses['red/1/recover/1'] = { files: {}, response: { ...golden.redResponse, tests } };
  const g = await golden.setup(t, { responses });
  g.options.exec = {
    runShell: async (command, opts) => existsSync(join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs'))
      ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false }
      : { timedOut: false, ...run },
  };
  g.result = await interpreter.runExecution(g.options);
  return g;
}

const FAIL_OUTPUT = 'not ok 1 - rejects bad input\n# fail 1';

test('a red run whose runner cannot start is not committed and fails with the reason', async (t) => {
  const g = await redGate(t, { tests: ['rejects bad input'], run: { code: 127, output: 'ff-no-such-runner-xyz: command not found' } });
  assert.deepEqual(await subjects(g), [], 'no test: commit');
  const check = actionEvent(g, 'red', 'red-check');
  assert.equal(check.outcome, 'failed');
  assert.deepEqual(check.rule, { table: 'failed', row: null }, 'a runner that cannot start is not recovered');
  assert.match(g.gh.comments[0].body, /```\nThe test runner could not start/, 'the reason is posted fenced');
});

test('a red run whose output names none of the reported tests is not committed', async (t) => {
  const g = await redGate(t, { tests: ['some other test'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.deepEqual(await subjects(g), [], 'no test: commit');
  assert.equal(actionEvent(g, 'red', 'red-check').outcome, 'recover', 'missing names are recoverable (N5)');
  assert.equal(actionEvent(g, 'red', 'red-check', 1).outcome, 'failed');
  assert.match(g.gh.comments[0].body, /does not mention any reported failing test/);
});

test('a red run with a nonzero exit naming a reported test is committed as test:', async (t) => {
  const g = await redGate(t, { tests: ['rejects bad input'], run: { code: 1, output: FAIL_OUTPUT } });
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)']);
  assert.ok(!g.readEvents().some((e) => e.type === 'action' && e.outcome === 'failed'));
  assert.deepEqual(g.rec.history, []);
});
