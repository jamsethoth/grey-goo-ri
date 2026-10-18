import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as briefs from '../lib/briefs.mjs';
import * as checks from '../lib/checks.mjs';
import { homedir } from 'node:os';

const ticket = { number: 7, title: 'Add widgets', body: '## Definition of done\n- [ ] widgets', branch: 'ticket/7-add-widgets' };
const commands = { test: 'npm test', lint: 'npm run lint' };
const worktree = 'C:\\dev\\worktrees\\repo\\ticket-7';
const base = { ticket, base: 'origin/main', commands, worktree, history: [] };
const redOutput = 'not ok 1 - widgets render\n  AssertionError: expected widget';
const testFiles = ['test/widgets.test.mjs', 'test/support/widget-fixture.mjs'];
const IMMUTABLE = /committed tests must not be changed/i;

test('Brief output excerpts keep complete-line tails', () => {
  for (const [name, limit] of [['greenBrief', 4000], ['testFixBrief', 6000], ['stillGreenBrief', 3000]]) {
    const tail = 'x'.repeat(limit - 20) + '\nlast line';
    const output = 'old diagnostic '.repeat(100) + '\n' + tail;
    const brief = briefs[name]({ ...base, testFiles, redOutput: output, output });
    assert.ok(brief.includes('```\n' + tail + '\n```'), name);
    assert.ok(!brief.includes('old diagnostic'), name);
  }
});

test('agent-facing Briefs preserve distinguishable path-case failures', () => {
  const output = `expected '${homedir().toLowerCase()}\\a' to equal '${homedir().toUpperCase()}\\a'`;
  for (const name of ['testFixBrief', 'stillGreenBrief']) {
    const brief = briefs[name]({ ...base, output });
    assert.ok(brief.includes(output), name);
    assert.ok(!brief.includes('[local]'), name);
  }
});

test('stored Check evidence reaches the green and review Briefs unredacted', () => {
  const path = `${homedir().replaceAll('\\', '/')}/repo/test/widgets.test.mjs`;
  const red = checks.evidence('npm test', { output: `not ok 1 - widgets render\n    at (${path}:3:4)\n` });
  const green = briefs.greenBrief({ ...base, testFiles, redOutput: red.output });
  const review = briefs.reviewBrief({ ...base, impl: { claim: 'ok', red, green: red }, diff: '', changedTestFiles: [] });
  for (const [name, brief] of [['green', green], ['review', review]]) {
    assert.ok(brief.includes(`${path}:3:4`), name);
    assert.ok(!brief.includes('[local]'), name);
  }
});

const validRed = { claim: 'ok', summary: 's', tests: ['widgets render'], notes: '', diagnosis: '' };

const allBriefs = () => ({
  red: briefs.redBrief(base),
  green: briefs.greenBrief({ ...base, testFiles, redOutput }),
  fix: briefs.fixBrief(base),
  review: briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff: 'diff --git a/x b/x', changedTestFiles: [] }),
  testFix: briefs.testFixBrief({ ...base, output: 'not ok 3 - widgets render' }),
  stillGreen: briefs.stillGreenBrief({ ...base, output: 'ok 1 - widgets render' }),
});

test('styleBlock: caveman only for agent-facing prose, human fields stay natural', () => {
  assert.doesNotMatch(briefs.styleBlock({ internal: 'none' }, 'RULES'), /RULES|caveman-style/);
  assert.doesNotMatch(briefs.styleBlock({ internal: 'caveman-ultra' }, null), /caveman-style/);
  const s = briefs.styleBlock({ internal: 'caveman-ultra' }, 'RULES');
  assert.match(s, /\*\*ultra\*\*/);
  assert.match(s, /RULES/);
  assert.match(s, /never caveman/);
});

test('every schema is strict', () => {
  for (const name of ['RED_SCHEMA', 'IMPLEMENT_SCHEMA', 'REVIEW_SCHEMA']) {
    assert.equal(typeof briefs[name], 'object', name);
    assert.doesNotThrow(() => briefs.assertStrict(briefs[name]), name);
  }
  assert.throws(() => briefs.assertStrict({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false }), /required|a/);
  const nested = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }, required: ['list'], additionalProperties: false };
  assert.throws(() => briefs.assertStrict(nested), /additionalProperties/);
});

test('validateResponse accepts exactly one lowercase enum token as the claim', () => {
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, validRed), { valid: true, claim: 'ok' });
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, { ...validRed, claim: 'misscoped' }), { valid: true, claim: 'misscoped' });
  assert.deepEqual(briefs.RED_SCHEMA.properties.claim.enum, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(briefs.IMPLEMENT_SCHEMA.properties.claim.enum, ['ok', 'blocked', 'misscoped']);
  // Deliberate change: ff's verdict PASS | CHANGES becomes the lowercase claim ok | changes | misscoped.
  assert.deepEqual(briefs.REVIEW_SCHEMA.properties.claim.enum, ['ok', 'changes', 'misscoped']);
  for (const schema of [briefs.RED_SCHEMA, briefs.IMPLEMENT_SCHEMA, briefs.REVIEW_SCHEMA]) {
    assert.equal(schema.properties.status, undefined);
    assert.equal(schema.properties.verdict, undefined);
  }
});

