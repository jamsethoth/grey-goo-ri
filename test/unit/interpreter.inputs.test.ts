import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import type * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import * as caseDatabase from '../support/case-database.ts';
import { intents, loadTicket, subjects } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { runFirstVisit } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { replaceAction } from '../support/procedure-actions.ts';
import { MAJOR, finding, fixed, review, reviewFixture, reviewed, runReviewFlow } from '../support/review-flow.ts';
import { editRuns } from '../support/suite-runs.ts';

type GoldenFixture = golden.GoldenFixture;
const FIRST_REVIEW = keys.responseKey('reviewer', 1, 'review', 1);
const FIRST_FIX = keys.responseKey('implementer-fix', 1, 'fix', 1);
const SECOND_REVIEW = keys.responseKey('reviewer', 2, 'review', 1);

// Each Visit's snapshot as last saved, by `vertex/visit`: the record keeps only the current Visit's.
function pinnedInputs(t: TestContext) {
  const seen: Record<string, Record<string, visit.VertexInput>> = {};
  caseDatabase.onSave(t, (saved) => {
    const { configurationSnapshot } = saved as record.ExecutionRecord;
    if (configurationSnapshot)
      seen[`${configurationSnapshot.vertex}/${configurationSnapshot.visit}`] = structuredClone(
        configurationSnapshot.inputs,
      );
  });
  return seen;
}
const briefOf = (fixture: GoldenFixture, vertex: string, visitNumber: number) =>
  fixture.harness.calls.find((call) => {
    const actionIdentity = marker.partsOf(call.marker!)!;
    return actionIdentity.vertex === vertex && actionIdentity.visit === String(visitNumber);
  })!.brief!;

test('a Brief names the base branch the Ticket branch was created from', async (t) => {
  const fixture = await runFirstVisit(t);
  assert.match(briefOf(fixture, 'green', 1), /, created from main\. Work only here\./);
});

test("green reads red's committed tests through an input", async (t) => {
  const pinned = pinnedInputs(t);
  const fixture = await runFirstVisit(t);
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(pinned['green/1']!.testFiles, {
    value: ['test/add.test.mjs'],
    vertex: 'red',
    visit: 1,
    action: 'commit',
    absent: false,
  });
  assert.equal(pinned['green/1']!.red!.vertex, 'red');
  assert.equal(pinned['green/1']!.red!.action, 'red-check');
  assert.match((pinned['green/1']!.red!.value as { output: string }).output, /Cannot find module 'lib\/add.mjs'/);
  assert.ok(briefOf(fixture, 'green', 1).includes('- test/add.test.mjs'), 'the Brief lists the input');
});

