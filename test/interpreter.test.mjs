import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as checks from '../lib/checks.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as marker from '../lib/marker.mjs';
import * as render from '../lib/render.mjs';
import * as golden from './support/golden.mjs';
import {
  TDD_PHASES, FIRST_VISIT, firstVisit, intents, actionMarker, loadTicket, ticketComments, contendRepoLock, lockedSetup,
} from './support/interpreter.mjs';

test('golden: first-visit pass runs the tdd actions in order to done', async (t) => {
  const g = await firstVisit(t, { integrity: 'real' });

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
  const messages = golden.sh(g.worktree, 'log', '--format=%B%x00', `${g.base}..HEAD`).split('\0').map((s) => s.trim()).filter(Boolean);
  const sent = [...g.gh.calls.flatMap((c) => [...c.args, c.input ?? '']), ...messages];
  for (const text of sent) assert.doesNotMatch(text, /TOKEN(?!\*)|TOKEN\*\*/, text);
  const body = g.gh.pr().body;
  for (const field of ['TOKEN green summary', 'TOKEN item', 'TOKEN evidence', 'TOKEN setup', 'TOKEN action', 'TOKEN expected',
    'TOKEN edge', 'TOKEN automated', 'TOKEN manual', 'TOKEN output', '`npm test TOKEN`', '| model TOKEN |', '| TOKEN effort |', '| TOKEN.md@']) {
    assert.ok(body.includes(field.replace('TOKEN', 'TOKEN*')), field);
  }
  assert.ok(messages.every((m) => m.includes('Feature-Flow-Stage: implementer fake/model TOKEN*/TOKEN* effort')), messages.join('\n'));
  assert.ok(g.gh.calls.some((c) => c.args.includes('--title') && c.args.includes('Add TOKEN*')), 'the PR title');
  assert.deepEqual(intents(rec, 'commit').map((e) => e.payload.message.trim()).reverse(), messages);
  for (const e of [...intents(rec, 'comment'), ...intents(rec, 'pr-upsert')]) {
    // A comment goes as the JSON body of its gh api POST.
    const wire = e.action === 'comment' ? JSON.stringify({ body: e.payload.body }) : e.payload.body;
    assert.ok(g.gh.calls.some((c) => c.input === wire), `${e.action} is sent as saved`);
  }
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
    for (const leak of ['alice', 'lice/']) assert.ok(!sent.includes(leak), `${kind}: ${leak} published`);
  });
}

test('a failed busy or idle save saves nothing more of that record', async (t) => {
  // The first flip each way: red's clean check is the first bracket, busy at generation 1 and idle at 2. A save that
  // carries a Terminal passes, so a fault reported after the failure would land.
  for (const [name, from, to, generation] of [['busy', 0, 1, 1], ['idle', 1, 0, 2]]) {
    await t.test(name, async (t) => {
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
      assert.deepEqual(saved.activity, { busy: !!from, generation: generation - 1 }, 'the failed flip is not saved by a cleanup');
      assert.equal(g.gh.comments.length, 0, 'no fault report');
      assert.ok(!g.readEvents().some((e) => e.type === 'ticket_end'));
    });
  }
});

// A gh call that changes GitHub: a comment, a label, a label definition or a pull request.
const ghWrite = (args) => golden.isCommentPost(args) || (args[0] === 'issue' && args[1] === 'edit')
  || (args[0] === 'label' && args[1] === 'create') || (args[0] === 'pr' && ['create', 'edit', 'ready'].includes(args[1]));

test('a run stop during a repo-lock wait skips the queued effect and only needs-human reporting follows', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const runState = { stop: null, remoteNotBefore: 0 };
  let before;
  let written;
  // Another Ticket stops the run while this one's push waits for the repo lock.
  const lock = contendRepoLock(t, g.commonDir, () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
    before = g.gh.calls.length;
    written = { ...counts };
  });
  const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(lock.state(), 'released', 'the push waited for the lock');
  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
  assert.deepEqual(counts, written, 'no git write follows the stop');
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.equal(final.terminalReason.text, 'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this '
    + 'Execution stopped before green 4.');
  const writes = g.gh.calls.slice(before).filter((c) => ghWrite(c.args));
  assert.equal(writes.length, 2, JSON.stringify(writes.map((c) => c.args)));
  assert.ok(golden.isCommentPost(writes[0].args, golden.TICKET), 'the needs-human comment');
  assert.ok(ticketComments(g).at(-1).body.startsWith('### gg: needs-human'));
  assert.ok(writes[1].args.join(' ').includes('--add-label gg:state:needs-human'), 'the needs-human label');
});

test('runExecution uses an injected integrity and Test Immutability', async (t) => {
  const g = await golden.setup(t);
  const calls = [];
  const spy = (name, fn) => async (...args) => {
    calls.push(name);
    return fn(...args);
  };
  const injected = Object.fromEntries(['snapshot', 'isCleanAt', 'untrackedFiles', 'ignoredFiles', 'restoreUntracked', 'begin', 'end']
    .map((name) => [name, spy(name, integrity[name])]));
  const result = await interpreter.runExecution({ ...g.options, integrity: injected, testImmutability: spy('testImmutability', checks.testImmutability) });
  assert.equal(result.outcome, 'done');
  // Clean before red, then each agent call between its begin and end, then Test Immutability with the Green Check.
  assert.deepEqual(calls, ['isCleanAt', 'begin', 'end', 'begin', 'end', 'testImmutability']);
});
