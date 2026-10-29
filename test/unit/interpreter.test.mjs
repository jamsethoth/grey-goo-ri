import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as render from '../../lib/render.mjs';
import * as marker from '../../lib/marker.mjs';
import * as golden from '../support/golden.mjs';
import { firstVisit, intents, actionEvent, attemptsOf, loadTicket, branchMessages, greenSetup, ok, WRONG_ADD,
  finding, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow, subjects } from '../support/interpreter.mjs';

test('the green call is a fresh session with the full brief', async (t) => {
  const g = await firstVisit(t);
  assert.equal(g.harness.calls.length, 2);
  const [red, green] = g.harness.calls;
  assert.equal(red.resume, null);
  assert.equal(green.resume, null);
  assert.ok(green.brief.includes('test/add.test.mjs'), 'committed test list in the green brief');
  assert.ok(green.brief.includes("Cannot find module 'lib/add.mjs'"), 'red output in the green brief');
  assert.equal(red.personaBytes, golden.PERSONA, 'red persona bytes come from the visit snapshot');
  assert.equal(green.personaBytes, golden.PERSONA, 'green persona bytes come from the visit snapshot');
  assert.equal(green.personaHash, red.personaHash);
  const session = g.rec.sessions['green/1/green'];
  assert.ok(session, 'green session recorded under green/1/green');
  assert.equal(session.sessionId, 'fake-session-2');
  assert.match(session.transcriptPath, /fake-session-2\.jsonl$/);
  assert.equal(session.usage.input, 200);
  assert.equal(g.rec.sessions['red/1/red'].sessionId, 'fake-session-1');
});

test('Red Evidence keeps raw local paths for the green Brief', async (t) => {
  const g = await golden.setup(t);
  const path = join(g.worktree, 'test', 'add.test.mjs');
  const runShell = g.options.exec.runShell;
  g.options.exec.runShell = async (...args) => {
    const r = await runShell(...args);
    return { ...r, output: `${r.output}\n    at (${path}:1:1)` };
  };
  await interpreter.runExecution(g.options);
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.ok(rec.outputs.red.evidence.output.includes(path), rec.outputs.red.evidence.output);
  assert.ok(g.harness.calls[1].brief.includes(`${path}:1:1`), 'the green Brief quotes the raw path');
  assert.ok(!g.gh.pr().body.includes(g.root), 'the PR body does not');
});

