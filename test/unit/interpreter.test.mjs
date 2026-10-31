import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../lib/config.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as render from '../../lib/render.mjs';
import * as marker from '../../lib/marker.mjs';
import * as golden from '../support/golden.mjs';
import { firstVisit, intents, actionEvent, attemptsOf, loadTicket, branchMessages, greenSetup, ok, WRONG_ADD,
  finding, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow, subjects, tddTrace, headSha, GREEN_FAIL_OUTPUT } from '../support/interpreter.mjs';

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

test('a Persona from the repository Layer is pinned with its hash', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-persona-layer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.agents', 'gg'), { recursive: true });
  writeFileSync(config.layerPath(repo), '{"agents":{"implementer":{"persona":"repo-implementer.md"}}}');
  writeFileSync(join(repo, '.agents', 'gg', 'repo-implementer.md'), '# repo implementer\n');
  const layered = config.loadConfig(repo, join(dir, 'home'));
  const g = await golden.setup(t);
  golden.configure(g, (c) => {
    c.files = layered.files;
    c.agents.implementer.persona = layered.agents.implementer.persona;
  });
  g.options.files = layered.files;
  await interpreter.runExecution(g.options);
  const [red, green] = g.harness.calls;
  assert.equal(red.personaBytes, '# repo implementer\n');
  assert.equal(red.personaHash, '906646d8774b848deba8dffcf8c2b5961d3f249ca95cc4b5f025d299d66036e1');
  assert.equal(green.personaHash, red.personaHash);
  assert.equal(g.rec.sessions['red/1/red'].persona, 'repo-implementer.md');
  assert.equal(g.rec.sessions['red/1/red'].personaHash, red.personaHash);
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
  const { output } = rec.outputs.find((o) => o.vertex === 'red' && o.action === 'red-check').value.evidence;
  assert.ok(output.includes(path), output);
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
  golden.configure(g, (c) => {
    c.files['TOKEN.md'] = golden.layerFile(golden.PERSONA);
    Object.assign(c.agents.implementer, { model: 'model TOKEN', effort: 'TOKEN effort', persona: 'TOKEN.md' });
  });
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
  const call = actionEvent(g, 'green', 'green');
  assert.equal(call.outcome, 'integrity-violation');
  assert.deepEqual(call.violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] }]);
  assert.equal(actionEvent(g, 'green', 'test'), undefined, 'decided at the agent Action, before any Check');
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
    // the recovery pass resumes green's Session, whose cumulative usage then holds green's tokens too.
    'green/1/green/1': { ...ok({ 'lib/add.mjs': WRONG_ADD }), result: usage(200, 40) },
    'green/1/recover/1': { ...ok({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }), result: usage(50, 5) },
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

test('pr-ready holds when the worktree changed after its Check passed', async (t) => {
  const g = await golden.setup(t);
  const ev = g.options.events;
  // A committed file is rewritten once publish's test has passed, so the worktree is no longer the commit it publishes.
  g.options.events = (type, data) => {
    ev(type, data);
    if (type === 'action' && data.vertex === 'publish' && data.action === 'test') writeFileSync(join(g.worktree, 'lib', 'add.mjs'), 'export const add = (a, b) => b + a;\n');
  };
  g.result = await interpreter.runExecution(g.options);

  assert.equal(g.result.outcome, 'needs-human', JSON.stringify(g.result));
  assert.equal(g.result.held, true);
  assert.equal(markedReady(g), false, 'gh pr ready never runs');
  assert.equal(g.gh.pr().isDraft, true, 'the PR stays a draft');
  const rec = await loadTicket(g);
  assert.deepEqual(rec.terminalReason.decidedBy, { hold: 'unchecked-publish' });
  assert.match(rec.terminalReason.text, /the worktree is not clean at commit \w+/);
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
  assert.deepEqual(rec.terminalReason.rule, { table: 'fixed', row: 'timeout-exhausted' });
  assert.ok(g.gh.labels.has('gg:state:needs-human'));
});

test('a routed harness-timeout takes its route', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses), ...timedOut } });
  golden.configure(g, (c) => { c.flows.golden.ticket.vertices.green.route['harness-timeout'] = { end: 'needs-replan' }; });
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