test('validateResponse rejects a missing, uppercase, array, unknown or null claim', () => {
  const { claim, ...noClaim } = validRed;
  for (const response of [noClaim, { ...validRed, claim: 'OK' }, { ...validRed, claim: ['ok'] }, { ...validRed, claim: 'done' }]) {
    const out = briefs.validateResponse(briefs.RED_SCHEMA, response);
    assert.equal(out.valid, false, JSON.stringify(response));
    assert.match(out.reason, /claim/);
  }
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, null), { valid: false, reason: 'no structured response' });
  const wrongType = briefs.validateResponse(briefs.RED_SCHEMA, { ...validRed, tests: 'widgets render' });
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.reason, /tests/);
  const { notes, ...noNotes } = validRed;
  assert.match(briefs.validateResponse(briefs.RED_SCHEMA, noNotes).reason, /notes/);
});

test('validateResponse and assertStrict catch an empty-named property', () => {
  const root = briefs.validateResponse(briefs.RED_SCHEMA, { ...validRed, '': 'x' });
  assert.equal(root.valid, false);
  assert.match(root.reason, /not in the schema/);
  const step = { action: 'a', expected: 'b', '': 'x' };
  const impl = { claim: 'ok', summary: 's', dod: [], qa: { setup: '', steps: [step], edgeCases: [], automated: [], manual: [] }, diagnosis: '', notes: '' };
  const nested = briefs.validateResponse(briefs.IMPLEMENT_SCHEMA, impl);
  assert.equal(nested.valid, false);
  assert.match(nested.reason, /qa\.steps\[0\]\. is not in the schema/);
  assert.throws(() => briefs.assertStrict({ type: 'object', properties: { '': { type: 'string' } }, required: [], additionalProperties: false }), /required lacks property/);
});

test('the green brief is a full brief for a fresh session', () => {
  const g = briefs.greenBrief({ ...base, testFiles, redOutput });
  assert.match(g, /#7/);
  assert.ok(g.includes(ticket.body), 'ticket body');
  assert.ok(g.includes(ticket.branch), 'branch');
  for (const f of testFiles) assert.ok(g.includes(f), `test file ${f}`);
  assert.ok(g.includes(redOutput), 'failing red output');
  for (const c of Object.values(commands)) assert.ok(g.includes(c), `command ${c}`);
  assert.match(g, /Do not run git add/);
  assert.ok(!g.includes(worktree), 'no worktree path');
  assert.doesNotMatch(g, /fix it/i);
});

test('green and test-fix briefs forbid changing committed tests', () => {
  const g = briefs.greenBrief({ ...base, testFiles, redOutput });
  const t = briefs.testFixBrief({ ...base, output: 'not ok 3 - widgets render' });
  for (const text of [g, t]) {
    assert.match(text, IMMUTABLE);
    assert.match(text, /notes/);
    assert.match(text, /blocked/);
  }
  assert.doesNotMatch(t, /fix it/i);
  assert.ok(t.includes('not ok 3 - widgets render'));
});

test('red and review schemas carry a diagnosis', () => {
  for (const schema of [briefs.RED_SCHEMA, briefs.REVIEW_SCHEMA, briefs.IMPLEMENT_SCHEMA]) {
    assert.deepEqual(schema.properties.diagnosis, { type: 'string' });
    assert.ok(schema.required.includes('diagnosis'));
  }
});

test('briefs list declared commands and never the worktree path', () => {
  for (const [name, text] of Object.entries(allBriefs())) {
    for (const c of Object.values(commands)) assert.ok(text.includes(c), `${name} lists ${c}`);
    assert.ok(text.includes(ticket.branch), `${name} names the branch`);
    assert.ok(!text.includes(worktree), `${name} omits the worktree path`);
    assert.doesNotMatch(text, /AGENTS\.md/, name);
  }
  assert.doesNotMatch(briefs.redBrief({ ...base, commands: {} }), /AGENTS\.md/);
});

test('the review brief lists test files changed since the red commit', () => {
  const diff = 'diff --git a/lib/widgets.mjs b/lib/widgets.mjs\n+export const widget = 1;';
  const r = briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff, changedTestFiles: ['test/widgets.test.mjs'] });
  assert.ok(r.includes(diff), 'diff text');
  assert.ok(r.includes('test/widgets.test.mjs'), 'changed test file');
  assert.match(r, /red commit/i);
  const none = briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff, changedTestFiles: [] });
  assert.ok(none.includes(diff));
});