test('each public field is redacted once and sent exactly as its intent saved it', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].response.summary = 'TOKEN red summary';
  Object.assign(responses['green/1/green/1'].response, {
    summary: 'TOKEN green summary', dod: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
    qa: { setup: 'TOKEN setup', steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
      edgeCases: ['TOKEN edge'], automated: ['TOKEN automated'], manual: ['TOKEN manual'] },
  });
  const g = await golden.setup(t, { responses });
  g.options.ticket.title = 'Add TOKEN';
  g.options.commands = { test: 'npm test TOKEN' };
  // Configuration reaches commit trailers and provenance cells too, each of which is public text.
  for (const { agent } of Object.values(g.flow.ticket.vertices).filter((v) => v.agent)) {
    Object.assign(agent, { model: 'model TOKEN', effort: 'TOKEN effort', persona: join(g.root, 'personas', 'TOKEN.md') });
  }
  writeFileSync(join(g.root, 'personas', 'TOKEN.md'), golden.PERSONA);
  const runShell = g.options.exec.runShell;
  g.options.exec.runShell = async (...args) => {
    const r = await runShell(...args);
    return { ...r, output: `${r.output}\nTOKEN output` };
  };
  // Each pass marks the field again, so a second redaction shows as TOKEN** and a missed one as a bare TOKEN.
  g.options.publicText = (text) => text.replaceAll('TOKEN', 'TOKEN*');
  await interpreter.runExecution(g.options);

  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  const messages = await branchMessages(g);
  const sent = [...g.gh.calls.flatMap((c) => [...c.args, c.input ?? '']), ...messages];
  assert.deepEqual(sent.filter((text) => /TOKEN(?!\*)|TOKEN\*\*/.test(text)), [], 'nothing is sent unredacted or redacted twice');
  const body = g.gh.pr().body;
  assert.ok(body.includes('TOKEN* green summary'), 'TOKEN green summary');
  assert.ok(body.includes('TOKEN* item'), 'TOKEN item');
  assert.ok(body.includes('TOKEN* evidence'), 'TOKEN evidence');
  assert.ok(body.includes('TOKEN* setup'), 'TOKEN setup');
  assert.ok(body.includes('TOKEN* action'), 'TOKEN action');
  assert.ok(body.includes('TOKEN* expected'), 'TOKEN expected');
  assert.ok(body.includes('TOKEN* edge'), 'TOKEN edge');
  assert.ok(body.includes('TOKEN* automated'), 'TOKEN automated');
  assert.ok(body.includes('TOKEN* manual'), 'TOKEN manual');
  assert.ok(body.includes('TOKEN* output'), 'TOKEN output');
  assert.ok(body.includes('`npm test TOKEN*`'), '`npm test TOKEN`');
  assert.ok(body.includes('| model TOKEN* |'), '| model TOKEN |');
  assert.ok(body.includes('| TOKEN* effort |'), '| TOKEN effort |');
  assert.ok(body.includes('| TOKEN*.md@'), '| TOKEN.md@');
  assert.ok(messages[0].includes('Feature-Flow-Stage: red fake/model TOKEN*/TOKEN* effort'), messages[0]);
  assert.ok(messages[1].includes('Feature-Flow-Stage: green fake/model TOKEN*/TOKEN* effort'), messages[1]);
  assert.ok(g.gh.calls.some((c) => c.args.includes('--title') && c.args.includes('Add TOKEN*')), 'the PR title');
  assert.deepEqual(intents(rec, 'commit').map((e) => e.payload.message.trim()), messages);
  // A comment goes as the JSON body of its gh api POST.
  const saved = [...intents(rec, 'comment').map((e) => JSON.stringify({ body: e.payload.body })), ...intents(rec, 'pr-upsert').map((e) => e.payload.body)];
  assert.deepEqual(saved.filter((wire) => !g.gh.calls.some((c) => c.input === wire)), [], 'every comment and PR body is sent as saved');
});

// The storage cut of a long Check output must not leave the start of a known directory where redaction cannot match it.
const ALICE = '/home/alice/' + 'n'.repeat(300);
const longLines = {
  'an overlong': ['/home/alice', '/home/alice/private.txt' + ' '.repeat(65_520)],
  'a redacted overlong': [ALICE, (() => {
    const first = `${ALICE}/private.txt `;
    const kept = first.slice(first.indexOf('alice') + 1);
    const rest = `${ALICE}/x `.repeat(200);
    return first + rest + ' '.repeat(65_536 - kept.length - rest.length);
  })()],
};
for (const [kind, [directory, output]] of Object.entries(longLines)) {
  test(`${kind} Check output line publishes no fragment of a known directory`, async (t) => {
    const g = await golden.setup(t);
    g.options.publicText = (text) => render.publicText(text, [directory]);
    const runShell = g.options.exec.runShell;
    g.options.exec.runShell = async (...args) => {
      const r = await runShell(...args);
      return r.code === 0 ? { ...r, output } : r;
    };
    await interpreter.runExecution(g.options);
    assert.ok(g.gh.pr(), 'the PR carries the Green evidence');
    const sent = JSON.stringify(g.gh.calls.map(({ args, input }) => [args, input]));
    assert.ok(!sent.includes('alice'), `${kind}: alice published`);
    assert.ok(!sent.includes('lice/'), `${kind}: lice/ published`);
  });
}

// The first flip each way: red's clean check is the first bracket, busy at generation 1 and idle at 2. A save that
// carries a Terminal passes, so a fault reported after the failure would land.
for (const [name, from, to, generation, activity] of [
  ['busy', false, true, 1, { busy: false, generation: 0 }],
  ['idle', true, false, 2, { busy: true, generation: 1 }],
]) {
  test(`a failed ${name} save saves nothing more of that record`, async (t) => {
    const g = await golden.setup(t);
    golden.failSaves(t, (saved, next) => saved?.activity.busy === from && next.activity.busy === to
      && next.activity.generation === generation && next.terminalStop == null);
    const err = await interpreter.runExecution(g.options).then(() => null, (e) => e);

    assert.equal(err?.name, 'RecordSaveError', String(err));
    const saved = await loadTicket(g);
    assert.equal(saved.state, 'active', 'no fault is saved');
    assert.equal(saved.terminalStop ?? null, null, 'nor its Terminal');
    assert.deepEqual(saved.activity, activity, 'the failed flip is not saved by a cleanup');
    assert.equal(g.gh.comments.length, 0, 'no fault report');
    assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
  });
}