test("a stop token's comment names the stopped Visit's own outputs and inputs", async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'] = { files: {}, response: { ...golden.greenResponse, claim: 'blocked', summary: 'SENTINEL green summary' } };
  const g = await golden.setup(t, { responses });
  golden.configure(g, (c) => {
    c.files['stop-direct.md'] = golden.layerFile('own: {{green.response.summary}}\ninput: {{inputs.red.output}}\n{{marker}}\n');
    c.procedures.implement.claims.blocked.comment = 'stop-direct.md';
  });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'needs-human');
  const onTicket = g.gh.comments.filter((c) => c.number === golden.TICKET);
  assert.equal(onTicket.length, 1, 'one comment on the Ticket');
  assert.ok(onTicket[0].body.startsWith(`own: SENTINEL green summary\ninput: ${golden.RED_OUTPUT}\n`), onTicket[0].body);
});

test("H7: the Flow's route for an Outcome beats the Vertex's \"*\"", async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'] = { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: 'Two tickets.' } };
  const g = await golden.setup(t, { responses });
  golden.configure(g, (c) => { c.flows.golden.ticket.vertices.green.route['*'] = { end: 'needs-human' }; });
  assert.equal((await interpreter.runExecution(g.options)).outcome, 'needs-replan');
});

test('no "*" catches an unroutable Outcome', async (t) => {
  const g = await golden.setup(t);
  golden.configure(g, (c) => {
    c.flows.golden.ticket.routes['*'] = { end: 'needs-replan' };
    c.flows.golden.ticket.vertices.red.route['*'] = { end: 'needs-replan' };
  });
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
const briefOf = (g, vertex, visit) => g.harness.calls.find((c) => {
  const at = marker.partsOf(c.marker);
  return at.vertex === vertex && at.visit === String(visit);
}).brief;

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
  // A source no route produces: the reviewer's committed files, read before any review.
  golden.configure(g, (c) => {
    c.flows.golden.ticket.vertices.green.inputs = { ...golden.GREEN_INPUTS, tests: { from: 'green.commit.files', optional: true } };
  });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(pinned['green/1'].tests, { absent: true });
  assert.match(briefOf(g, 'green', 1), /## Committed tests\n\nThe orchestrator committed/, 'the list renders empty');
});

test('a shipped Brief names its inputs directly', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].files['test/sentinel.test.mjs'] = "import { add } from '../lib/add.mjs';\n";
  const g = await golden.setup(t, { responses });
  const runShell = g.options.exec.runShell;
  g.options.exec.runShell = async (...args) => {
    const r = await runShell(...args);
    return { ...r, output: `${r.output}\nSENTINEL red output` };
  };
  // The shipped green Brief, then every fixed name its context once carried for an input. Admission rejects those names,
  // so the file changes after it, to show the run itself carries no alias.
  g.files['templates/green.md'] = golden.layerFile(`${g.files['templates/green.md'].bytes}\n[{{testFiles}}|{{redOutput}}|{{impl}}|{{report}}]`);
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  const green = briefOf(g, 'green', 1);
  assert.ok(green.includes('- test/sentinel.test.mjs'), green);
  assert.ok(green.includes('SENTINEL red output'), green);
  assert.ok(green.endsWith('\n[|||]'), `no alias in the context:\n${green}`);
});

test('a template names its own outputs and inputs directly', async (t) => {
  const g = await reviewFlow(t, { 'reviewer/1/review/1': reviewed(review('ok', [], { summary: 'SENTINEL review summary' })) });
  golden.configure(g, (c) => {
    c.files['pr-direct.md'] = golden.layerFile('green: {{test.evidence.output}}\nred: {{inputs.red.output}}\n{{marker}}\n');
    c.files['comment-direct.md'] = golden.layerFile('review: {{review.response.summary}}\n{{marker}}\n');
    c.procedures.implement.actions[4] = { id: 'pr', do: 'pr-upsert', body: 'pr-direct.md' };
    c.procedures.review.actions[3] = { id: 'comment', do: 'comment', target: 'pr', body: 'comment-direct.md' };
  });
  const { outcome } = await interpreter.runExecution(g.options);
  assert.equal(outcome, 'ready-for-qa');
  const green = intents(g.rec, 'pr-upsert').find((e) => marker.partsOf(e.marker).vertex === 'green').payload.body;
  assert.ok(green.startsWith(`green: ${golden.GREEN_OUTPUT}\nred: ${golden.RED_OUTPUT}\n`), green);
  assert.deepEqual(g.gh.comments.filter((c) => c.body.startsWith('review: ')).map((c) => c.body.split('\n')[0]), ['review: SENTINEL review summary']);
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

test("each draft PR body renders its own Vertex's report and Green Evidence", async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  assert.equal(g.result.outcome, 'ready-for-qa');
  // The body each Vertex's pr-upsert saved in its intent, before a later Vertex re-rendered it.
  const bodyOf = (vertex) => intents(g.rec, 'pr-upsert').find((e) => marker.partsOf(e.marker).vertex === vertex).payload.body;
  const greenSection = (body) => body.slice(body.indexOf('**Green**'), body.indexOf('## QA instructions'));

  const green = bodyOf('green');
  assert.ok(green.includes('Add two numbers.'), `green's body renders green's report:\n${green}`);
  assert.ok(greenSection(green).includes('✔ adds two numbers (0.8ms)'), `green's Green section shows green's test.evidence:\n${green}`);
  assert.ok(!greenSection(green).includes('Cannot find module'), `green's Green section does not show the Red Evidence:\n${green}`);

  const fix = bodyOf('implementer-fix');
  assert.ok(fix.includes('Address the findings.'), `the fix's body renders the fix's report:\n${fix}`);
  assert.ok(greenSection(fix).includes('✔ adds two numbers (0.8ms)'), `the fix's Green section shows the fix's test.evidence:\n${fix}`);
  assert.ok(!greenSection(fix).includes('Cannot find module'), `the fix's Green section does not show the Red Evidence:\n${fix}`);
});

// #114: Checks as declared Actions. Their results are the Check signal { id, kind, state, tree }, and a final failure
// is the engine Outcome failed.
test('a failed red at an end leaves its work in place', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/recover/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  // The new test passes before any implementation exists, both times.
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8'), "import { add } from '../lib/add.mjs';\n", 'the test red wrote is still there');
  assert.equal(await headSha(g), g.base, 'nothing was committed');
  assert.deepEqual(intents(g.rec, 'reset'), [], 'nothing was reset');
  assert.deepEqual(g.rec.history, []);
  assert.equal(g.rec.terminalReason.outcome, 'failed');
});

