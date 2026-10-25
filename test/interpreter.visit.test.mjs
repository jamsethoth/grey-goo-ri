import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';
import {
  FIRST_VISIT, firstVisit, intents, steps, actionMarker, terminalReasonOf, tddTrace, actionEvent,
} from './support/interpreter.mjs';

test('a persona file name is read from the shipped personas directory', async (t) => {
  const g = await golden.setup(t);
  g.flow.ticket.vertices.implementer.agent.persona = 'implementer.md';
  await interpreter.runExecution(g.options);
  const shipped = readFileSync(new URL('../defaults/personas/implementer.md', import.meta.url), 'utf8');
  assert.equal(g.harness.calls[0].personaBytes, shipped);
});

test('every side-effect action leaves intent, evidence and completion with the full payload', async (t) => {
  const g = await firstVisit(t);
  const all = g.rec.log.filter((e) => e.step === 'intent');
  assert.ok(all.length > 0);
  for (const i of all) assert.deepEqual(steps(g.rec, i.marker), ['intent', 'evidence', 'complete'], `${i.action} ${i.marker}`);
  assert.deepEqual(record.openIntents(g.rec), []);

  // Each agent Attempt is write-ahead too, its intent carrying the baseline the Integrity Assertion compares against.
  const calls = intents(g.rec, 'call');
  assert.deepEqual(calls.map((c) => c.marker), [actionMarker(g, 'red', 1), actionMarker(g, 'green', 1)]);
  for (const c of calls) {
    assert.deepEqual(Object.keys(c.payload.baseline).sort(), ['head', 'idle', 'own', 'tests', 'untracked']);
    assert.deepEqual(Object.keys(c.payload.baseline.own).sort(), ['head', 'index', 'tree']);
  }

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
  const g = await firstVisit(t, { integrity: 'real' });
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

test('the visit keeps the configuration pinned at entry when the agent changes mid-visit', async (t) => {
  const g = await golden.setup(t);
  const vertex = g.flow.ticket.vertices.implementer;
  const run = g.harness.run;
  const seen = {};
  g.harness.run = async (call) => {
    seen[call.phase] = structuredClone({ agent: call.agent, access: call.access, persona: call.persona });
    if (call.phase === 'red') {
      vertex.agent.model = 'model-y';
      vertex.agent.access = 'read-only';
      vertex.options.requireTestPass = false;
      // Routing, Procedure and Declared Commands are pinned too: none of these may reach the rest of the Visit.
      vertex.procedure = 'fix';
      vertex.then = 'needs-human';
      g.options.commands.test = 'npm run other';
      call.agent.effort = 'low';
      writeFileSync(g.personaPath, '# changed\n');
    }
    return run(call);
  };
  const { outcome } = await interpreter.runExecution(g.options);
  assert.deepEqual(seen.green, seen.red);
  assert.equal(seen.green.agent.model, 'model-x');
  assert.equal(seen.green.access, 'workspace-write');
  assert.equal(seen.green.persona.bytes, golden.PERSONA);
  assert.equal(g.rec.snapshot.agent.effort, 'high', 'a harness mutating its call does not reach the snapshot');
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
  const g = await golden.setup(t, { responses, integrity: 'real' });
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
  assert.deepEqual({ ...reset.payload, untracked: undefined, left: undefined }, { baseline: g.base, history: g.rec.history[0], untracked: undefined, left: undefined });
  assert.equal(reset.payload.left.head, g.base, 'the intent saves the worktree the agent left, so admission can prove it');
  assert.match(reset.payload.left.tree, /^[0-9a-f]{40}$/);
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
  const g = await golden.setup(t, { responses, integrity: 'real' });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), 'test/extra.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'still-green', 2).outcome, 'red-failed');
  assert.ok(!existsSync(join(g.worktree, 'test', 'extra.test.mjs')), 'the ignored test the red call added is removed');
});

test('uncommitted changes before red are held at needs-human and nothing is deleted', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
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
  const g = await golden.setup(t, { responses, integrity: 'real' });
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