test('runExecution asks the injected integrity whether an Attempt kept to its access', async (t) => {
  const g = await golden.setup(t);
  const violation = { worktree: g.worktree, surface: 'head', before: g.base, after: 'a'.repeat(40) };
  const injected = { ...g.options.integrity, end: async () => ({ violations: [violation] }) };
  const result = await interpreter.runExecution({ ...g.options, integrity: injected });

  assert.equal(result.outcome, 'needs-human');
  const red = actionEvent(g, 'red', 'red');
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.violations, [violation]);
});

test('runExecution asks the injected Test Immutability whether the committed tests still match', async (t) => {
  const g = await golden.setup(t);
  const testImmutability = async () => ({ ok: false, changed: ['test/add.test.mjs'] });
  const result = await interpreter.runExecution({ ...g.options, testImmutability });

  assert.equal(result.outcome, 'needs-human');
  const check = actionEvent(g, 'green', 'test');
  assert.equal(check.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
});

test("the Protected Files are gg's paths plus every shipped Harness's paths", async () => {
  const { HARNESSES } = await import('../../lib/harnesses/shipped.mjs');
  assert.deepEqual(interpreter.protectedFiles({}), ['.agents/', '.github/actions/', '.github/workflows/']);
  assert.deepEqual(interpreter.protectedFiles(HARNESSES),
    ['.agents/', '.claude/', '.codex/', '.github/actions/', '.github/workflows/', '.mcp.json', 'AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(interpreter.protectedFiles({ a: { protectedPaths: ['.agents/', 'Z.md'] }, b: { protectedPaths: ['.b/'] } }),
    ['.agents/', '.b/', '.github/actions/', '.github/workflows/', 'Z.md']);
});

for (const [what, protectedPaths] of [['no paths', undefined], ['a string', '.x/'], ['an empty path', ['.x/', '']], ['a non-string path', [1]]]) {
  test(`the Protected Files refuse a Harness that declares ${what}`, () => {
    assert.throws(() => interpreter.protectedFiles({ ok: { protectedPaths: [] }, broken: { protectedPaths } }),
      { message: 'harness broken must declare protectedPaths as an array of paths' });
  });
}

test('runExecution asserts the Protected Files it is given', async (t) => {
  const g = await golden.setup(t);
  const seen = [];
  const injected = { ...g.options.integrity,
    begin: (args) => { seen.push(['begin', args.protectedPaths]); return g.options.integrity.begin(args); },
    end: (args) => { seen.push(['end', args.protectedPaths]); return g.options.integrity.end(args); } };
  await interpreter.runExecution({ ...g.options, integrity: injected, protectedPaths: ['.x/'] });
  assert.deepEqual(seen.slice(0, 2), [['begin', ['.x/']], ['end', ['.x/']]]);
  await assert.rejects(interpreter.runExecution({ ...g.options, protectedPaths: undefined }), { message: 'runExecution needs protectedPaths' });
});

const reportMarker = (g, vertex, action) => marker.formatMarker({ execution: g.rec.execution, vertex, visit: 1, action, recovery: 0, run: g.rec.run, attempt: 1 });

test("a hold's label is set after its comment, each under its own marker", async (t) => {
  const g = await golden.setup(t);
  const result = await interpreter.runExecution({ ...g.options,
    admission: { kind: 'hold', name: 'dirty-worktree', text: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.' } });

  assert.equal(result.held, true, JSON.stringify(result));
  const rec = await loadTicket(g);
  const [comment, label] = ['hold-comment', 'hold-label'].map((a) => reportMarker(g, 'needs-human', a));
  assert.deepEqual(rec.log.filter((e) => e.step === 'intent').map((e) => [e.action, e.marker]), [['comment', comment], ['label', label]]);
  const order = rec.log.map((e) => `${e.step} ${e.marker}`);
  assert.ok(order.indexOf(`complete ${comment}`) < order.indexOf(`intent ${label}`), 'the label is intended once the comment completed');
  const [posted] = g.gh.comments;
  assert.ok(posted.body.includes(marker.markerComment(comment)), 'the comment carries its own marker');
  assert.ok(g.gh.labels.has('gg:state:needs-human'));
  assert.deepEqual(record.openIntents(rec), []);
});

test("a fault during an end does not replay the end's open reporting Action", async (t) => {
  const g = await golden.setup(t);
  const real = g.options.gh.commentIssue;
  let calls = 0;
  g.options.gh = { ...g.options.gh, commentIssue: async (...a) => { if (calls++ === 0) throw new Error('gh comment down'); return real(...a); } };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.fault, true, JSON.stringify(result));
  const rec = await loadTicket(g);
  const ended = reportMarker(g, 'ready-for-qa', 'end-comment');
  assert.deepEqual(record.openIntents(rec).map((e) => e.marker), [ended], "the end's comment stays open");
  assert.equal(calls, 2, "the end's comment is tried once and the fault's once");
  const [posted, ...rest] = g.gh.comments.filter((c) => c.target === 'issue');
  assert.equal(rest.length, 0);
  assert.ok(posted.body.includes(marker.markerComment(reportMarker(g, 'needs-human', 'fault-comment'))), 'the fault reports under its own marker');
  assert.ok(rec.log.some((e) => e.step === 'complete' && e.marker === reportMarker(g, 'needs-human', 'fault-label')));
  assert.ok(rec.log.some((e) => e.step === 'complete' && e.marker === reportMarker(g, 'publish', 'pr-ready')), "publish's pr-ready completed first");
});

test("the PR's provenance counts a retried Attempt and a resumed Session once each", async (t) => {
  const usage = (input, output) => ({ usage: { delta: { input, output } } });
  const red = golden.firstVisitResponses['red/1/red/1'];
  const g = await greenSetup(t, {
    // A parse retry: two Attempts of red, each one call.
    'red/1/red/1': { ...red, response: null, result: usage(10, 2) },
    'red/1/red/2': { ...red, result: usage(100, 20) },
    // test-fix resumes green's Session, whose cumulative usage then holds green's tokens too.
    'green/1/green/1': { ...ok({ 'lib/add.mjs': WRONG_ADD }), result: usage(200, 40) },
    'green/1/test-fix/1': { ...ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }), result: usage(50, 5) },
  });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const body = g.gh.pr().body;
  assert.match(body, /^\| red \| .* \| 2 \| 110 \(0\) \/ 22 \|$/m, body);
  assert.match(body, /^\| green \| .* \| 2 \| 250 \(0\) \/ 45 \|$/m, body);
});

// T1a, M1: publish's pr-ready marks ready only the commit its Check passed on, while the PR's head is that commit.
const publishing = async (t, during) => {
  const g = await golden.setup(t);
  const runShell = g.options.exec.runShell;
  g.options.exec.runShell = async (...args) => {
    const r = await runShell(...args);
    if (g.rec.cursor.vertex === 'publish') await during(g);
    return r;
  };
  g.result = await interpreter.runExecution(g.options);
  return g;
};
const markedReady = (g) => g.gh.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'ready');

test('pr-ready holds when the published tree differs from the checked tree', async (t) => {
  // The test command rewrites a committed file, so the tree it passed on is not the pushed commit's.
  const g = await publishing(t, (g) => writeFileSync(join(g.worktree, 'lib', 'add.mjs'), 'export const add = (a, b) => b + a;\n'));

  assert.equal(g.result.outcome, 'needs-human', JSON.stringify(g.result));
  assert.equal(g.result.held, true);
  assert.equal(markedReady(g), false, 'gh pr ready never runs');
  assert.equal(g.gh.pr().isDraft, true, 'the PR stays a draft');
  const rec = await loadTicket(g);
  assert.deepEqual(rec.terminalReason.decidedBy, { hold: 'unchecked-publish' });
  assert.match(rec.terminalReason.text, /its Check passed on tree \w+, not on tree \w+ of commit \w+/);
  assert.ok(g.gh.labels.has('gg:state:needs-human'));
});

test('pr-ready holds when only the remote PR head moved after the push', async (t) => {
  const moved = 'e'.repeat(40);
  const g = await publishing(t, (g) => { g.gh.pr().headRefOid = moved; });

  assert.equal(g.result.outcome, 'needs-human', JSON.stringify(g.result));
  assert.equal(g.result.held, true);
  assert.equal(markedReady(g), false, 'gh pr ready never runs');
  assert.equal(g.gh.pr().isDraft, true, 'the PR stays a draft');
  const rec = await loadTicket(g);
  assert.deepEqual(rec.terminalReason.decidedBy, { hold: 'unchecked-publish' });
  assert.ok(rec.terminalReason.text.includes(moved), rec.terminalReason.text);
  assert.equal(await g.options.git.remoteSha(g.mainRoot, golden.BRANCH), await g.options.git.headSha(g.worktree), "gg's push stands");
});

const timedOut = { 'green/1/green/1': { files: {}, response: null, result: { status: 'timed-out' } },
  'green/1/green/2': { files: {}, response: null, result: { status: 'timed-out' } } };

test('an unrouted harness-timeout ends at needs-human', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...timedOut } });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(attemptsOf(g, 'green', 'green').at(-1).outcome, 'harness-timeout');
  const rec = await loadTicket(g);
  assert.equal(rec.terminalReason.outcome, 'harness-timeout');
  assert.equal(rec.terminalReason.rule, 'timeout-exhausted');
  assert.ok(g.gh.labels.has('gg:state:needs-human'));
});