test('a final test failure is the Outcome failed naming the Check', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' }),
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(g, 'green', 'test', 1);
  assert.equal(check.outcome, 'failed');
  assert.deepEqual(check.rule, { table: 'failed', row: null });
  assert.equal(check.check, 'test');
  const [signal] = check.signals.checks;
  // A failing Check's output reaches its signal and the Terminal comment, never its evidence (N9).
  assert.deepEqual(signal, { id: 'test', kind: 'command', state: 'failed', tree: signal.tree, output: GREEN_FAIL_OUTPUT });
  assert.match(signal.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(g.rec.outputs.filter((o) => o.vertex === 'green' && o.action === 'test'), []);
  const reason = g.rec.terminalReason;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 1 });
  assert.equal(reason.outcome, 'failed');
  assert.equal(reason.text, 'The command Check test failed with no recovery left.');
  assert.ok(g.gh.comments[0].body.includes(`\`\`\`\n${GREEN_FAIL_OUTPUT}\n\`\`\``), g.gh.comments[0].body);
});

test('a Check result on an older tree does not count', async (t) => {
  const g = await golden.setup(t);
  const ev = g.options.events;
  // A file appears after green's test passed and before its commit, so the commit sees a tree the Check never saw.
  g.options.events = (type, data) => {
    ev(type, data);
    if (type === 'action' && data.vertex === 'green' && data.action === 'test') writeFileSync(join(g.worktree, 'lib', 'late.mjs'), 'export {};\n');
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const commit = actionEvent(g, 'green', 'commit');
  assert.equal(commit.outcome, 'failed');
  assert.equal(commit.signals.checks[0].id, 'test');
  assert.equal(commit.signals.checks[0].state, 'failed', 'a pass on an older tree counts as failed');
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)'], 'no feat commit');
});

test('a Check that changes the tree fails', async (t) => {
  const g = await golden.setup(t);
  const runShell = g.options.exec.runShell;
  // The passing run leaves a generated file behind.
  g.options.exec.runShell = async (command, opts) => {
    const r = await runShell(command, opts);
    if (r.code === 0) writeFileSync(join(g.worktree, 'lib', 'generated.mjs'), 'export {};\n');
    return r;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(g, 'green', 'test');
  assert.equal(check.outcome, 'failed');
  assert.equal(check.signals.checks[0].state, 'failed');
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)'], 'no feat commit');
});

// implement whose ok requires only a passing lint Check, so its failing test Check is recorded but blocks nothing;
// publish then reads green's evidence as optional, since a failing Check has none (N9).
function unrequiredTest(g) {
  golden.configure(g, (c) => {
    c.commands.lint = 'npm run lint';
    c.procedures.implement.actions.splice(2, 0, { id: 'lint', do: 'check', kind: 'command', command: 'lint' });
    c.procedures.implement.claims.ok = { requires: ['lint'] };
    c.flows.golden.ticket.vertices.publish.inputs.green.optional = true;
  });
  const { runShell } = g.options.exec;
  g.options.exec.runShell = async (command, opts) => (command === 'npm run lint' ? LINT_PASSES : runShell(command, opts));
}

