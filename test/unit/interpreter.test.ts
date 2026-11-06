import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../lib/config.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as publicText from '../../lib/public-text.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as caseDatabase from '../support/case-database.ts';
import { actionEvent, attemptsOf, branchMessages, intents, loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { WRONG_ADD, greenFixture, greenWrites, runFirstVisit } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { editRuns } from '../support/suite-runs.ts';

type GoldenFixture = golden.GoldenFixture;
type GoldenConfig = golden.GoldenConfig;
// A configured Vertex's routes, or its Flow's, as a case edits them.
type Routes = Record<string, unknown>;
// A configured Procedure with the Claim tokens a case edits.
type ConfiguredProcedure = GoldenConfig['procedures'][string] & {
  claimTokens: Record<string, Record<string, unknown>>;
};
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);

test('the green call is a fresh session with the full brief', async (t) => {
  const fixture = await runFirstVisit(t);
  assert.equal(fixture.harness.calls.length, 2);
  const [red, green] = fixture.harness.calls;
  assert.equal(red.resume, null);
  assert.equal(green.resume, null);
  assert.ok(green.brief!.includes('test/add.test.mjs'), 'committed test list in the green brief');
  assert.ok(green.brief!.includes("Cannot find module 'lib/add.mjs'"), 'red output in the green brief');
  assert.equal(red.personaBytes, golden.PERSONA, 'red persona bytes come from the visit snapshot');
  assert.equal(green.personaBytes, golden.PERSONA, 'green persona bytes come from the visit snapshot');
  assert.equal(green.personaHash, red.personaHash);
  const session = fixture.executionRecord.sessions[keys.sessionKey({ vertex: 'green', visit: 1, action: 'green' })];
  assert.ok(session, 'green session recorded under green/1/green');
  assert.equal(session.sessionId, 'fake-session-2');
  assert.match(session.transcriptPath!, /fake-session-2\.jsonl$/);
  assert.equal((session.cumulativeUsage as { inputTokens: number }).inputTokens, 200);
  assert.equal(
    fixture.executionRecord.sessions[keys.sessionKey({ vertex: 'red', visit: 1, action: 'red' })]!.sessionId,
    'fake-session-1',
  );
});

test('a Persona from the repository Layer is pinned with its hash', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-persona-layer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(join(repo, '.agents', 'gg'), { recursive: true });
  writeFileSync(config.layerPath(repo), '{"agents":{"implementer":{"persona":"repo-implementer.md"}}}');
  writeFileSync(join(repo, '.agents', 'gg', 'repo-implementer.md'), '# repo implementer\n');
  const layered = config.loadLayers(repo, join(directory, 'home'));
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    configured.files = layered.files;
    configured.agents.implementer!.persona = (layered.agents as GoldenConfig['agents']).implementer!.persona;
  });
  fixture.options.files = layered.files;
  await interpreter.runExecution(fixture.options);
  const [red, green] = fixture.harness.calls;
  assert.equal(red.personaBytes, '# repo implementer\n');
  assert.equal(red.personaHash, '906646d8774b848deba8dffcf8c2b5961d3f249ca95cc4b5f025d299d66036e1');
  assert.equal(green.personaHash, red.personaHash);
  const redSession = keys.sessionKey({ vertex: 'red', visit: 1, action: 'red' });
  assert.equal(fixture.executionRecord.sessions[redSession]!.personaName, 'repo-implementer.md');
  assert.equal(fixture.executionRecord.sessions[redSession]!.personaHash, red.personaHash);
});