test('a routed harness-timeout takes its route', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...timedOut } });
  g.flow.ticket.vertices.green.route['harness-timeout'] = { end: 'needs-replan' };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-replan', JSON.stringify(result));
  assert.ok(g.gh.labels.has('gg:state:needs-replan'));
});

test('a stop comment replaces the end comment and reaches the Epic at needs-replan', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'] = { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis } };
  const g = await golden.setup(t, { responses });
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'needs-replan', JSON.stringify(result));
  const rec = await loadTicket(g);
  assert.equal(rec.state, 'needs-replan');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-replan']);
  const onTicket = g.gh.comments.filter((c) => c.number === golden.TICKET);
  assert.equal(onTicket.length, 1, 'one comment on the Ticket');
  assert.match(onTicket[0].body, /^### gg: misscoped\n/, 'the stop comment, not the end comment');
  assert.ok(onTicket[0].body.includes(diagnosis));
  assert.ok(onTicket[0].body.includes(`**Terminal Reason:** ${rec.terminalReason.text}`), 'it carries the Terminal Reason');
  const onEpic = g.gh.comments.filter((c) => c.number === rec.epic);
  assert.equal(onEpic.length, 1, 'the same comment on the Epic');
  const unmarked = (body) => body.replace(/<!-- gg-action \S+ -->/, '');
  assert.equal(unmarked(onEpic[0].body), unmarked(onTicket[0].body));
});