// implement with a second required command Check, lint, after test. The lint command answers with `lintRuns` in order.
const LINT_OUTPUT = 'lib/add.mjs: 1 problem (no-unused-vars)';
const LINT_FAILS = { code: 1, output: LINT_OUTPUT, timedOut: false };
const LINT_PASSES = { code: 0, output: '', timedOut: false };
function withLint(g, lintRuns) {
  golden.configure(g, (c) => {
    c.commands.lint = 'npm run lint';
    c.procedures.implement.actions.splice(2, 0, { id: 'lint', do: 'check', kind: 'command', command: 'lint', recoverBrief: 'templates/test-fix.md' });
    c.procedures.implement.claims.ok = { requires: ['test', 'lint'] };
  });
  const shells = { ...g.options.exec, 'npm run lint': async () => lintRuns.shift() };
  g.options.exec.runShell = async (command, opts) => (shells[command] ?? shells.runShell)(command, opts);
}

const RIGHT_ADD = 'export const add = (a, b) => a + b;\n';
const greenTrace = (g) => tddTrace(g).filter((e) => e.vertex === 'green').map((e) => `${e.action}/${e.recovery}`);

// #115: Claim tokens declare `requires` or `stop`, recovery is one per-Visit budget, and the Outcome is decided in one fixed
// order (Q3, Q3d, T4, W1).
test("recovery resumes the Session with every failing Check's section", async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': RIGHT_ADD }),
  });
  withLint(g, [LINT_FAILS, LINT_PASSES]);
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  const recovery = g.harness.calls[2];
  assert.equal(recovery.resume, 'fake-session-2', "the recovery pass resumes green's Session");
  assert.ok(recovery.brief.includes(GREEN_FAIL_OUTPUT), `the test Check's section:\n${recovery.brief}`);
  assert.ok(recovery.brief.includes(LINT_OUTPUT), `the lint Check's section:\n${recovery.brief}`);
  const check = actionEvent(g, 'green', 'lint');
  assert.deepEqual([check.outcome, check.direction, check.rule], ['recover', 'retry', { table: 'fixed', row: 'recover' }]);
});

test('every Check runs again after recovery', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': RIGHT_ADD }),
  });
  const lintRuns = [LINT_PASSES, LINT_PASSES];
  withLint(g, lintRuns);
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(greenTrace(g), ['green/0', 'test/0', 'lint/0', 'green/1', 'test/1', 'lint/1', 'commit/1', 'push/1', 'pr/1']);
  assert.deepEqual(lintRuns, [], 'lint passed in the first pass and still ran again');
  assert.doesNotMatch(g.harness.calls[2].brief, /Check lint/, 'a passing Check has no section');
});

test('a stop token after recovery stops', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': { files: {}, response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'The test is wrong.' } },
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(greenTrace(g), ['green/0', 'test/0', 'green/1', 'test/1'], "the stop waits for its pass's Checks");
  assert.match(g.gh.comments[0].body, /### gg: blocked/);
  const reason = g.rec.terminalReason;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['blocked', { table: 'stopped', row: null }]);
  assert.deepEqual(actionEvent(g, 'green', 'test', 1).rule, reason.rule);
});

test('pass is matchable in the passed table', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': RIGHT_ADD }),
  });
  golden.configure(g, (c) => {
    c.procedures.implement.passed = [{ when: { pass: 2 }, outcome: 'recovered' }];
    c.flows.golden.ticket.vertices.green.route.recovered = { end: 'needs-human' };
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const reason = g.rec.terminalReason;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'pr', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['recovered', { table: 'passed', row: 0 }]);
});

test('named tests missing from the output are recovered once, then fail', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/recover/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  // The runner fails, but its output never names the reported test.
  g.options.exec = { runShell: async () => ({ code: 1, output: 'Error: something else broke', timedOut: false }) };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(g).map((e) => `${e.action}/${e.recovery}`), ['red/0', 'red-check/0', 'red/1', 'red-check/1']);
  const recovery = g.harness.calls[1];
  assert.equal(recovery.resume, 'fake-session-1', "the recovery pass resumes red's Session");
  assert.match(recovery.brief, /as the runner prints them/);
  assert.ok(recovery.brief.includes('Error: something else broke'), recovery.brief);
  assert.deepEqual(actionEvent(g, 'red', 'red-check').rule, { table: 'fixed', row: 'recover' });
  const reason = g.rec.terminalReason;
  assert.deepEqual(reason.decidedBy, { vertex: 'red', visit: 1, action: 'red-check', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['failed', { table: 'failed', row: null }]);
});