test('Red Evidence keeps raw local paths for the green Brief', async (t) => {
  const fixture = await golden.fixture(t);
  const path = join(fixture.worktree, 'test', 'add.test.mjs');
  editRuns(fixture, (result) => ({ ...result, output: `${result.output}\n    at (${path}:1:1)` }));
  await interpreter.runExecution(fixture.options);
  const executionRecord = (await record.load(fixture.commonDir, 'ticket', golden.TICKET))!;
  const redCheck = executionRecord.outputs.find((output) => output.vertex === 'red' && output.action === 'red-check');
  const { output } = (redCheck!.value as { evidence: { output: string } }).evidence;
  assert.ok(output.includes(path), output);
  assert.ok(fixture.harness.calls[1]!.brief!.includes(`${path}:1:1`), 'the green Brief quotes the raw path');
  assert.ok(!fixture.gh.pr()!.body!.includes(fixture.root), 'the PR body does not');
});

// The golden Execution with TOKEN in every public field a Ticket, a response, a Check or the configuration gives, and
// a publicText that marks each TOKEN it is given once more.
async function tokenRun(t: TestContext) {
  const responses = firstVisitWith();
  responses[RED_CALL]!.response = { ...golden.redResponse, summary: 'TOKEN red summary' };
  Object.assign(responses[GREEN_CALL]!.response as object, {
    summary: 'TOKEN green summary',
    definitionOfDone: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
    qa: {
      setup: 'TOKEN setup',
      steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
      edgeCases: ['TOKEN edge'],
      automated: ['TOKEN automated'],
      manual: ['TOKEN manual'],
    },
  });
  const fixture = await golden.fixture(t, { responses });
  fixture.options.ticket.title = 'Add TOKEN';
  fixture.options.commands = { test: 'npm test TOKEN' };
  // Configuration reaches commit trailers and provenance cells too, each of which is public text.
  golden.configure(fixture, (configured) => {
    configured.files['TOKEN.md'] = golden.layerFile(golden.PERSONA);
    Object.assign(configured.agents.implementer!, {
      model: 'model TOKEN',
      effort: 'TOKEN effort',
      persona: 'TOKEN.md',
    });
  });
  editRuns(fixture, (result) => ({ ...result, output: `${result.output}\nTOKEN output` }));
  // Each pass marks the field again, so a second redaction shows as TOKEN** and a missed one as a bare TOKEN.
  (fixture.options as runContext.ExecutionOptions).publicText = (text: string) => text.replaceAll('TOKEN', 'TOKEN*');
  await interpreter.runExecution(fixture.options);
  return fixture;
}

test('each public field is redacted once and sent exactly as its intent saved it', async (t) => {
  const fixture = await tokenRun(t);

  const executionRecord = (await record.load(fixture.commonDir, 'ticket', golden.TICKET))!;
  const messages = await branchMessages(fixture);
  const sent = [...fixture.gh.calls.flatMap((call) => [...call.args, call.input ?? '']), ...messages];
  assert.deepEqual(
    sent.filter((text) => /TOKEN(?!\*)|TOKEN\*\*/.test(text)),
    [],
    'nothing is sent unredacted or redacted twice',
  );
  const body = fixture.gh.pr()!.body!;
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
  assert.ok(messages[0]!.includes('Gg-Vertex: red fake/model TOKEN*/TOKEN* effort'), messages[0]);
  assert.ok(messages[1]!.includes('Gg-Vertex: green fake/model TOKEN*/TOKEN* effort'), messages[1]);
  assert.ok(
    fixture.gh.calls.some((call) => call.args.includes('--title') && call.args.includes('Add TOKEN*')),
    'the PR title',
  );
  assert.deepEqual(
    intents(executionRecord, 'commit').map((entry) => (entry.payload as { message: string }).message.trim()),
    messages,
  );
  // A comment goes as the JSON body of its gh api POST.
  const saved = [
    ...intents(executionRecord, 'comment').map((entry) =>
      JSON.stringify({ body: (entry.payload as { body: string }).body }),
    ),
    ...intents(executionRecord, 'pr-upsert').map((entry) => (entry.payload as { body: string }).body),
  ];
  assert.deepEqual(
    saved.filter((wire) => !fixture.gh.calls.some((call) => call.input === wire)),
    [],
    'every comment and PR body is sent as saved',
  );
});