test("H7: the Flow's route for an Outcome beats the Vertex's \"*\"", async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'] = { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: 'Two tickets.' } };
  const g = await golden.setup(t, { responses });
  g.flow.ticket.vertices.green.route['*'] = { end: 'needs-human' };
  assert.equal((await interpreter.runExecution(g.options)).outcome, 'needs-replan');
});

test('no "*" catches an unroutable Outcome', async (t) => {
  const g = await golden.setup(t);
  g.flow.ticket.routes['*'] = { end: 'needs-replan' };
  g.flow.ticket.vertices.red.route['*'] = { end: 'needs-replan' };
  const violation = { worktree: g.worktree, surface: 'head', before: g.base, after: 'a'.repeat(40) };
  const result = await interpreter.runExecution({ ...g.options, integrity: { ...g.options.integrity, end: async () => ({ violations: [violation] }) } });
  assert.equal(result.outcome, 'needs-human', 'an Integrity Violation is never routed');
});

// Each Visit's snapshot as last saved, by `vertex/visit`: the record keeps only the current Visit's.
function pinnedInputs(t) {
  const seen = {};
  const previous = record.setSaveHook((r) => {
    if (r.snapshot) seen[`${r.snapshot.vertex}/${r.snapshot.visit}`] = structuredClone(r.snapshot.inputs);
  });
  t.after(() => record.setSaveHook(previous));
  return seen;
}
const briefOf = (g, vertex, visit) => g.harness.calls.find((c) => c.vertex === vertex && c.visit === visit).brief;