test('a red that changed no test file is recovered once, then fails', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].files = { 'lib/note.mjs': 'export {};\n' };
  responses['red/1/recover/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(g.shells, [], 'the test command never ran');
  assert.deepEqual(tddTrace(g).map((e) => `${e.action}/${e.recovery}`), ['red/0', 'red-check/0', 'red/1', 'red-check/1']);
  assert.match(g.harness.calls[1].brief, /no-test-needed/, 'the section offers the no-test-needed stop');
  assert.deepEqual([g.rec.terminalReason.outcome, g.rec.terminalReason.rule], ['failed', { table: 'failed', row: null }]);
});

test("a Check that passed and then failed in a recovery pass keeps no evidence of the earlier pass", async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': RIGHT_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': WRONG_ADD }),
  });
  withLint(g, [LINT_FAILS, LINT_PASSES]);
  // ok requires only lint, so the Visit commits with test failing in its last pass.
  golden.configure(g, (c) => {
    c.procedures.implement.claims.ok = { requires: ['lint'] };
    c.flows.golden.ticket.vertices.publish.inputs.green.optional = true;
  });
  await interpreter.runExecution(g.options);

  assert.deepEqual(greenTrace(g).slice(0, 6), ['green/0', 'test/0', 'lint/0', 'green/1', 'test/1', 'lint/1']);
  assert.equal(actionEvent(g, 'green', 'test', 1).signals.checks[0].state, 'failed');
  assert.equal(g.rec.outputs.find((o) => o.vertex === 'green' && o.action === 'test')?.value.evidence, undefined, 'the first pass evidence is gone (N9)');
  assert.ok(g.gh.pr().body.includes('**Green**: the test command has no passing run.\n'), g.gh.pr().body);
});

test('a command Check that times out is not recovered', async (t) => {
  const g = await greenSetup(t, { 'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) });
  // red's Check fails as red should; green's test command then times out.
  const runs = [{ code: 1, output: golden.RED_OUTPUT, timedOut: false }, { code: null, output: 'killed after 30 min', timedOut: true }];
  g.options.exec.runShell = async () => runs.shift();
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(runs, [], 'the test command ran once in red and once in green');
  assert.deepEqual(greenTrace(g), ['green/0', 'test/0']);
  assert.deepEqual(g.rec.terminalReason.rule, { table: 'failed', row: null });
});

test('a failed Check produces no evidence output', async (t) => {
  const g = await greenSetup(t, { 'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) });
  unrequiredTest(g);
  await interpreter.runExecution(g.options);

  assert.deepEqual(g.rec.outputs.filter((o) => o.vertex === 'green' && o.action === 'test'), [], 'a failing test no token requires has no evidence');
  assert.ok(g.gh.pr().body.includes('**Green**: the test command has no passing run.\n'), g.gh.pr().body);
  assert.equal(actionEvent(g, 'green', 'test').signals.checks[0].state, 'failed');
  assert.equal(actionEvent(g, 'publish', 'test').outcome, 'failed', 'the Execution reached publish');
});

test('a tests-fail pass by name match alone carries heuristic: true in its evidence', async (t) => {
  const output = `Error: ${golden.TEST_NAME} threw\n`;
  // The runner prints no per-test statuses, only the test's name.
  const runShell = async (command, opts) => (existsSync(join(opts.cwd, 'lib', 'add.mjs'))
    ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output, timedOut: false });
  const g = await reviewSetup(t, { 'reviewer/1/review/1': reviewed(review('ok')) }, { exec: { runShell } });

  const red = g.rec.outputs.find((o) => o.vertex === 'red' && o.action === 'red-check');
  assert.deepEqual(red.value.evidence, { command: 'npm test', output, heuristic: true });
  assert.match(g.harness.calls[2].brief, /found the failing test by its name only/, 'the review Brief shows it');
});

// Declares reuse: tree on each named Procedure's test Check.
const reuseTree = (...names) => (c) => {
  for (const name of names) c.procedures[name].actions.find((a) => a.id === 'test').reuse = 'tree';
};

test('a reuse: tree command Check reuses a pass for the same tree and command and runs again for another', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  }, { configure: reuseTree('implement', 'fix', 'publish') });

  assert.equal(g.result.outcome, 'ready-for-qa');
  assert.equal(g.shells.length, 3, "red-check, green's test and the fix's test ran the command; publish reused the fix's pass");
  const evidence = (vertex) => g.rec.outputs.find((o) => o.vertex === vertex && o.action === 'test').value.evidence;
  assert.equal(evidence('green').output, golden.GREEN_OUTPUT);
  assert.equal(evidence('implementer-fix').output, golden.GREEN_OUTPUT, 'the fix changed the tree, so its test ran again');
  assert.equal(evidence('publish').output,
    `Reused the passing run of ${golden.markerOf(g.rec, 'implementer-fix', 1, 'test')} on this tree.\n${golden.GREEN_OUTPUT}`);
});