// The storage cut of a long Check output must not leave the start of a known directory where redaction cannot match it.
const ALICE = '/home/alice/' + 'n'.repeat(300);
// The padding makes the line 65,536 characters long from just past the "a" of its first alice, so the cut lands there.
const REDACTED_OVERLONG = `${ALICE}/private.txt ` + `${ALICE}/x `.repeat(200) + ' '.repeat(2_218);
const longLines = {
  'an overlong': ['/home/alice', '/home/alice/private.txt' + ' '.repeat(65_520)],
  'a redacted overlong': [ALICE, REDACTED_OVERLONG],
};
for (const [kind, [directory, output]] of Object.entries(longLines) as [string, [string, string]][]) {
  test(`${kind} Check output line publishes no fragment of a known directory`, async (t) => {
    const fixture = await golden.fixture(t);
    (fixture.options as runContext.ExecutionOptions).publicText = (text: string) =>
      publicText.publicText(text, [directory]);
    editRuns(fixture, (result) => (result.code === 0 ? { ...result, output } : result));
    await interpreter.runExecution(fixture.options);
    assert.ok(fixture.gh.pr(), 'the PR carries the Green evidence');
    const sent = JSON.stringify(fixture.gh.calls.map(({ args, input }) => [args, input]));
    assert.ok(!sent.includes('alice'), `${kind}: alice published`);
    assert.ok(!sent.includes('lice/'), `${kind}: lice/ published`);
  });
}

// The first flip each way: red's clean check is the first whileBusy, busy at generation 1 and idle at 2. A save that
// carries a Terminal passes, so a fault reported after the failure would land.
for (const [name, from, to, generation, activity] of [
  ['busy', false, true, 1, { busy: false, generation: 0 }],
  ['idle', true, false, 2, { busy: true, generation: 1 }],
] as const) {
  test(`a failed ${name} save saves nothing more of that record`, async (t) => {
    const fixture = await golden.fixture(t);
    caseDatabase.failSaves(
      t,
      (saved, next) =>
        (saved as record.ExecutionRecord | undefined)?.activity.busy === from &&
        (next as record.ExecutionRecord).activity.busy === to &&
        (next as record.ExecutionRecord).activity.generation === generation &&
        (next as record.ExecutionRecord).terminalStop == null,
    );
    const err = await interpreter.runExecution(fixture.options).then(
      () => null,
      (error: unknown) => error as Error,
    );

    assert.equal(err?.name, 'RecordSaveError', String(err));
    const saved = await loadTicket(fixture);
    assert.equal(saved.state, 'active', 'no fault is saved');
    assert.equal(saved.terminalStop, null, 'nor its Terminal');
    assert.deepEqual(saved.activity, activity, 'the failed flip is not saved by a cleanup');
    assert.equal(fixture.gh.comments.length, 0, 'no fault report');
    assert.ok(!fixture.readEvents().some((event) => event.type === 'ticket_end'));
  });
}

test('runExecution asks the injected integrity whether an Attempt kept to its access', async (t) => {
  const fixture = await golden.fixture(t);
  const violation = { worktree: fixture.worktree, surface: 'head', before: fixture.base, after: 'a'.repeat(40) };
  const injected = { ...fixture.options.deps.integrity, end: async () => ({ violations: [violation] }) };
  const result = await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, integrity: injected } as runContext.Deps,
  });

  assert.equal(result.outcome, 'needs-human');
  const red = actionEvent(fixture, 'red', 'red')!;
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.integrityViolations, [violation]);
});

test('runExecution asks the injected Test Immutability whether the committed tests still match', async (t) => {
  const fixture = await golden.fixture(t);
  const testImmutability = async () => ({ ok: false, changed: ['test/add.test.mjs'] });
  const result = await interpreter.runExecution({ ...fixture.options, testImmutability });

  assert.equal(result.outcome, 'needs-human');
  const call = actionEvent(fixture, 'green', 'green')!;
  assert.equal(call.outcome, 'integrity-violation');
  assert.deepEqual(call.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] },
  ]);
  assert.equal(actionEvent(fixture, 'green', 'test'), undefined, 'decided at the agent Action, before any Check');
});

