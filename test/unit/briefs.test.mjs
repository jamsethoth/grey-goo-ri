import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as briefs from '../../lib/briefs.mjs';
import * as checks from '../../lib/checks.mjs';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

const ticket = { number: 7, title: 'Add widgets', body: '## Definition of done\n- [ ] widgets', branch: 'ticket/7-add-widgets' };
const commands = { test: 'npm test', lint: 'npm run lint' };
const worktree = 'C:\\dev\\worktrees\\repo\\ticket-7';
const base = { ticket, base: 'origin/main', commands, worktree, history: [] };
const redOutput = 'not ok 1 - widgets render\n  AssertionError: expected widget';
const testFiles = ['test/widgets.test.mjs', 'test/support/widget-fixture.mjs'];
const IMMUTABLE = /committed tests must not be changed/i;

for (const [name, limit] of [['greenBrief', 4000], ['testFixBrief', 6000], ['stillGreenBrief', 3000]]) {
  test(`${name} output excerpts keep complete-line tails`, () => {
    const tail = 'x'.repeat(limit - 20) + '\nlast line';
    const output = 'old diagnostic '.repeat(100) + '\n' + tail;
    const brief = briefs[name]({ ...base, testFiles, redOutput: output, output });
    assert.ok(brief.includes('```\n' + tail + '\n```'), brief);
    assert.doesNotMatch(brief, /old diagnostic/);
  });
}

for (const name of ['testFixBrief', 'stillGreenBrief']) {
  test(`agent-facing ${name} preserves distinguishable path-case failures`, () => {
    const output = `expected '${homedir().toLowerCase()}\\a' to equal '${homedir().toUpperCase()}\\a'`;
    const brief = briefs[name]({ ...base, output });
    assert.ok(brief.includes(output), brief);
    assert.ok(!brief.includes('[local]'), brief);
  });
}

const evidencePath = `${homedir().replaceAll('\\', '/')}/repo/test/widgets.test.mjs`;
const storedRed = checks.evidence('npm test', { output: `not ok 1 - widgets render\n    at (${evidencePath}:3:4)\n` });

test('stored Check evidence reaches the green Brief unredacted', () => {
  const green = briefs.greenBrief({ ...base, testFiles, redOutput: storedRed.output });
  assert.ok(green.includes(`${evidencePath}:3:4`), green);
  assert.ok(!green.includes('[local]'), green);
});

test('stored Check evidence reaches the review Brief unredacted', () => {
  const review = briefs.reviewBrief({ ...base, impl: { claim: 'ok', red: storedRed, green: storedRed }, diff: '', changedTestFiles: [] });
  assert.ok(review.includes(`${evidencePath}:3:4`), review);
  assert.ok(!review.includes('[local]'), review);
});

const validRed = { claim: 'ok', summary: 's', tests: ['widgets render'], notes: '', diagnosis: '' };

test('styleBlock: caveman only for agent-facing prose, human fields stay natural', () => {
  assert.doesNotMatch(briefs.styleBlock({ internal: 'none' }, 'RULES'), /RULES|caveman-style/);
  assert.doesNotMatch(briefs.styleBlock({ internal: 'caveman-ultra' }, null), /caveman-style/);
  const s = briefs.styleBlock({ internal: 'caveman-ultra' }, 'RULES');
  assert.match(s, /\*\*ultra\*\*/);
  assert.match(s, /RULES/);
  assert.match(s, /never caveman/);
});

for (const name of ['RED_SCHEMA', 'IMPLEMENT_SCHEMA', 'REVIEW_SCHEMA']) {
  test(`${name} is strict`, () => {
    assert.equal(typeof briefs[name], 'object');
    assert.doesNotThrow(() => briefs.assertStrict(briefs[name]));
  });
}

test('assertStrict rejects a property missing from required', () => {
  assert.throws(() => briefs.assertStrict({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false }), /required|a/);
});

test('assertStrict rejects a nested object without additionalProperties', () => {
  const nested = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }, required: ['list'], additionalProperties: false };
  assert.throws(() => briefs.assertStrict(nested), /additionalProperties/);
});

const example = (name) => JSON.parse(readFileSync(new URL(`../fixtures/example/${name}.schema.json`, import.meta.url), 'utf8'));

test('a schema keyword outside the strict subset is rejected with its path', () => {
  for (const name of ['red', 'implement', 'review']) {
    assert.doesNotThrow(() => briefs.assertStrict(example(name), `${name}.schema.json`), name);
  }
  const withCount = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
  assert.doesNotThrow(() => briefs.assertStrict(withCount));
  assert.deepEqual(briefs.validateResponse(withCount, { count: 3 }), { valid: true, claim: undefined });
  assert.match(briefs.validateResponse(withCount, { count: 1.5 }).reason, /count must be an integer/);
  assert.match(briefs.validateResponse(withCount, { count: '3' }).reason, /count must be an integer/);
  const bad = example('implement');
  bad.properties.qa.properties.steps.items.properties.action.pattern = '^x';
  assert.throws(() => briefs.assertStrict(bad, 'bad.schema.json'), (e) => /bad\.schema\.json/.test(e.message) && /qa\.steps\[\]\.action/.test(e.message) && /pattern/.test(e.message));
  const cases = [
    [{ type: 'array', items: { type: 'string' }, minItems: 1 }, /minItems/],
    [{ type: 'number' }, /number/],
    [{ oneOf: [{ type: 'string' }] }, /oneOf/],
    [{ type: 'string', format: 'date' }, /format/],
    [{ type: 'array' }, /items/],
  ];
  for (const [field, keyword] of cases) {
    const schema = { type: 'object', properties: { field }, required: ['field'], additionalProperties: false };
    assert.throws(() => briefs.assertStrict(schema, 'x.schema.json'), (e) => /x\.schema\.json/.test(e.message) && /field/.test(e.message) && keyword.test(e.message), JSON.stringify(field));
  }
});