test('a failing reuse: tree result is never reused', async (t) => {
  const g = await greenSetup(t, { 'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) });
  golden.configure(g, reuseTree('implement', 'publish'));
  unrequiredTest(g);
  const runs = [];
  const runShell = g.options.exec.runShell;
  g.options.exec.runShell = async (command, opts) => {
    runs.push(command);
    return runShell(command, opts);
  };
  await interpreter.runExecution(g.options);

  assert.deepEqual(runs, ['npm test', 'npm test', 'npm run lint', 'npm test'], 'publish ran the test command again on the tree green failed on');
  assert.equal(actionEvent(g, 'publish', 'test').outcome, 'failed');
});

test('a deleted test file counts as a change', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/red/1'].files = {};
  const g = await golden.setup(t, { responses });
  g.options.testPaths = ['package.json'];
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') rmSync(join(g.worktree, 'package.json'));
    return out;
  };
  await interpreter.runExecution(g.options);

  const check = actionEvent(g, 'red', 'red-check');
  assert.equal(check.outcome, 'ok');
  assert.equal(check.signals.checks[0].state, 'passed');
  assert.deepEqual(g.rec.outputs.find((o) => o.vertex === 'red' && o.action === 'commit').value, { files: ['package.json'] });
});

// #116: Procedures are configuration. These cases declare Procedures of their own, with names gg does not know.
const PROBE_SCHEMA = JSON.stringify({ type: 'object', properties: { claim: { type: 'string', enum: ['ok', 'blocked'] }, summary: { type: 'string' } },
  required: ['claim', 'summary'], additionalProperties: false });
const probed = (summary, files = {}) => ({ files, response: { claim: 'ok', summary } });
// The files a declared Procedure below names: a Brief that names nothing and the probe schema.
function probeFiles(c) {
  c.files['plain.md'] = golden.layerFile('Do the work.\n');
  c.files['probe.schema.json'] = golden.layerFile(PROBE_SCHEMA);
}
// An agent Action, the test command as Check `gate`, and a commit of `type`; `tests` as the Procedure declares it.
const sealing = (tests, type) => ({
  tests,
  actions: [
    { id: 'ask', do: 'agent', brief: 'plain.md', schema: 'probe.schema.json' },
    { id: 'gate', do: 'check', kind: 'command', command: 'test' },
    { id: 'seal', do: 'commit', type },
  ],
  claims: { ok: { requires: ['gate'] }, blocked: { stop: true } },
});
// Test Immutability scripted with ordered results; `baselines` records the commit each assertion compared against.
function scriptedImmutability(g, results) {
  const baselines = [];
  g.options.testImmutability = async (cwd, baseline) => {
    baselines.push(baseline);
    return results.shift();
  };
  return baselines;
}
const commitOf = (g, vertex) => g.rec.log.find((e) => e.step === 'evidence' && e.action === 'commit' && marker.partsOf(e.marker).vertex === vertex).evidence.sha;

test('the interpreter names no Procedure, Action or Check', async (t) => {
  const g = await golden.setup(t, { responses: { 'build/1/ask/1': probed('Probe the sum.', { 'lib/add.mjs': RIGHT_ADD }) } });
  golden.configure(g, (c) => {
    c.files['ask.md'] = golden.layerFile('Probe {{ticket.title}}.\n');
    c.files['probe.schema.json'] = golden.layerFile(PROBE_SCHEMA);
    c.files['probe-body.md'] = golden.layerFile('{{ask.response.summary}}\n{{gate.evidence.output}}\n{{marker}}\n');
    c.procedures.probe = {
      actions: [
        { id: 'ask', do: 'agent', brief: 'ask.md', schema: 'probe.schema.json' },
        { id: 'gate', do: 'check', kind: 'command', command: 'test' },
        { id: 'seal', do: 'commit', type: 'chore' },
        { id: 'ship', do: 'push' },
        { id: 'post', do: 'pr-upsert', body: 'probe-body.md' },
        { id: 'done', do: 'pr-ready' },
      ],
      claims: { ok: { requires: ['gate'] }, blocked: { stop: true } },
    };
    c.flows.golden.ticket = { entry: 'build', routes: { '*': { end: 'needs-human' } },
      vertices: { build: { use: 'implementer', procedure: 'probe', route: { ok: { end: 'ready-for-qa' } } } } };
  });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(golden.trace(g.readEvents()).map((e) => `${e.vertex}/${e.action}/${e.outcome}`),
    ['build/ask/ok', 'build/gate/ok', 'build/seal/ok', 'build/ship/ok', 'build/post/ok', 'build/done/ok', 'ready-for-qa/end-comment/ok',
      'ready-for-qa/end-label/ok']);
  assert.equal(g.harness.calls[0].brief, 'Probe Add two numbers.\n');
  assert.deepEqual(await subjects(g), ['chore: Add two numbers (#15)']);
  assert.ok(g.gh.pr().body.startsWith(`Probe the sum.\n${golden.GREEN_OUTPUT}\n`), g.gh.pr().body);
  assert.equal(g.gh.pr().isDraft, false, 'pr-ready marked the PR ready');
});