// A green agent that rewrites a test red committed is held, not merged, here through the fake integrity (R3).
test('a green agent that rewrites a committed test is an integrity violation', async (t) => {
  const responses = firstVisitWith();
  responses[GREEN_CALL]!.files!['test/add.test.mjs'] = '// weakened\n';
  const fixture = await golden.fixture(t, { responses });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.deepEqual(actionEvent(fixture, 'green', 'green')!.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] },
  ]);
});

test("the Protected Files are gg's paths plus every shipped Harness's paths", async () => {
  const shipped = await import('../../lib/harnesses/shipped.ts');
  assert.deepEqual(interpreter.protectedFiles({}), ['.agents/', '.github/actions/', '.github/workflows/']);
  assert.deepEqual(interpreter.protectedFiles(shipped.HARNESSES), [
    '.agents/',
    '.claude/',
    '.codex/',
    '.github/actions/',
    '.github/workflows/',
    '.mcp.json',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
  assert.deepEqual(
    interpreter.protectedFiles({
      first: { protectedPaths: ['.agents/', 'Z.md'] },
      second: { protectedPaths: ['.b/'] },
    }),
    ['.agents/', '.b/', '.github/actions/', '.github/workflows/', 'Z.md'],
  );
});

for (const [what, protectedPaths] of [
  ['no paths', undefined],
  ['a string', '.x/'],
  ['an empty path', ['.x/', '']],
  ['a non-string path', [1]],
] as const) {
  test(`the Protected Files refuse a Harness that declares ${what}`, () => {
    const harnesses = { ok: { protectedPaths: [] }, broken: { protectedPaths } };
    assert.throws(() => interpreter.protectedFiles(harnesses as Parameters<typeof interpreter.protectedFiles>[0]), {
      message: 'harness broken must declare protectedPaths as an array of paths',
    });
  });
}

test('runExecution asserts the Protected Files it is given', async (t) => {
  const fixture = await golden.fixture(t);
  const seen: [string, string[] | undefined][] = [];
  const integrityOf = fixture.options.deps.integrity as integrity.Integrity;
  const injected = {
    ...integrityOf,
    begin: (args: Parameters<integrity.Integrity['takeBaseline']>[0]) => {
      seen.push(['begin', args.protectedPaths]);
      return integrityOf.takeBaseline(args);
    },
    end: (args: Parameters<integrity.Integrity['findViolations']>[0]) => {
      seen.push(['end', args.protectedPaths]);
      return integrityOf.findViolations(args);
    },
  };
  await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, integrity: injected },
    protectedPaths: ['.x/'],
  });
  assert.deepEqual(seen.slice(0, 2), [
    ['begin', ['.x/']],
    ['end', ['.x/']],
  ]);
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, protectedPaths: undefined as unknown as string[] }),
    { message: 'runExecution needs protectedPaths' },
  );
});

const reportMarker = (fixture: GoldenFixture, vertex: string, action: string) =>
  marker.formatMarker({
    execution: fixture.executionRecord.execution,
    vertex,
    visit: 1,
    action,
    recovery: 0,
    run: fixture.executionRecord.run,
    attempt: 1,
  });