test('a list input takes the latest Visit across its sources', async (t) => {
  const pinned = pinnedInputs(t);
  const fixture = await runReviewFlow(t, {
    [FIRST_REVIEW]: reviewed(review('changes', [MAJOR])),
    [FIRST_FIX]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [SECOND_REVIEW]: reviewed(review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  const from = ({ vertex, visit: visitNumber, action }: visit.VertexInput) => ({ vertex, visit: visitNumber, action });
  assert.deepEqual(from(pinned['reviewer/1']!.report!), { vertex: 'green', visit: 1, action: 'green' });
  assert.deepEqual(from(pinned['reviewer/2']!.report!), { vertex: 'implementer-fix', visit: 1, action: 'fix' });
  assert.deepEqual(from(pinned['reviewer/2']!.green!), { vertex: 'implementer-fix', visit: 1, action: 'test' });
  assert.deepEqual(from(pinned['publish/1']!.report!), { vertex: 'implementer-fix', visit: 1, action: 'fix' });
  assert.ok(
    briefOf(fixture, 'reviewer', 2).includes('Address the findings.'),
    "the second review reads the fix's report",
  );
  assert.ok(!briefOf(fixture, 'reviewer', 1).includes('Address the findings.'));
  assert.ok(
    fixture.gh.pr()!.body!.includes('Address the findings.'),
    "publish renders the PR body from the fix's report",
  );
});

test('an absent optional input renders empty in the Brief', async (t) => {
  const pinned = pinnedInputs(t);
  const fixture = await golden.fixture(t);
  // A source no route produces: the reviewer's committed files, read before any review.
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.ticket.vertices.green!.inputs = {
      ...golden.GREEN_INPUTS,
      testFiles: { from: 'green.commit.files', optional: true },
    };
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(pinned['green/1']!.testFiles, {
    value: null,
    vertex: null,
    visit: null,
    action: null,
    absent: true,
  });
  assert.match(
    briefOf(fixture, 'green', 1),
    /## Committed tests\n\nThe orchestrator committed/,
    'the list renders empty',
  );
});

test('a Visit saves a state and inputs that declare every field', async (t) => {
  const saved: record.ExecutionRecord[] = [];
  caseDatabase.onSave(t, (next) => saved.push(structuredClone(next as record.ExecutionRecord)));
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.ticket.vertices.green!.inputs = {
      ...golden.GREEN_INPUTS,
      testFiles: { from: 'green.commit.files', optional: true },
    };
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');

  const green = saved.find((next) => next.configurationSnapshot?.vertex === 'green');
  assert.ok(green, 'a record was saved with the green Visit pinned');
  const { inputs } = green.configurationSnapshot!;
  const inputKeys = ['value', 'vertex', 'visit', 'action', 'absent'];
  assert.deepEqual(inputs.testFiles, { value: null, vertex: null, visit: null, action: null, absent: true });
  assert.deepEqual(Object.keys(inputs.testFiles!), inputKeys);
  assert.deepEqual(Object.keys(inputs.red!), inputKeys);
  assert.equal(inputs.red!.absent, false);

  const states = saved.filter((next) => next.visitState).map((next) => next.visitState!);
  assert.ok(states.length > 0, 'a Visit state was saved');
  for (const state of states)
    assert.deepEqual(Object.keys(state), [
      'recovery',
      'firstAttemptBaseline',
      'call',
      'response',
      'runs',
      'checks',
      'checkFollows',
      'settled',
      'unconfirmedCleanup',
    ]);
  const { settled } = states.findLast((state) => state.settled)!;
  assert.deepEqual(Object.keys(settled!), ['action', 'recovery', 'resolution']);
});

test('a held Execution saves a Terminal stop that declares every field', async (t) => {
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
  const { terminalStop } = await loadTicket(fixture);
  const expected = {
    outcome: 'needs-human',
    response: null,
    actionRef: null,
    held: true,
    abandoned: false,
    inProgress: false,
    fresh: false,
    stopped: false,
    commentTemplate: null,
    advice: null,
    detail: null,
    error: null,
    failureClass: null,
    interrupted: null,
  };
  assert.deepEqual(terminalStop, expected);
  assert.deepEqual(Object.keys(terminalStop!), Object.keys(expected));
});

test('a shipped Brief names its inputs directly', async (t) => {
  const responses = firstVisitWith();
  responses[keys.responseKey('red', 1, 'red', 1)]!.files!['test/sentinel.test.mjs'] =
    "import { add } from '../lib/add.mjs';\n";
  const fixture = await golden.fixture(t, { responses });
  editRuns(fixture, (result) => ({ ...result, output: `${result.output}\nSENTINEL red output` }));
  // The shipped green Brief, then every fixed name its context once carried for an input. Admission rejects those
  // names, so the file changes after it, to show the run itself carries no alias.
  fixture.files['templates/green.md'] = golden.layerFile(
    `${fixture.files['templates/green.md']!.bytes}\n[{{testFiles}}|{{redOutput}}|{{impl}}|{{report}}]`,
  );
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  const green = briefOf(fixture, 'green', 1);
  assert.ok(green.includes('- test/sentinel.test.mjs'), green);
  assert.ok(green.includes('SENTINEL red output'), green);
  assert.ok(green.endsWith('\n[|||]'), `no alias in the context:\n${green}`);
});

// The body the pr-upsert of `vertex` saved in its intent, before a later Vertex re-rendered it.
const prBodyOf = (fixture: GoldenFixture, vertex: string) =>
  (
    intents(fixture.executionRecord, 'pr-upsert').find(
      (entry) => marker.partsOf(entry.actionMarker)!.vertex === vertex,
    )!.payload as { body: string }
  ).body;

test('a template names its own outputs and inputs directly', async (t) => {
  const fixture = await reviewFixture(t, {
    [FIRST_REVIEW]: reviewed(review('ok', [], { summary: 'SENTINEL review summary' })),
  });
  golden.configure(fixture, (configured) => {
    configured.files['pr-direct.md'] = golden.layerFile(
      'green: {{test.evidence.output}}\nred: {{inputs.red.output}}\n{{marker}}\n',
    );
    configured.files['comment-direct.md'] = golden.layerFile('review: {{review.response.summary}}\n{{marker}}\n');
    replaceAction(configured.procedures.implement!, 'pr', { id: 'pr', do: 'pr-upsert', body: 'pr-direct.md' });
    replaceAction(configured.procedures.review!, 'comment', {
      id: 'comment',
      do: 'comment',
      target: 'pr',
      body: 'comment-direct.md',
    });
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  const green = prBodyOf(fixture, 'green');
  assert.ok(green.startsWith(`green: ${golden.GREEN_OUTPUT}\nred: ${golden.RED_OUTPUT}\n`), green);
  assert.deepEqual(
    fixture.gh.comments
      .filter((comment) => comment.body.startsWith('review: '))
      .map((comment) => comment.body.split('\n')[0]),
    ['review: SENTINEL review summary'],
  );
});

test('pick projects findings to file paths', async (t) => {
  const pinned = pinnedInputs(t);
  const named = finding('minor', 'test/add.test.mjs', 'the test misses negatives');
  const fixture = await reviewFixture(t, {
    [FIRST_REVIEW]: reviewed(review('changes', [MAJOR, named])),
    [FIRST_FIX]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [SECOND_REVIEW]: reviewed(review('ok')),
  });
  // The fix's Test Immutability sees the named test changed, which only its `tests: named` input permits.
  const immutability = fixture.options.testImmutability!;
  fixture.options.testImmutability = async (...args: Parameters<typeof immutability>) =>
    fixture.executionRecord.cursor.vertex === 'implementer-fix'
      ? { ok: false, changed: ['test/add.test.mjs'] }
      : immutability(...args);
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(pinned['implementer-fix/1']!.testFiles, {
    value: ['lib/add.mjs', 'test/add.test.mjs'],
    vertex: 'reviewer',
    visit: 1,
    action: 'review',
    absent: false,
  });
  assert.deepEqual(pinned['implementer-fix/1']!.findings!.value, [MAJOR, named]);
});

test('a commit with nothing to commit records files: [] and makes no commit', async (t) => {
  const fixture = await runReviewFlow(t, {
    [FIRST_REVIEW]: reviewed(review('changes', [MAJOR])),
    [FIRST_FIX]: fixed({}),
    [SECOND_REVIEW]: reviewed(review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  const commits = fixture.executionRecord.outputs.filter((output) => output.action === 'commit');
  assert.deepEqual(
    commits.map((output) => [output.vertex, output.visit, output.value.files]),
    [
      ['red', 1, ['test/add.test.mjs']],
      ['green', 1, ['lib/add.mjs']],
      ['implementer-fix', 1, []],
    ],
  );
  assert.deepEqual(
    await subjects(fixture),
    ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)'],
    'no fix commit',
  );
});

test("each draft PR body renders its own Vertex's report and Green Evidence", async (t) => {
  const fixture = await runReviewFlow(t, {
    [FIRST_REVIEW]: reviewed(review('changes', [MAJOR])),
    [FIRST_FIX]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [SECOND_REVIEW]: reviewed(review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  const greenSection = (body: string) => body.slice(body.indexOf('**Green**'), body.indexOf('## QA instructions'));

  const green = prBodyOf(fixture, 'green');
  assert.ok(green.includes('Add two numbers.'), `green's body renders green's report:\n${green}`);
  assert.ok(
    greenSection(green).includes('✔ adds two numbers (0.8ms)'),
    `green's Green section shows green's test.evidence:\n${green}`,
  );
  assert.ok(
    !greenSection(green).includes('Cannot find module'),
    `green's Green section does not show the Red Evidence:\n${green}`,
  );

  const fix = prBodyOf(fixture, 'implementer-fix');
  assert.ok(fix.includes('Address the findings.'), `the fix's body renders the fix's report:\n${fix}`);
  assert.ok(
    greenSection(fix).includes('✔ adds two numbers (0.8ms)'),
    `the fix's Green section shows the fix's test.evidence:\n${fix}`,
  );
  assert.ok(
    !greenSection(fix).includes('Cannot find module'),
    `the fix's Green section does not show the Red Evidence:\n${fix}`,
  );
});
