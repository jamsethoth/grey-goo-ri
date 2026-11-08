import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as briefs from '../../lib/briefs.ts';
import * as exampleLayer from '../support/example-layer.ts';

const ticket = {
  number: 7,
  title: 'Add widgets',
  body: '## Definition of done\n- [ ] widgets',
  branch: 'ticket/7-add',
};
const base = { ticket, baseBranch: 'origin/main', commands: { test: 'npm test' }, history: [] };
const redEvidence = { command: 'npm test', output: 'not ok 1 - widgets render' };
const greenInputs = { testFiles: ['test/widgets.test.mjs'], red: redEvidence };
// An example Brief by its file name.
const shipped = (name: string, context: briefs.BriefContext) => briefs.brief(exampleLayer.fixtureText(name), context);

// What the example's Briefs say (#120): GLOSSARY terms, the Visit's inputs, and nothing a Procedure does not read.
const VISIT_BRIEFS = { 'red.md': 'RED', 'green.md': 'GREEN', 'fix.md': 'FIX' };

test('the example Briefs use the GLOSSARY terms', () => {
  for (const name of exampleLayer.TEMPLATE_NAMES) {
    const brief = exampleLayer.fixtureText(name);
    assert.doesNotMatch(brief, /structured result|repo commands|\bphase\b|\brounds?\b/i, name);
  }
  for (const [name, heading] of Object.entries(VISIT_BRIEFS))
    assert.match(exampleLayer.fixtureText(name), new RegExp(`^${heading} VISIT for GitHub issue #`), name);
});

test('no example Brief asks for a field nothing reads', () => {
  for (const name of exampleLayer.TEMPLATE_NAMES)
    assert.doesNotMatch(exampleLayer.fixtureText(name), /your persona asks for one|start "diagnosis" with/, name);
});

test('the tests-fail recovery tells a red agent that needs no test to claim blocked with that reason', async () => {
  const brief = await shipped('tests-fail-recovery.md', { ...base, id: 'red-check', failure: 'unchanged' });
  assert.match(brief, /claim blocked with reason no-test-needed/);
});

test('a History entry is numbered by attemptNumber', async () => {
  const history = [
    { kind: 'red-failed', text: 'one' },
    { kind: 'rescued', text: 'two' },
  ];
  const numbered = await briefs.brief('{{#history}}{{attemptNumber}} {{kind}}\n{{/history}}', {
    history,
  });
  assert.equal(numbered, '1 red-failed\n2 rescued\n');
  for (const name of exampleLayer.TEMPLATE_NAMES)
    assert.doesNotMatch(exampleLayer.fixtureText(name), /\{\{n\}\}/, name);
});

// A rescued Visit's work, as `<vertex>.rescue` gives it (W3).
const rescued = { ref: 'refs/gg/rescue/15.abc/green/1', diffStat: ' lib/add.mjs | 1 +', output: 'not ok 1 - adds' };

for (const name of ['green.md', 'fix.md']) {
  test(`the ${name} Brief tells the agent to read rescued work with git diff HEAD <ref>`, async () => {
    const brief = await shipped(name, { ...base, inputs: { ...greenInputs, previous: rescued } });
    assert.ok(brief.includes(`git diff HEAD ${rescued.ref}`), brief);
    assert.ok(brief.includes(rescued.diffStat), brief);
  });
}

test("the red Brief shows green's diagnosis when green found the test wrong", async () => {
  const previous = { claim: 'blocked', reason: 'bad-test', diagnosis: 'The test expects a - b.' };
  const brief = await shipped('red.md', { ...base, inputs: { previous } });
  assert.ok(brief.includes('The test expects a - b.'), brief);
  assert.ok(brief.includes('bad-test'), brief);
});

// red's latest report, which says no test failed (N6, N10).
const noTest = {
  claim: 'blocked',
  reason: 'no-test-needed',
  summary: 'No test is needed.',
  tests: [],
  notes: 'The change only renames a constant.',
  diagnosis: 'Nothing observable changes.',
};

test("the green Brief shows red's no-test notes", async () => {
  const brief = await shipped('green.md', { ...base, inputs: { redReport: noTest } });
  assert.ok(brief.includes(noTest.notes), brief);
  assert.ok(brief.includes('no-test-needed'), brief);
});

test('the review Brief judges a no-test claim, flags a nondeterministic test and reads the History', async () => {
  const brief = await shipped('review.md', {
    ...base,
    history: [{ kind: 'rescued', text: 'green stopped with bad-test.' }],
    inputs: { report: { claim: 'ok' }, red: redEvidence, green: redEvidence, redReport: noTest },
    diff: '',
    changedTestFiles: [],
  });
  assert.ok(brief.includes(noTest.notes), brief);
  assert.match(brief, /needsTest: true/);
  assert.match(brief, /sleep, wall-clock time, randomness, network, test order or shared state/);
  assert.ok(brief.includes('green stopped with bad-test.'), brief);
});
