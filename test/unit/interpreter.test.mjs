import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as record from '../../lib/record.mjs';
import * as render from '../../lib/render.mjs';
import * as golden from '../support/golden.mjs';
import { firstVisit, intents, actionEvent, loadTicket, branchMessages } from '../support/interpreter.mjs';

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
  const session = g.rec.sessions['implementer/1/green'];
  assert.ok(session, 'green session recorded under implementer/1/green');
  assert.equal(session.sessionId, 'fake-session-2');
  assert.match(session.transcriptPath, /fake-session-2\.jsonl$/);
  assert.equal(session.usage.input, 200);
  assert.equal(g.rec.sessions['implementer/1/red'].sessionId, 'fake-session-1');
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
  responses['implementer/1/red/1'].response.summary = 'TOKEN red summary';
  Object.assign(responses['implementer/1/green/1'].response, {
    summary: 'TOKEN green summary', dod: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
    qa: { setup: 'TOKEN setup', steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
      edgeCases: ['TOKEN edge'], automated: ['TOKEN automated'], manual: ['TOKEN manual'] },
  });
  const g = await golden.setup(t, { responses });
  g.options.ticket.title = 'Add TOKEN';
  g.options.commands = { test: 'npm test TOKEN' };
  // Configuration reaches commit trailers and provenance cells too, each of which is public text.
  const agent = g.flow.ticket.vertices.implementer.agent;
  Object.assign(agent, { model: 'model TOKEN', effort: 'TOKEN effort', persona: join(g.root, 'personas', 'TOKEN.md') });
  writeFileSync(agent.persona, golden.PERSONA);
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
  assert.ok(messages[0].includes('Feature-Flow-Stage: implementer fake/model TOKEN*/TOKEN* effort'), messages[0]);
  assert.ok(messages[1].includes('Feature-Flow-Stage: implementer fake/model TOKEN*/TOKEN* effort'), messages[1]);
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
  ['busy', 0, 1, 1, { busy: false, generation: 0 }],
  ['idle', 1, 0, 2, { busy: true, generation: 1 }],
]) {
  test(`a failed ${name} save saves nothing more of that record`, async (t) => {
    const g = await golden.setup(t);
    record.openDb(g.commonDir).exec(`CREATE TRIGGER fail_flip BEFORE UPDATE ON records
      WHEN json_extract(OLD.json, '$.activity.busy') = ${from} AND json_extract(NEW.json, '$.activity.busy') = ${to}
        AND json_extract(NEW.json, '$.activity.generation') = ${generation} AND json_extract(NEW.json, '$.terminalStop') IS NULL
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
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
  const red = actionEvent(g, 'red', 1);
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.violations, [violation]);
});

test('runExecution asks the injected Test Immutability whether the committed tests still match', async (t) => {
  const g = await golden.setup(t);
  const testImmutability = async () => ({ ok: false, changed: ['test/add.test.mjs'] });
  const result = await interpreter.runExecution({ ...g.options, testImmutability });

  assert.equal(result.outcome, 'needs-human');
  const check = actionEvent(g, 'green', 2);
  assert.equal(check.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
});