test('a keyword with a value outside the strict subset is rejected with its path', () => {
  const cases = [
    [{ type: ['string'] }, /type/],
    [{ type: 'constructor' }, /type/],
    [{ type: 'string', enum: null }, /enum/],
    [{ type: 'string', enum: false }, /enum/],
    [{ type: 'string', enum: [] }, /enum/],
  ];
  for (const [field, keyword] of cases) {
    const schema = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { field }, required: ['field'], additionalProperties: false } } }, required: ['list'], additionalProperties: false };
    assert.throws(() => briefs.assertStrict(schema, 'x.schema.json'), (e) => /x\.schema\.json\.list\[\]\.field/.test(e.message) && keyword.test(e.message), JSON.stringify(field));
  }
});

test('the claim enum must equal the declared tokens', () => {
  assert.doesNotThrow(() => briefs.assertClaimEnum(example('review'), ['ok', 'changes', 'blocked']));
  assert.doesNotThrow(() => briefs.assertClaimEnum(example('red'), ['blocked', 'ok']));
  assert.throws(() => briefs.assertClaimEnum(example('red'), ['ok', 'blocked', 'misscoped']), /misscoped/);
  assert.throws(() => briefs.assertClaimEnum(example('review'), ['ok', 'blocked']), /changes/);
  assert.throws(() => briefs.assertClaimEnum(example('red'), ['OK', 'blocked']), /case/);
  const caseTwins = example('red');
  caseTwins.properties.claim.enum = ['ok', 'Ok', 'blocked'];
  assert.throws(() => briefs.assertClaimEnum(caseTwins, ['ok', 'Ok', 'blocked']), /case/);
  const noClaim = example('red');
  delete noClaim.properties.claim;
  noClaim.required = noClaim.required.filter((k) => k !== 'claim');
  assert.throws(() => briefs.assertClaimEnum(noClaim, ['ok', 'blocked']), /claim/);
});

test('fieldType types nested objects and arrays of objects', () => {
  const review = example('review');
  const implement = example('implement');
  assert.deepEqual(briefs.fieldType(review, 'claim'), { kind: 'enum', values: ['ok', 'changes', 'blocked'] });
  assert.deepEqual(briefs.fieldType(review, 'needsTest'), { kind: 'boolean' });
  assert.deepEqual(briefs.fieldType(review, 'summary'), { kind: 'string' });
  assert.deepEqual(briefs.fieldType(review, 'findings'), { kind: 'list', of: { kind: 'object' } });
  assert.deepEqual(briefs.fieldType(review, 'findings.severity'), { kind: 'list', of: { kind: 'enum', values: ['blocker', 'major', 'minor'] } });
  assert.deepEqual(briefs.fieldType(review, 'findings.file'), { kind: 'list', of: { kind: 'string' } });
  assert.deepEqual(briefs.fieldType(implement, 'qa'), { kind: 'object' });
  assert.deepEqual(briefs.fieldType(implement, 'qa.setup'), { kind: 'string' });
  assert.deepEqual(briefs.fieldType(implement, 'qa.steps.expected'), { kind: 'list', of: { kind: 'string' } });
  assert.deepEqual(briefs.fieldType(implement, 'qa.edgeCases'), { kind: 'list', of: { kind: 'string' } });
  assert.deepEqual(briefs.fieldType(implement, 'dod.met'), { kind: 'list', of: { kind: 'boolean' } });
  const counts = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
  assert.deepEqual(briefs.fieldType(counts, 'n'), { kind: 'integer' });
  for (const path of ['missing', 'findings.missing', 'summary.length', 'qa.steps.action.x', '']) {
    const out = briefs.fieldType(review, path);
    assert.equal(typeof out.error, 'string', path);
    assert.equal(out.kind, undefined, path);
  }
  assert.match(briefs.fieldType(review, 'findings.missing').error, /findings\.missing/);
});

test('validateResponse accepts exactly one lowercase enum token as the claim', () => {
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, validRed), { valid: true, claim: 'ok' });
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, { ...validRed, claim: 'misscoped' }), { valid: true, claim: 'misscoped' });
  assert.deepEqual(briefs.RED_SCHEMA.properties.claim.enum, ['ok', 'blocked', 'misscoped']);
  assert.deepEqual(briefs.IMPLEMENT_SCHEMA.properties.claim.enum, ['ok', 'blocked', 'misscoped']);
  // Deliberate change: ff's verdict PASS | CHANGES becomes the lowercase claim ok | changes | misscoped.
  assert.deepEqual(briefs.REVIEW_SCHEMA.properties.claim.enum, ['ok', 'changes', 'misscoped']);
});