test('lib/interpreter.mjs holds no Procedure table, describe, shipped Procedure name or phase read', () => {
  const source = readFileSync(new URL('../../lib/interpreter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PROCEDURES|procedures\.describe/);
  assert.doesNotMatch(source, /'(red|green|fix|review|implement|publish)'/);
  assert.doesNotMatch(source, /\.phase\b/);
});

test('a Vertex with no access set runs read-only', async (t) => {
  const g = await golden.setup(t);
  golden.configure(g, (c) => { delete c.agents.implementer.access; });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    g.fake.write(g.worktree, 'test/add.test.mjs');
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls[0].access, 'read-only');
  const red = actionEvent(g, 'red', 'red');
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal(red.violations[0].surface, 'tree');
});

test("the Visit snapshot pins the Procedure's name and hash", async (t) => {
  const seen = {};
  const previous = record.setSaveHook((r) => {
    if (r.snapshot) seen[`${r.snapshot.vertex}/${r.snapshot.visit}`] = structuredClone(r.snapshot.procedure);
  });
  t.after(() => record.setSaveHook(previous));
  const g = await golden.setup(t);
  await interpreter.runExecution(g.options);

  assert.deepEqual(seen['green/1'], { name: 'implement', hash: g.flow.procedures.implement.hash });
  assert.match(seen['green/1'].hash, /^[0-9a-f]{64}$/);
  assert.notEqual(seen['red/1'].hash, seen['green/1'].hash);
});

test('a passed row does not count a Check that passed on an older tree', async (t) => {
  const g = await golden.setup(t, { responses: { 'look/1/ask/1': probed('Looked.') } });
  golden.configure(g, (c) => {
    probeFiles(c);
    c.commands.touch = 'npm run touch';
    c.procedures.look = {
      access: 'read-only',
      actions: [
        { id: 'ask', do: 'agent', brief: 'plain.md', schema: 'probe.schema.json' },
        { id: 'gate', do: 'check', kind: 'command', command: 'test' },
        { id: 'touch', do: 'check', kind: 'command', command: 'touch' },
      ],
      claims: { ok: { requires: [] }, blocked: { stop: true } },
      passed: [{ when: { 'check.gate': 'passed' }, outcome: 'ok' }],
      otherwise: 'stale',
    };
    c.flows.golden.ticket = { entry: 'look', routes: { '*': { end: 'needs-human' } }, vertices: { look: { use: 'implementer', procedure: 'look' } } };
  });
  // Every command passes; touch also changes the worktree after gate checked it.
  g.options.exec.runShell = async (command) => {
    if (command === 'npm run touch') writeFileSync(join(g.worktree, 'touched.txt'), 'x\n');
    return { code: 0, output: 'ok', timedOut: false };
  };
  await interpreter.runExecution(g.options);

  assert.equal(actionEvent(g, 'look', 'gate').signals.checks[0].state, 'passed', 'gate passed on the tree it checked');
  const reason = g.rec.terminalReason;
  assert.deepEqual([reason.outcome, reason.rule], ['stale', { table: 'passed', row: 'otherwise' }]);
});

test('a failing Check with no recoverBrief gets a default section', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': RIGHT_ADD }),
  });
  golden.configure(g, (c) => { delete c.procedures.implement.actions[1].recoverBrief; });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  const recovery = g.harness.calls[2].brief;
  assert.ok(recovery.includes('## The command Check test\n'), recovery);
  assert.ok(recovery.includes(GREEN_FAIL_OUTPUT), recovery);
});

