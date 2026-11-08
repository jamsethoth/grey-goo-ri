import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import type * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import { signalsOf } from '../support/action-signals.ts';
import { GREEN_FAIL_OUTPUT } from '../support/add-suite.ts';
import * as caseDatabase from '../support/case-database.ts';
import { actionEvent, loadTicket, subjects } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { RIGHT_ADD, WRONG_ADD, greenFixture, greenTrace, greenWrites } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { actionById, replaceAction } from '../support/procedure-actions.ts';
import { answerAll } from '../support/suite-runs.ts';

type GoldenFixture = golden.GoldenFixture;
type GoldenConfig = golden.GoldenConfig;
// A configured Procedure's Claim tokens, or a Vertex's inputs, as a case edits them.
type ClaimTokens = Record<string, Record<string, unknown>>;
type Inputs = Record<string, unknown>;
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);
// The first Attempt of the agent Action `ask` at the first Visit of `vertex`.
const askOf = (vertex: string) => keys.responseKey(vertex, 1, 'ask', 1);

// Procedures are configuration: these cases declare Procedures of their own, with names gg does not know (#116).
const PROBE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { claim: { type: 'string', enum: ['ok', 'blocked'] }, summary: { type: 'string' } },
  required: ['claim', 'summary'],
  additionalProperties: false,
});
const probed = (summary: string, files = {}) => ({ files, response: { claim: 'ok', summary } });
// The files a declared Procedure below names: a Brief that names nothing and the probe schema.
function probeFiles(configured: GoldenConfig) {
  configured.files['plain.md'] = golden.layerFile('Do the work.\n');
  configured.files['probe.schema.json'] = golden.layerFile(PROBE_SCHEMA);
}
// An agent Action, the test command as Check `gate`, and a commit of `type`; `tests` as the Procedure declares it.
const sealing = (tests: string, type: string) => ({
  tests,
  actions: [
    { id: 'ask', do: 'agent', brief: 'plain.md', schema: 'probe.schema.json' },
    { id: 'gate', do: 'check', kind: 'command', command: 'test' },
    { id: 'seal', do: 'commit', type },
  ],
  claimTokens: { ok: { requires: ['gate'] }, blocked: { stop: true } },
});
type Immutability = Awaited<ReturnType<runContext.TestImmutability>>;
// Test Immutability scripted with ordered results; `baselines` records the commit each assertion compared against.
function scriptedImmutability(fixture: GoldenFixture, results: Immutability[]) {
  const baselines: (string | null)[] = [];
  fixture.options.testImmutability = async (_cwd, baseline) => {
    baselines.push(baseline);
    return results.shift()!;
  };
  return baselines;
}
const commitOf = (fixture: GoldenFixture, vertex: string) =>
  (
    fixture.executionRecord.writeAheadLog.find(
      (entry) =>
        entry.step === 'evidence' && entry.effect === 'commit' && marker.partsOf(entry.actionMarker)!.vertex === vertex,
    )!.evidence as { sha: string }
  ).sha;

test('the interpreter names no Procedure, Action or Check', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [askOf('build')]: probed('Probe the sum.', { 'lib/add.mjs': RIGHT_ADD }) },
  });
  golden.configure(fixture, (configured) => {
    configured.files['ask.md'] = golden.layerFile('Probe {{ticket.title}}.\n');
    configured.files['probe.schema.json'] = golden.layerFile(PROBE_SCHEMA);
    configured.files['probe-body.md'] = golden.layerFile(
      '{{ask.response.summary}}\n{{gate.evidence.output}}\n{{marker}}\n',
    );
    configured.procedures.probe = {
      actions: [
        { id: 'ask', do: 'agent', brief: 'ask.md', schema: 'probe.schema.json' },
        { id: 'gate', do: 'check', kind: 'command', command: 'test' },
        { id: 'seal', do: 'commit', type: 'chore' },
        { id: 'ship', do: 'push' },
        { id: 'post', do: 'pr-upsert', body: 'probe-body.md' },
        { id: 'done', do: 'pr-ready' },
      ],
      claimTokens: { ok: { requires: ['gate'] }, blocked: { stop: true } },
    };
    configured.flows.golden!.ticket = {
      entry: 'build',
      routes: { '*': { end: 'needs-human' } },
      vertices: { build: { use: 'implementer', procedure: 'probe', route: { ok: { end: 'ready-for-qa' } } } },
    };
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(
    golden.trace(fixture.readEvents()).map((event) => `${event.vertex}/${event.action}/${event.outcome}`),
    [
      'build/ask/ok',
      'build/gate/ok',
      'build/seal/ok',
      'build/ship/ok',
      'build/post/ok',
      'build/done/ok',
      'ready-for-qa/end-comment/ok',
      'ready-for-qa/end-label/ok',
    ],
  );
  assert.equal(fixture.harness.calls[0]!.brief, 'Probe Add two numbers.\n');
  assert.deepEqual(await subjects(fixture), ['chore: Add two numbers (#15)']);
  assert.ok(fixture.gh.pr()!.body!.startsWith(`Probe the sum.\n${golden.GREEN_OUTPUT}\n`), fixture.gh.pr()!.body!);
  assert.equal(fixture.gh.pr()!.isDraft, false, 'pr-ready marked the PR ready');
});