test("a hold's label is set after its comment, each under its own marker", async (t) => {
  const fixture = await golden.fixture(t);
  const result = await interpreter.runExecution({
    ...fixture.options,
    admission: {
      kind: 'hold',
      name: 'dirty-worktree',
      terminalReasonText: 'The worktree has uncommitted changes gg did not make, so the Ticket is held.',
    },
  });

  assert.equal(result.held, true, JSON.stringify(result));
  const executionRecord = await loadTicket(fixture);
  const [comment, label] = ['hold-comment', 'hold-label'].map((action) => reportMarker(fixture, 'needs-human', action));
  assert.deepEqual(
    executionRecord.writeAheadLog
      .filter((entry) => entry.step === 'intent')
      .map((entry) => [entry.effect, entry.actionMarker]),
    [
      ['comment', comment],
      ['label', label],
    ],
  );
  const order = executionRecord.writeAheadLog.map((entry) => `${entry.step} ${entry.actionMarker}`);
  assert.ok(
    order.indexOf(`complete ${comment}`) < order.indexOf(`intent ${label}`),
    'the label is intended once the comment completed',
  );
  const [posted] = fixture.gh.comments;
  assert.ok(posted!.body.includes(marker.markerComment(comment!)), 'the comment carries its own marker');
  assert.ok(fixture.gh.labels.has('gg:state:needs-human'));
  assert.deepEqual(writeAhead.openIntents(executionRecord), []);
});

test("a fault during an end does not replay the end's open reporting Action", async (t) => {
  const fixture = await golden.fixture(t);
  const real = fixture.options.deps.gh.comment;
  let calls = 0;
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    comment: async (...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error('gh comment down');
      return real(...args);
    },
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, true, JSON.stringify(result));
  const executionRecord = await loadTicket(fixture);
  const ended = reportMarker(fixture, 'ready-for-qa', 'end-comment');
  assert.deepEqual(
    writeAhead.openIntents(executionRecord).map((entry) => entry.actionMarker),
    [ended],
    "the end's comment stays open",
  );
  assert.equal(calls, 2, "the end's comment is tried once and the fault's once");
  const [posted, ...rest] = fixture.gh.comments.filter((comment) => comment.target === 'issue');
  assert.equal(rest.length, 0);
  assert.ok(
    posted!.body.includes(marker.markerComment(reportMarker(fixture, 'needs-human', 'fault-comment'))),
    'the fault reports under its own marker',
  );
  assert.ok(
    executionRecord.writeAheadLog.some(
      (entry) =>
        entry.step === 'complete' && entry.actionMarker === reportMarker(fixture, 'needs-human', 'fault-label'),
    ),
  );
  assert.ok(
    executionRecord.writeAheadLog.some(
      (entry) => entry.step === 'complete' && entry.actionMarker === reportMarker(fixture, 'publish', 'pr-ready'),
    ),
    "publish's pr-ready completed first",
  );
});