test('a Check with recoverable: false is not recovered', async (t) => {
  const g = await greenSetup(t, { 'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }) });
  golden.configure(g, (c) => { c.procedures.implement.actions[1].recoverable = false; });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(g.harness.calls.length, 2, 'no recovery call');
  assert.deepEqual(greenTrace(g), ['green/0', 'test/0']);
  assert.deepEqual(g.rec.terminalReason.rule, { table: 'failed', row: null });
});

test('Test Immutability is asserted after an agent Attempt of a write Vertex with no worktree Check', async (t) => {
  const g = await golden.setup(t);
  golden.configure(g, (c) => {
    c.procedures.implement.actions[1] = { id: 'test', do: 'check', kind: 'response', field: 'claim', is: 'ok' };
  });
  const baselines = scriptedImmutability(g, [{ ok: false, changed: ['test/add.test.mjs'] }]);
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(baselines, [commitOf(g, 'red')], "asserted once, against red's commit");
  const green = actionEvent(g, 'green', 'green');
  assert.equal(green.outcome, 'integrity-violation');
  assert.deepEqual(green.violations.at(-1).after, ['test/add.test.mjs']);
  assert.equal(actionEvent(g, 'green', 'commit'), undefined, 'green committed nothing');
});

test('Test Immutability uses the Execution base before any gg commit', async (t) => {
  const g = await golden.setup(t, { responses: { 'one/1/ask/1': probed('One.', { 'lib/add.mjs': RIGHT_ADD }) } });
  golden.configure(g, (c) => {
    probeFiles(c);
    c.procedures.sealing = sealing('frozen', 'feat');
    c.flows.golden.ticket = { entry: 'one', routes: { '*': { end: 'needs-human' } }, vertices: { one: { use: 'implementer', procedure: 'sealing' } } };
  });
  const baselines = scriptedImmutability(g, [{ ok: true, changed: [] }]);
  await interpreter.runExecution(g.options);

  assert.deepEqual(baselines, [g.base]);
});

test('every gg commit moves the Test Immutability baseline', async (t) => {
  const g = await golden.setup(t, { responses: {
    'one/1/ask/1': probed('One.', { 'lib/add.mjs': RIGHT_ADD }),
    'two/1/ask/1': probed('Two.', { 'lib/two.mjs': 'export {};\n' }),
  } });
  golden.configure(g, (c) => {
    probeFiles(c);
    c.procedures.sealing = sealing('frozen', 'feat');
    c.flows.golden.ticket = { entry: 'one', routes: { '*': { end: 'needs-human' } },
      vertices: { one: { use: 'implementer', procedure: 'sealing', route: { ok: 'two' } }, two: { use: 'implementer', procedure: 'sealing' } } };
  });
  const baselines = scriptedImmutability(g, [{ ok: true, changed: [] }, { ok: true, changed: [] }]);
  await interpreter.runExecution(g.options);

  assert.deepEqual(baselines, [g.base, commitOf(g, 'one')]);
  assert.equal(g.rec.testCommits.baseline, commitOf(g, 'two'));
});

test('a code-only commit does not become the first test commit', async (t) => {
  const g = await golden.setup(t, { responses: {
    'one/1/ask/1': probed('Code.', { 'lib/add.mjs': RIGHT_ADD }),
    'two/1/ask/1': probed('Tests.', { 'test/two.test.mjs': 'export {};\n' }),
  } });
  golden.configure(g, (c) => {
    probeFiles(c);
    c.procedures.sealing = sealing('write', 'test');
    c.flows.golden.ticket = { entry: 'one', routes: { '*': { end: 'needs-human' } },
      vertices: { one: { use: 'implementer', procedure: 'sealing', route: { ok: 'two' } }, two: { use: 'implementer', procedure: 'sealing' } } };
  });
  await interpreter.runExecution(g.options);

  assert.equal(g.rec.testCommits.first, commitOf(g, 'two'));
});

test('a stop token posts the comment its token names, or the Terminal Reason comment without one', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['green/1/green/1'] = { files: {}, response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'SENTINEL diagnosis' } };
  const named = await golden.setup(t, { responses });
  await interpreter.runExecution(named.options);
  const plain = await golden.setup(t, { responses });
  golden.configure(plain, (c) => { delete c.procedures.implement.claims.blocked.comment; });
  await interpreter.runExecution(plain.options);

  const [stop] = named.gh.comments;
  assert.ok(stop.body.startsWith('### gg: blocked\n'), stop.body);
  assert.ok(stop.body.includes('SENTINEL diagnosis'), stop.body);
  const [terminal] = plain.gh.comments;
  assert.ok(terminal.body.startsWith('### gg: needs-human\n\n**Terminal Reason:** '), terminal.body);
  assert.ok(!terminal.body.includes('SENTINEL diagnosis'), terminal.body);
});