for (const name of ['RED_SCHEMA', 'IMPLEMENT_SCHEMA', 'REVIEW_SCHEMA']) {
  test(`${name} asks for a claim, with no status or verdict`, () => {
    assert.equal(briefs[name].properties.status, undefined);
    assert.equal(briefs[name].properties.verdict, undefined);
  });
}

const { claim: _claim, ...noClaim } = validRed;
for (const [what, response] of [
  ['a missing', noClaim],
  ['an uppercase', { ...validRed, claim: 'OK' }],
  ['an array', { ...validRed, claim: ['ok'] }],
  ['an unknown', { ...validRed, claim: 'done' }],
]) {
  test(`validateResponse rejects ${what} claim, naming the claim`, () => {
    const out = briefs.validateResponse(briefs.RED_SCHEMA, response);
    assert.equal(out.valid, false);
    assert.match(out.reason, /claim/);
  });
}

test('validateResponse rejects a null response', () => {
  assert.deepEqual(briefs.validateResponse(briefs.RED_SCHEMA, null), { valid: false, reason: 'no structured response' });
});

test('validateResponse rejects a property of the wrong type, naming it', () => {
  const wrongType = briefs.validateResponse(briefs.RED_SCHEMA, { ...validRed, tests: 'widgets render' });
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.reason, /tests/);
});

test('validateResponse rejects a missing required property, naming it', () => {
  const { notes: _notes, ...noNotes } = validRed;
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
  assert.ok(g.includes('test/widgets.test.mjs'), 'test file test/widgets.test.mjs');
  assert.ok(g.includes('test/support/widget-fixture.mjs'), 'test file test/support/widget-fixture.mjs');
  assert.ok(g.includes(redOutput), 'failing red output');
  assert.ok(g.includes('npm test'), 'command npm test');
  assert.ok(g.includes('npm run lint'), 'command npm run lint');
  assert.match(g, /Do not run git add/);
  assert.ok(!g.includes(worktree), 'no worktree path');
  assert.doesNotMatch(g, /fix it/i);
});

test('the green brief forbids changing committed tests', () => {
  const g = briefs.greenBrief({ ...base, testFiles, redOutput });
  assert.match(g, IMMUTABLE);
  assert.match(g, /notes/);
  assert.match(g, /blocked/);
});

test('the test-fix brief forbids changing committed tests', () => {
  const t = briefs.testFixBrief({ ...base, output: 'not ok 3 - widgets render' });
  assert.match(t, IMMUTABLE);
  assert.match(t, /notes/);
  assert.match(t, /blocked/);
  assert.doesNotMatch(t, /fix it/i);
  assert.ok(t.includes('not ok 3 - widgets render'), t);
});

for (const name of ['RED_SCHEMA', 'REVIEW_SCHEMA', 'IMPLEMENT_SCHEMA']) {
  test(`${name} carries a diagnosis`, () => {
    assert.deepEqual(briefs[name].properties.diagnosis, { type: 'string' });
    assert.ok(briefs[name].required.includes('diagnosis'), JSON.stringify(briefs[name].required));
  });
}

for (const [name, build] of [
  ['red', () => briefs.redBrief(base)],
  ['green', () => briefs.greenBrief({ ...base, testFiles, redOutput })],
  ['fix', () => briefs.fixBrief(base)],
  ['review', () => briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff: 'diff --git a/x b/x', changedTestFiles: [] })],
  ['test-fix', () => briefs.testFixBrief({ ...base, output: 'not ok 3 - widgets render' })],
  ['still-green', () => briefs.stillGreenBrief({ ...base, output: 'ok 1 - widgets render' })],
]) {
  test(`the ${name} brief lists declared commands and never the worktree path`, () => {
    const text = build();
    assert.ok(text.includes('npm test'), 'lists npm test');
    assert.ok(text.includes('npm run lint'), 'lists npm run lint');
    assert.ok(text.includes(ticket.branch), 'names the branch');
    assert.ok(!text.includes(worktree), 'omits the worktree path');
    assert.doesNotMatch(text, /AGENTS\.md/);
  });
}

test('a red brief with no declared commands does not point at AGENTS.md', () => {
  assert.doesNotMatch(briefs.redBrief({ ...base, commands: {} }), /AGENTS\.md/);
});

test('the review brief lists test files changed since the red commit', () => {
  const diff = 'diff --git a/lib/widgets.mjs b/lib/widgets.mjs\n+export const widget = 1;';
  const r = briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff, changedTestFiles: ['test/widgets.test.mjs'] });
  assert.ok(r.includes(diff), 'diff text');
  assert.ok(r.includes('test/widgets.test.mjs'), 'changed test file');
  assert.match(r, /red commit/i);
  const none = briefs.reviewBrief({ ...base, impl: { claim: 'ok' }, diff, changedTestFiles: [] });
  assert.ok(none.includes(diff), none);
});