test("the PR's provenance counts a retried Attempt and a resumed Session once each", async (t) => {
  const usage = (input: number, output: number) => ({ usage: { delta: { inputTokens: input, outputTokens: output } } });
  const red = golden.firstVisitResponses[RED_CALL]!;
  const fixture = await greenFixture(t, {
    responses: {
      // A parse retry: two Attempts of red, each one call.
      [RED_CALL]: { ...red, response: null, result: usage(10, 2) },
      [keys.responseKey('red', 1, 'red', 2)]: { ...red, result: usage(100, 20) },
      // the recovery pass resumes green's Session, whose cumulative usage then holds green's tokens too.
      [GREEN_CALL]: { ...greenWrites({ 'lib/add.mjs': WRONG_ADD }), result: usage(200, 40) },
      [keys.responseKey('green', 1, 'recover', 1)]: {
        ...greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
        result: usage(50, 5),
      },
    },
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const body = fixture.gh.pr()!.body!;
  assert.match(body, /^\| red \| .* \| 2 \| 110 \(0\) \/ 22 \|$/m, body);
  assert.match(body, /^\| green \| .* \| 2 \| 250 \(0\) \/ 45 \|$/m, body);
});

// publish's pr-ready marks ready only the commit its Check passed on, while the PR's head is that commit (T1a, M1).
const publishing = async (t: TestContext, during: (fixture: GoldenFixture) => void | Promise<void>) => {
  const fixture = await golden.fixture(t);
  editRuns(fixture, async (result) => {
    if (fixture.executionRecord.cursor.vertex === 'publish') await during(fixture);
    return result;
  });
  return { ...fixture, result: await interpreter.runExecution(fixture.options) };
};
const markedReady = (fixture: GoldenFixture) =>
  fixture.gh.calls.some((call) => call.args[0] === 'pr' && call.args[1] === 'ready');

test('pr-ready holds when the worktree changed after its Check passed', async (t) => {
  const fixture = await golden.fixture(t);
  const appendEvent = fixture.options.events;
  // A committed file is rewritten once publish's test has passed, so the worktree is no longer the commit it publishes.
  fixture.options.events = (type, data) => {
    appendEvent(type, data);
    if (type === 'action' && data!.vertex === 'publish' && data!.action === 'test')
      writeFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'export const add = (a, b) => b + a;\n');
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(result.held, true);
  assert.equal(markedReady(fixture), false, 'gh pr ready never runs');
  assert.equal(fixture.gh.pr()!.isDraft, true, 'the PR stays a draft');
  const executionRecord = await loadTicket(fixture);
  assert.deepEqual(executionRecord.terminalReason!.decidedBy, { hold: 'unchecked-publish' });
  assert.match(executionRecord.terminalReason!.text, /the worktree is not clean at commit \w+/);
  assert.ok(fixture.gh.labels.has('gg:state:needs-human'));
});

test('pr-ready holds when only the remote PR head moved after the push', async (t) => {
  const moved = 'e'.repeat(40);
  const fixture = await publishing(t, (during) => {
    during.gh.pr()!.headRefOid = moved;
  });

  assert.equal(fixture.result.outcome, 'needs-human', JSON.stringify(fixture.result));
  assert.equal(fixture.result.held, true);
  assert.equal(markedReady(fixture), false, 'gh pr ready never runs');
  assert.equal(fixture.gh.pr()!.isDraft, true, 'the PR stays a draft');
  const executionRecord = await loadTicket(fixture);
  assert.deepEqual(executionRecord.terminalReason!.decidedBy, { hold: 'unchecked-publish' });
  assert.ok(executionRecord.terminalReason!.text.includes(moved), executionRecord.terminalReason!.text);
  assert.equal(
    await fixture.options.deps.git.remoteSha(fixture.mainRoot, golden.BRANCH),
    await fixture.options.deps.git.headSha(fixture.worktree),
    "gg's push stands",
  );
});

const timedOut = {
  [GREEN_CALL]: { files: {}, response: null, result: { status: 'timed-out' } },
  [keys.responseKey('green', 1, 'green', 2)]: { files: {}, response: null, result: { status: 'timed-out' } },
};

test('an unrouted harness-timeout ends at needs-human', async (t) => {
  const fixture = await golden.fixture(t, { responses: firstVisitWith(timedOut) });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(attemptsOf(fixture, 'green', 'green').at(-1)!.outcome, 'harness-timeout');
  const executionRecord = await loadTicket(fixture);
  assert.equal(executionRecord.terminalReason!.outcome, 'harness-timeout');
  assert.deepEqual(executionRecord.terminalReason!.rule, { table: 'fixed', row: 'timeout-exhausted' });
  assert.ok(fixture.gh.labels.has('gg:state:needs-human'));
});

test('a routed harness-timeout takes its route', async (t) => {
  const fixture = await golden.fixture(t, { responses: firstVisitWith(timedOut) });
  golden.configure(fixture, (configured) => {
    (configured.flows.golden!.ticket.vertices.green!.route as Routes)['harness-timeout'] = { end: 'needs-replan' };
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-replan', JSON.stringify(result));
  assert.ok(fixture.gh.labels.has('gg:state:needs-replan'));
});

test('a stop comment replaces the end comment and reaches the Epic at needs-replan', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const responses = firstVisitWith({
    [GREEN_CALL]: { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis } },
  });
  const fixture = await golden.fixture(t, { responses });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-replan', JSON.stringify(result));
  const executionRecord = await loadTicket(fixture);
  assert.equal(executionRecord.state, 'needs-replan');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-replan']);
  const onTicket = fixture.gh.comments.filter((comment) => comment.number === golden.TICKET);
  assert.equal(onTicket.length, 1, 'one comment on the Ticket');
  assert.match(onTicket[0]!.body, /^### gg: misscoped\n/, 'the stop comment, not the end comment');
  assert.ok(onTicket[0]!.body.includes(diagnosis));
  assert.ok(
    onTicket[0]!.body.includes(`**Terminal Reason:** ${executionRecord.terminalReason!.text}`),
    'it carries the Terminal Reason',
  );
  const onEpic = fixture.gh.comments.filter((comment) => comment.number === executionRecord.epic);
  assert.equal(onEpic.length, 1, 'the same comment on the Epic');
  const unmarked = (body: string) => body.replace(/<!-- gg-action \S+ -->/, '');
  assert.equal(unmarked(onEpic[0]!.body), unmarked(onTicket[0]!.body));
});

test("a stop token's comment names the stopped Visit's own outputs and inputs", async (t) => {
  const responses = firstVisitWith({
    [GREEN_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'blocked', summary: 'SENTINEL green summary' },
    },
  });
  const fixture = await golden.fixture(t, { responses });
  golden.configure(fixture, (configured) => {
    configured.files['stop-direct.md'] = golden.layerFile(
      'own: {{green.response.summary}}\ninput: {{inputs.red.output}}\n{{marker}}\n',
    );
    (configured.procedures.implement as ConfiguredProcedure).claimTokens.blocked!.comment = 'stop-direct.md';
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'needs-human');
  const onTicket = fixture.gh.comments.filter((comment) => comment.number === golden.TICKET);
  assert.equal(onTicket.length, 1, 'one comment on the Ticket');
  assert.ok(
    onTicket[0]!.body.startsWith(`own: SENTINEL green summary\ninput: ${golden.RED_OUTPUT}\n`),
    onTicket[0]!.body,
  );
});

test('the Flow\'s route for an Outcome beats the Vertex\'s "*" (H7)', async (t) => {
  const responses = firstVisitWith({
    [GREEN_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: 'Two tickets.' },
    },
  });
  const fixture = await golden.fixture(t, { responses });
  golden.configure(fixture, (configured) => {
    (configured.flows.golden!.ticket.vertices.green!.route as Routes)['*'] = { end: 'needs-human' };
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'needs-replan');
});

test("the Vertex's route for an Outcome beats the Flow's route for it (H7)", async (t) => {
  const responses = firstVisitWith({
    [GREEN_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: 'Two tickets.' },
    },
  });
  const fixture = await golden.fixture(t, { responses });
  golden.configure(fixture, (configured) => {
    (configured.flows.golden!.ticket.vertices.green!.route as Routes).misscoped = { end: 'needs-human' };
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'needs-human');
  assert.equal((await loadTicket(fixture)).terminalReason!.outcome, 'misscoped');
});

test('no "*" catches an unroutable Outcome', async (t) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.ticket.routes['*'] = { end: 'needs-replan' };
    (configured.flows.golden!.ticket.vertices.red!.route as Routes)['*'] = { end: 'needs-replan' };
  });
  const violation = { worktree: fixture.worktree, surface: 'head', before: fixture.base, after: 'a'.repeat(40) };
  const result = await interpreter.runExecution({
    ...fixture.options,
    deps: {
      ...fixture.options.deps,
      integrity: { ...fixture.options.deps.integrity, findViolations: async () => ({ violations: [violation] }) },
    } as runContext.Deps,
  });
  assert.equal(result.outcome, 'needs-human', 'an Integrity Violation is never routed');
});