// The interpreter's modules (AGENTS.md's layout table).
const INTERPRETER = [
  'interpreter',
  'run-context',
  'visit-runner',
  'visit-scope',
  'bounds',
  'agent-action',
  'agent-call',
  'check-action',
  'effect-actions',
];
test(
  'lib/interpreter.ts and its modules hold no Procedure table, describe, ' + 'shipped Procedure name or phase read',
  () => {
    const source = INTERPRETER.map((name) =>
      readFileSync(new URL(`../../lib/${name}.ts`, import.meta.url), 'utf8'),
    ).join('\n');
    assert.doesNotMatch(source, /PROCEDURES|procedures\.describe/);
    assert.doesNotMatch(source, /'(red|green|fix|review|implement|publish)'/);
    assert.doesNotMatch(source, /\.phase\b/);
  },
);

test('a Vertex with no access set runs read-only', async (t) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    delete (configured.agents.implementer as Partial<GoldenConfig['agents'][string]>).access;
  });
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const result = await run(call);
    fixture.fakeIntegrity!.write(fixture.worktree, 'test/add.test.mjs');
    return result;
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls[0]!.access, 'read-only');
  const red = actionEvent(fixture, 'red', 'red')!;
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal((red.integrityViolations![0] as { surface: string }).surface, 'tree');
});

test(
  "a Harness that edits its call changes neither the Attempt's marker " + 'nor its saved Agent and Persona',
  async (t) => {
    const fixture = await golden.fixture(t);
    const sent: (string | undefined)[] = [];
    const run = fixture.harness.run;
    fixture.harness.run = async (call) => {
      const result = await run(call);
      sent.push(call.marker as string | undefined);
      Object.assign(call, { marker: 'gg:edited', agent: { harness: 'edited' }, persona: { name: 'edited' } });
      return result;
    };
    const { outcome } = await interpreter.runExecution(fixture.options);

    assert.equal(outcome, 'ready-for-qa');
    const executionRecord = await loadTicket(fixture);
    assert.deepEqual(
      sent.map((actionMarker) =>
        executionRecord.writeAheadLog.filter((entry) => entry.actionMarker === actionMarker).map((entry) => entry.step),
      ),
      [
        ['intent', 'evidence', 'complete'],
        ['intent', 'evidence', 'complete'],
      ],
    );
    assert.deepEqual(
      Object.entries(executionRecord.sessions).map(([key, session]) => [key, session.harness, session.personaName]),
      [
        ['red/1/red', 'fake', 'implementer.md'],
        ['green/1/green', 'fake', 'implementer.md'],
      ],
    );
    assert.equal((actionEvent(fixture, 'red', 'red') as { harness?: string }).harness, 'fake');
  },
);

test('an Attempt resolves its tools and runs on the one Harness it began with', async (t) => {
  const fixture = await golden.fixture(t);
  const log: string[] = [];
  const pair = new Map<string, unknown>();
  const harnesses: Record<string, unknown> = {};
  // Each Harness hands the next Attempt to the other one as it resolves its tools.
  const handing = (name: string, next: string) => ({
    ...fixture.harness,
    resolveTools: (agent: Parameters<typeof fixture.harness.resolveTools>[0]) => {
      log.push(`${name} tools`);
      harnesses.fake = pair.get(next);
      return fixture.harness.resolveTools(agent);
    },
    run: (call: Parameters<typeof fixture.harness.run>[0]) => {
      log.push(`${name} run`);
      return fixture.harness.run(call);
    },
  });
  pair.set('a', handing('a', 'b'));
  pair.set('b', handing('b', 'a'));
  harnesses.fake = pair.get('a');
  await interpreter.runExecution({ ...fixture.options, harnesses } as runContext.ExecutionOptions);

  assert.deepEqual(log, ['a tools', 'a run', 'b tools', 'b run']);
});