test("green reads red's committed tests through an input", async (t) => {
  const pinned = pinnedInputs(t);
  const g = await firstVisit(t);
  assert.equal(g.result.outcome, 'ready-for-qa');
  assert.deepEqual(pinned['green/1'].tests, { value: ['test/add.test.mjs'], vertex: 'red', visit: 1, action: 'commit' });
  assert.equal(pinned['green/1'].red.vertex, 'red');
  assert.equal(pinned['green/1'].red.action, 'red-check');
  assert.match(pinned['green/1'].red.value.output, /Cannot find module 'lib\/add.mjs'/);
  assert.ok(briefOf(g, 'green', 1).includes('- test/add.test.mjs'), 'the Brief lists the input');
});

test('a list input takes the latest Visit across its sources', async (t) => {
  const pinned = pinnedInputs(t);
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  assert.equal(g.result.outcome, 'ready-for-qa');
  const from = ({ vertex, visit, action }) => ({ vertex, visit, action });
  assert.deepEqual(from(pinned['reviewer/1'].report), { vertex: 'green', visit: 1, action: 'green' });
  assert.deepEqual(from(pinned['reviewer/2'].report), { vertex: 'implementer-fix', visit: 1, action: 'fix' });
  assert.deepEqual(from(pinned['reviewer/2'].green), { vertex: 'implementer-fix', visit: 1, action: 'test' });
  assert.deepEqual(from(pinned['publish/1'].report), { vertex: 'implementer-fix', visit: 1, action: 'fix' });
  assert.ok(briefOf(g, 'reviewer', 2).includes('Address the findings.'), "the second review reads the fix's report");
  assert.ok(!briefOf(g, 'reviewer', 1).includes('Address the findings.'));
  assert.ok(g.gh.pr().body.includes('Address the findings.'), "publish renders the PR body from the fix's report");
});

test('an absent optional input renders empty in the Brief', async (t) => {
  const pinned = pinnedInputs(t);
  const g = await golden.setup(t);
  g.flow.ticket.vertices.green.inputs = { ...golden.GREEN_INPUTS, tests: { from: 'senior-red.commit.files', optional: true } };
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(pinned['green/1'].tests, { absent: true });
  assert.match(briefOf(g, 'green', 1), /## Committed tests\n\nThe orchestrator committed/, 'the list renders empty');
});

test('pick projects findings to file paths', async (t) => {
  const pinned = pinnedInputs(t);
  const named = finding('minor', 'test/add.test.mjs', 'the test misses negatives');
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR, named])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  // The fix's Test Immutability sees the named test changed, which only its `tests: named` input permits.
  const immutability = g.options.testImmutability;
  g.options.testImmutability = async (...args) => (g.rec.cursor.vertex === 'implementer-fix'
    ? { ok: false, changed: ['test/add.test.mjs'] } : immutability(...args));
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(pinned['implementer-fix/1'].testFiles,
    { value: ['lib/add.mjs', 'test/add.test.mjs'], vertex: 'reviewer', visit: 1, action: 'review' });
  assert.deepEqual(pinned['implementer-fix/1'].findings.value, [MAJOR, named]);
});

test('a commit with nothing to commit records files: [] and makes no commit', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({}),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  assert.equal(g.result.outcome, 'ready-for-qa');
  const commits = g.rec.outputs.filter((o) => o.action === 'commit');
  assert.deepEqual(commits.map((o) => [o.vertex, o.visit, o.value.files]),
    [['red', 1, ['test/add.test.mjs']], ['green', 1, ['lib/add.mjs']], ['implementer-fix', 1, []]]);
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)'], 'no fix commit');
});