test("the Visit snapshot pins the Procedure's name and hash", async (t) => {
  const seen: Record<string, { name: string; hash: string }> = {};
  caseDatabase.onSave(t, (saved) => {
    const { configurationSnapshot } = saved as record.ExecutionRecord;
    if (configurationSnapshot)
      seen[`${configurationSnapshot.vertex}/${configurationSnapshot.visit}`] = structuredClone(
        configurationSnapshot.procedure,
      );
  });
  const fixture = await golden.fixture(t);
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(seen['green/1'], { name: 'implement', hash: fixture.flow.procedures.get('implement')!.hash });
  assert.match(seen['green/1']!.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(seen['red/1']!.hash, seen['green/1']!.hash);
});

test('a passed row does not count a Check that passed on an older tree', async (t) => {
  const fixture = await golden.fixture(t, { responses: { [askOf('look')]: probed('Looked.') } });
  golden.configure(fixture, (configured) => {
    probeFiles(configured);
    configured.commands.touch = 'npm run touch';
    configured.procedures.look = {
      access: 'read-only',
      actions: [
        { id: 'ask', do: 'agent', brief: 'plain.md', schema: 'probe.schema.json' },
        { id: 'gate', do: 'check', kind: 'command', command: 'test' },
        { id: 'touch', do: 'check', kind: 'command', command: 'touch' },
      ],
      claimTokens: { ok: { requires: [] }, blocked: { stop: true } },
      passed: [{ when: { 'check.gate': 'passed' }, outcome: 'ok' }],
      otherwise: 'stale',
    };
    configured.flows.golden!.ticket = {
      entry: 'look',
      routes: { '*': { end: 'needs-human' } },
      vertices: { look: { use: 'implementer', procedure: 'look' } },
    };
  });
  // Every command passes; touch also changes the worktree after gate checked it.
  answerAll(fixture, (command) => {
    if (command === 'npm run touch') writeFileSync(join(fixture.worktree, 'touched.txt'), 'x\n');
    return { code: 0, output: 'ok', timedOut: false };
  });
  await interpreter.runExecution(fixture.options);

  const gate = signalsOf(actionEvent(fixture, 'look', 'gate')!).checks;
  assert.equal(gate[0]!.state, 'passed', 'gate passed on the tree it checked');
  const reason = fixture.executionRecord.terminalReason!;
  assert.deepEqual([reason.outcome, reason.rule], ['stale', { table: 'passed', row: 'otherwise' }]);
});

test('a failing Check with no recoverBrief gets a default section', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': RIGHT_ADD }),
    },
  });
  golden.configure(fixture, (configured) => {
    delete actionById(configured.procedures.implement!, 'test').recoverBrief;
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  const recovery = fixture.harness.calls[2]!.brief!;
  assert.ok(recovery.includes('## The command Check test\n'), recovery);
  assert.ok(recovery.includes(GREEN_FAIL_OUTPUT), recovery);
});

test('a Check with recoverable: false is not recovered', async (t) => {
  const fixture = await greenFixture(t, { responses: { [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }) } });
  golden.configure(fixture, (configured) => {
    actionById(configured.procedures.implement!, 'test').recoverable = false;
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 2, 'no recovery call');
  assert.deepEqual(greenTrace(fixture), ['green/0', 'test/0']);
  assert.deepEqual(fixture.executionRecord.terminalReason!.rule, { table: 'failed', row: null });
});

test('Test Immutability is asserted after an agent Attempt of a write Vertex with no worktree Check', async (t) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    const implement = configured.procedures.implement!;
    replaceAction(implement, 'test', { id: 'test', do: 'check', kind: 'response', field: 'claim', is: 'ok' });
    // A response Check gives no evidence, so what read the command Check's now reads the Red Evidence.
    (actionById(implement, 'pr').with as Record<string, unknown>).green = 'inputs.red';
    (configured.flows.golden!.ticket.vertices.publish!.inputs as Inputs).green = { from: 'red.red-check.evidence' };
  });
  const baselines = scriptedImmutability(fixture, [{ ok: false, changed: ['test/add.test.mjs'] }]);
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(baselines, [commitOf(fixture, 'red')], "asserted once, against red's commit");
  const green = actionEvent(fixture, 'green', 'green')!;
  assert.equal(green.outcome, 'integrity-violation');
  assert.deepEqual((green.integrityViolations!.at(-1) as { after: unknown }).after, ['test/add.test.mjs']);
  assert.equal(actionEvent(fixture, 'green', 'commit'), undefined, 'green committed nothing');
});

test('Test Immutability uses the Execution base before any gg commit', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: { [askOf('one')]: probed('One.', { 'lib/add.mjs': RIGHT_ADD }) },
  });
  golden.configure(fixture, (configured) => {
    probeFiles(configured);
    configured.procedures.sealing = sealing('frozen', 'feat');
    configured.flows.golden!.ticket = {
      entry: 'one',
      routes: { '*': { end: 'needs-human' } },
      vertices: { one: { use: 'implementer', procedure: 'sealing' } },
    };
  });
  const baselines = scriptedImmutability(fixture, [{ ok: true, changed: [] }]);
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(baselines, [fixture.base]);
});

test('every gg commit moves the Test Immutability baseline', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [askOf('one')]: probed('One.', { 'lib/add.mjs': RIGHT_ADD }),
      [askOf('two')]: probed('Two.', { 'lib/two.mjs': 'export {};\n' }),
    },
  });
  golden.configure(fixture, (configured) => {
    probeFiles(configured);
    configured.procedures.sealing = sealing('frozen', 'feat');
    configured.flows.golden!.ticket = {
      entry: 'one',
      routes: { '*': { end: 'needs-human' } },
      vertices: {
        one: { use: 'implementer', procedure: 'sealing', route: { ok: 'two' } },
        two: { use: 'implementer', procedure: 'sealing' },
      },
    };
  });
  const baselines = scriptedImmutability(fixture, [
    { ok: true, changed: [] },
    { ok: true, changed: [] },
  ]);
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(baselines, [fixture.base, commitOf(fixture, 'one')]);
  assert.equal(fixture.executionRecord.testCommits.baseline, commitOf(fixture, 'two'));
});

test('a code-only commit does not become the first test commit', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: {
      [askOf('one')]: probed('Code.', { 'lib/add.mjs': RIGHT_ADD }),
      [askOf('two')]: probed('Tests.', { 'test/two.test.mjs': 'export {};\n' }),
    },
  });
  golden.configure(fixture, (configured) => {
    probeFiles(configured);
    configured.procedures.sealing = sealing('write', 'test');
    configured.flows.golden!.ticket = {
      entry: 'one',
      routes: { '*': { end: 'needs-human' } },
      vertices: {
        one: { use: 'implementer', procedure: 'sealing', route: { ok: 'two' } },
        two: { use: 'implementer', procedure: 'sealing' },
      },
    };
  });
  await interpreter.runExecution(fixture.options);

  assert.equal(fixture.executionRecord.testCommits.first, commitOf(fixture, 'two'));
});

const blockedGreen = () =>
  firstVisitWith({
    [GREEN_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'SENTINEL diagnosis' },
    },
  });

test('a stop token posts the comment its token names', async (t) => {
  const fixture = await golden.fixture(t, { responses: blockedGreen() });
  await interpreter.runExecution(fixture.options);

  const [stop] = fixture.gh.comments;
  assert.ok(stop!.body.startsWith('### gg: blocked\n'), stop!.body);
  assert.ok(stop!.body.includes('SENTINEL diagnosis'), stop!.body);
});

test('a stop token that names no comment posts the Terminal Reason comment', async (t) => {
  const fixture = await golden.fixture(t, { responses: blockedGreen() });
  golden.configure(fixture, (configured) => {
    delete (configured.procedures.implement!.claimTokens as ClaimTokens).blocked!.comment;
  });
  await interpreter.runExecution(fixture.options);

  const [terminal] = fixture.gh.comments;
  assert.ok(terminal!.body.startsWith('### gg: needs-human\n\n**Terminal Reason:** '), terminal!.body);
  assert.ok(!terminal!.body.includes('SENTINEL diagnosis'), terminal!.body);
});

test('a Procedure with no agent Action posts its comment', async (t) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    configured.files['note.md'] = golden.layerFile('a note\n{{marker}}\n');
    configured.procedures.say = { actions: [{ id: 'note', do: 'comment', target: 'ticket', body: 'note.md' }] };
    configured.flows.golden!.ticket = {
      entry: 'say',
      routes: { '*': { end: 'needs-human' } },
      vertices: { say: { procedure: 'say' } },
    };
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.fault, undefined, JSON.stringify(result));
  assert.ok(fixture.gh.comments[0]!.body.startsWith('a note\n'), fixture.gh.comments[0]!.body);
});
