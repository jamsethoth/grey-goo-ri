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
const greenInputs = { tests: testFiles, red: { command: 'npm test', output: redOutput } };
const IMMUTABLE = /committed tests must not be changed/i;
const fixture = (name) => readFileSync(new URL(`../fixtures/templates/${name}`, import.meta.url), 'utf8');

// The fixtures are the builders' output before #105, with its named changes: FIX VISIT, and diagnosis for a blocked Claim.
for (const [name, { template, opts }] of Object.entries(JSON.parse(fixture('briefs.json')))) {
  test(`each Brief template matches its builder's output: ${name}`, async () => {
    assert.equal(await briefs.brief(template, opts), fixture(`${name}.txt`));
  });
}

// The stop comment shows diagnosis, not notes (W6), so a Brief that offers a blocked Claim says where its reason goes.
for (const name of ['green.md', 'test-fix.md', 'recover.md']) {
  test(`the ${name} Brief tells a blocked agent to explain in diagnosis`, async () => {
    assert.match(await briefs.brief(name, { ...base, inputs: greenInputs, output: 'not ok 1' }), /claim blocked and say why in "diagnosis"/);
  });
}

test('a Brief that does not name the diff never computes it', async () => {
  const diff = () => { throw new Error('the diff was computed'); };
  assert.match(await briefs.brief('red.md', { ...base, diff, changedTestFiles: diff }), /^RED PHASE/);
});

test("direct input references retain each Brief's excerpt limit", async () => {
  const old = 'old diagnostic '.repeat(100) + '\n';
  const green = await briefs.brief('green.md', { ...base, inputs: { tests: testFiles, red: { command: 'npm test', output: old + 'x'.repeat(3980) + '\nlast line' } } });
  const testFix = await briefs.brief('test-fix.md', { ...base, output: old + 'x'.repeat(5980) + '\nlast line' });
  const stillGreen = await briefs.brief('still-green.md', { ...base, output: old + 'x'.repeat(2980) + '\nlast line', failure: 'passed' });
  assert.ok(green.includes('```\n' + 'x'.repeat(3980) + '\nlast line\n```'), green);
  assert.ok(testFix.includes('```\n' + 'x'.repeat(5980) + '\nlast line\n```'), testFix);
  assert.ok(stillGreen.includes('```\n' + 'x'.repeat(2980) + '\nlast line\n```'), stillGreen);
  assert.doesNotMatch(green + testFix + stillGreen, /old diagnostic/);
});

test('an absent optional input renders empty through a direct reference', async () => {
  const green = await briefs.brief('green.md', { ...base, inputs: { tests: undefined, red: undefined } });
  const fix = await briefs.brief('fix.md', { ...base, inputs: { findings: undefined } });
  const review = await briefs.brief('review.md', { ...base, inputs: { report: { claim: 'ok' }, red: storedRed, green: undefined }, diff: '', changedTestFiles: [] });
  assert.match(green, /## Committed tests\n\nThe orchestrator committed these failing tests; the test command failed as expected:\n\n```\n\n```\n/);
  assert.doesNotMatch(fix, /## Review findings/);
  assert.match(review, /## Green Evidence\nThe test command has no passing run\.\n/);
});

for (const name of ['test-fix.md', 'still-green.md']) {
  test(`agent-facing ${name} preserves distinguishable path-case failures`, async () => {
    const output = `expected '${homedir().toLowerCase()}\\a' to equal '${homedir().toUpperCase()}\\a'`;
    const brief = await briefs.brief(name, { ...base, output, failure: 'passed' });
    assert.ok(brief.includes(output), brief);
    assert.ok(!brief.includes('[local]'), brief);
  });
}

const evidencePath = `${homedir().replaceAll('\\', '/')}/repo/test/widgets.test.mjs`;
const storedRed = checks.evidence('npm test', { output: `not ok 1 - widgets render\n    at (${evidencePath}:3:4)\n` });

test('stored Check evidence reaches the green Brief unredacted', async () => {
  const green = await briefs.brief('green.md', { ...base, inputs: { tests: testFiles, red: storedRed } });
  assert.ok(green.includes(`${evidencePath}:3:4`), green);
  assert.ok(!green.includes('[local]'), green);
});

test('stored Check evidence reaches the review Brief unredacted', async () => {
  const review = await briefs.brief('review.md', { ...base, inputs: { report: { claim: 'ok' }, red: storedRed, green: storedRed }, diff: '', changedTestFiles: [] });
  assert.ok(review.includes(`${evidencePath}:3:4`), review);
  assert.ok(!review.includes('[local]'), review);
});

const validRed = { claim: 'ok', summary: 's', tests: ['widgets render'], notes: '', diagnosis: '' };
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

for (const name of ['red', 'implement', 'review']) {
  test(`the example's ${name}.schema.json is inside the strict subset`, () => {
    assert.doesNotThrow(() => briefs.assertStrict(example(name), `${name}.schema.json`));
  });
}

const withCount = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };

test('an integer property is inside the strict subset', () => {
  assert.doesNotThrow(() => briefs.assertStrict(withCount));
});

test('validateResponse accepts an integer where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: 3 }), { valid: true, claim: undefined });
});

test('validateResponse rejects a fraction where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: 1.5 }), { valid: false, reason: 'count must be an integer' });
});

test('validateResponse rejects a numeric string where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: '3' }), { valid: false, reason: 'count must be an integer' });
});

test('validateResponse rejects an extra property where the object declares no properties', () => {
  const empty = { type: 'object', required: [], additionalProperties: false };
  assert.deepEqual(briefs.validateResponse(empty, { extra: 1 }), { valid: false, reason: 'extra is not in the schema' });
});

test('a schema keyword outside the strict subset is rejected with its path (in an example schema)', () => {
  const bad = example('implement');
  bad.properties.qa.properties.steps.items.properties.action.pattern = '^x';
  assert.throws(() => briefs.assertStrict(bad, 'bad.schema.json'), { message: 'bad.schema.json.qa.steps[].action: keyword "pattern" is outside the strict subset' });
});

const inField = (field) => ({ type: 'object', properties: { field }, required: ['field'], additionalProperties: false });

for (const [what, field, message] of [
  ['minItems', { type: 'array', items: { type: 'string' }, minItems: 1 }, 'x.schema.json.field: keyword "minItems" is outside the strict subset'],
  ['type number', { type: 'number' }, 'x.schema.json.field: type "number" is outside the strict subset'],
  ['oneOf', { oneOf: [{ type: 'string' }] }, 'x.schema.json.field: keyword "oneOf" is outside the strict subset'],
  ['format', { type: 'string', format: 'date' }, 'x.schema.json.field: keyword "format" is outside the strict subset'],
  ['an array without items', { type: 'array' }, 'x.schema.json.field: array lacks items'],
  ['a keyword with an empty name', { type: 'string', '': 1 }, 'x.schema.json.field: keyword "" is outside the strict subset'],
]) {
  test(`a schema keyword outside the strict subset is rejected with its path (${what})`, () => {
    assert.throws(() => briefs.assertStrict(inField(field), 'x.schema.json'), { message });
  });
}

// Nested under an array of objects, so the path shows every step (PR #138 review).
const inList = (field) => ({ type: 'object', properties: { list: { type: 'array', items: inField(field) } }, required: ['list'], additionalProperties: false });

for (const [what, field, message] of [
  ['type as a list', { type: ['string'] }, 'x.schema.json.list[].field: type ["string"] is outside the strict subset'],
  ['type naming an Object.prototype key', { type: 'constructor' }, 'x.schema.json.list[].field: type "constructor" is outside the strict subset'],
  ['enum null', { type: 'string', enum: null }, 'x.schema.json.list[].field: enum must be a non-empty list of strings'],
  ['enum false', { type: 'string', enum: false }, 'x.schema.json.list[].field: enum must be a non-empty list of strings'],
  ['an empty enum', { type: 'string', enum: [] }, 'x.schema.json.list[].field: enum must be a non-empty list of strings'],
  ['an enum with a number', { type: 'string', enum: ['ok', 1] }, 'x.schema.json.list[].field: enum must be a non-empty list of strings'],
  ['a repeated enum value', { type: 'string', enum: ['ok', 'ok'] }, 'x.schema.json.list[].field: enum repeats "ok"'],
  ['a repeated required entry', { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'], additionalProperties: false }, 'x.schema.json.list[].field: required repeats "a"'],
  ['required as a string', { type: 'object', properties: { a: { type: 'string' } }, required: 'a', additionalProperties: false }, 'x.schema.json.list[].field: required must be a list'],
  ['required naming no property', { type: 'object', properties: {}, required: ['ghost'], additionalProperties: false }, 'x.schema.json.list[].field: required names "ghost", which is not a property'],
  ['an empty-named property missing from required', { type: 'object', properties: { '': { type: 'string' } }, required: [], additionalProperties: false }, 'x.schema.json.list[].field: required lacks property ""'],
  ['an empty property name', { type: 'object', properties: { '': { type: 'string' } }, required: [''], additionalProperties: false }, 'x.schema.json.list[].field: property name "" cannot be reached by a dotted path'],
  ['a property name with a dot', { type: 'object', properties: { 'a.b': { type: 'string' } }, required: ['a.b'], additionalProperties: false }, 'x.schema.json.list[].field: property name "a.b" cannot be reached by a dotted path'],
  ['properties as a number', { type: 'object', properties: 5, required: [], additionalProperties: false }, 'x.schema.json.list[].field: properties must be an object'],
  ['a null schema', null, 'x.schema.json.list[].field: schema must be an object'],
  ['null items', { type: 'array', items: null }, 'x.schema.json.list[].field[]: schema must be an object'],
]) {
  test(`a keyword with a value outside the strict subset is rejected with its path (${what})`, () => {
    assert.throws(() => briefs.assertStrict(inList(field), 'x.schema.json'), { message });
  });
}

test('the claim enum must equal the declared tokens', () => {
  assert.doesNotThrow(() => briefs.assertClaimEnum(example('review'), ['ok', 'changes', 'blocked']));
});

test('the claim enum must equal the declared tokens, in any order', () => {
  assert.doesNotThrow(() => briefs.assertClaimEnum(example('red'), ['blocked', 'ok']));
});

test('the claim enum must equal the declared tokens: a token missing from the enum is rejected', () => {
  assert.throws(() => briefs.assertClaimEnum(example('red'), ['ok', 'blocked', 'misscoped']), {
    message: 'claim: enum "ok" | "blocked" does not equal the declared tokens "ok" | "blocked" | "misscoped"',
  });
});

test('the claim enum must equal the declared tokens: an enum value with no token is rejected', () => {
  assert.throws(() => briefs.assertClaimEnum(example('review'), ['ok', 'blocked']), {
    message: 'claim: enum "ok" | "changes" | "blocked" does not equal the declared tokens "ok" | "blocked"',
  });
});

test('the claim enum must equal the declared tokens: a case-only difference is named', () => {
  assert.throws(() => briefs.assertClaimEnum(example('red'), ['OK', 'blocked']), {
    message: 'claim: enum "ok" | "blocked" does not equal the declared tokens "OK" | "blocked" (they differ in case)',
  });
});

test('the claim enum must equal the declared tokens: an empty token list shows (none)', () => {
  assert.throws(() => briefs.assertClaimEnum(example('red'), []), { message: 'claim: enum "ok" | "blocked" does not equal the declared tokens (none)' });
});

test('the claim enum must equal the declared tokens: an empty enum value is shown quoted', () => {
  const emptyValue = example('red');
  emptyValue.properties.claim.enum = ['ok', ''];
  assert.throws(() => briefs.assertClaimEnum(emptyValue, ['ok']), { message: 'claim: enum "ok" | "" does not equal the declared tokens "ok"' });
});

test('the claim enum must equal the declared tokens: case twins in the enum are rejected', () => {
  const caseTwins = example('red');
  caseTwins.properties.claim.enum = ['ok', 'Ok', 'blocked'];
  assert.throws(() => briefs.assertClaimEnum(caseTwins, ['ok', 'Ok', 'blocked']), { message: 'claim: "ok" | "Ok" | "blocked" repeats a value or differs only in case' });
});

test('the claim enum must equal the declared tokens: a schema with no claim is rejected', () => {
  const noClaim = example('red');
  delete noClaim.properties.claim;
  noClaim.required = ['summary', 'tests', 'notes', 'diagnosis', 'reason'];
  assert.throws(() => briefs.assertClaimEnum(noClaim, ['ok', 'blocked']), { message: 'claim: the schema has no claim enum' });
});

// The validator collects every error, so these inputs can arrive from a schema or Flow that already failed (#106).
const selfList = ['ok'];
selfList.push(selfList);
const numericClaim = { type: 'object', properties: { claim: { type: 'string', enum: [1] } }, required: ['claim'], additionalProperties: false };

for (const [what, schema, tokens, message] of [
  ['a null schema', null, ['ok'], 'claim: the schema has no claim enum'],
  ['a claim enum of numbers', numericClaim, ['ok'], 'claim: enum must be a non-empty list of strings'],
  ['a token that is not a string', example('red'), ['ok', true], 'claim: the declared tokens must be a list of strings'],
  ['a token list given as a string', example('red'), 'ok', 'claim: the declared tokens must be a list of strings'],
  ['a token list that contains itself', example('red'), selfList, 'claim: the declared tokens must be a list of strings'],
]) {
  test(`the claim enum must equal the declared tokens: ${what} is an error, not a TypeError`, () => {
    assert.throws(() => briefs.assertClaimEnum(schema, tokens), { name: 'Error', message });
  });
}

for (const [name, path, kind] of [
  ['review', 'claim', { kind: 'enum', values: ['ok', 'changes', 'blocked'] }],
  ['review', 'needsTest', { kind: 'boolean' }],
  ['review', 'summary', { kind: 'string' }],
  ['review', 'findings', { kind: 'list', of: { kind: 'object' } }],
  ['review', 'findings.severity', { kind: 'list', of: { kind: 'enum', values: ['blocker', 'major', 'minor'] } }],
  ['review', 'findings.file', { kind: 'list', of: { kind: 'string' } }],
  ['implement', 'qa', { kind: 'object' }],
  ['implement', 'qa.setup', { kind: 'string' }],
  ['implement', 'qa.steps.expected', { kind: 'list', of: { kind: 'string' } }],
  ['implement', 'qa.edgeCases', { kind: 'list', of: { kind: 'string' } }],
  ['implement', 'dod.met', { kind: 'list', of: { kind: 'boolean' } }],
]) {
  test(`fieldType types nested objects and arrays of objects (${name} ${path})`, () => {
    assert.deepEqual(briefs.fieldType(example(name), path), kind);
  });
}

test('fieldType types an integer', () => {
  assert.deepEqual(briefs.fieldType(withCount, 'count'), { kind: 'integer' });
});

for (const [name, path, error] of [
  ['review', 'missing', '"missing" is not a field of the schema'],
  ['review', 'findings.missing', '"findings.missing" is not a field of the schema'],
  ['review', 'summary.length', '"summary.length" is not a field of the schema'],
  ['implement', 'qa.steps.action.x', '"qa.steps.action.x" is not a field of the schema'],
  ['review', 'qa.steps.action.x', '"qa.steps.action.x": "qa" is not a field of the schema'],
  ['review', '', 'the field path is empty'],
  ['review', '.claim', '".claim" has an empty segment'],
  ['review', 'findings..file', '"findings..file" has an empty segment'],
  ['review', 'claim.', '"claim." has an empty segment'],
]) {
  test(`fieldType returns an error for a path outside the schema (${name} ${JSON.stringify(path)})`, () => {
    assert.deepEqual(briefs.fieldType(example(name), path), { error });
  });
}

for (const [what, schema, path, error] of [
  ['a null schema', null, 'claim', '"claim": the schema is outside the strict subset ((root): schema must be an object)'],
  ['an array without items', inField({ type: 'array' }), 'field', '"field": the schema is outside the strict subset ((root).field: array lacks items)'],
  ['a number path', withCount, 3, 'the field path must be a string, not number'],
  ['a null path', withCount, null, 'the field path must be a string, not null'],
  ['an object path whose toString is null', withCount, { toString: null }, 'the field path must be a string, not object'],
]) {
  test(`fieldType returns an error, not a TypeError, for ${what}`, () => {
    assert.deepEqual(briefs.fieldType(schema, path), { error });
  });
}

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

test('the green brief is a full brief for a fresh session', async () => {
  const g = await briefs.brief('green.md', { ...base, inputs: greenInputs });
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

test('the green brief forbids changing committed tests', async () => {
  const g = await briefs.brief('green.md', { ...base, inputs: greenInputs });
  assert.match(g, IMMUTABLE);
  assert.match(g, /notes/);
  assert.match(g, /blocked/);
});

// #115: the recovery Brief is the Procedure's frame with one section per failing Check (T4b).
test('the recovery Brief carries every failing Check its own section, in order', async () => {
  const r = await briefs.recoveryBrief('recover.md', { ...base, sections: [
    { brief: 'test-fix.md', id: 'test', kind: 'command', command: 'npm test', output: 'not ok 3 - widgets render' },
    { brief: 'test-fix.md', id: 'lint', kind: 'command', command: 'npm run lint', output: 'lib/widgets.mjs: 1 problem' },
  ] });
  const first = r.indexOf('## The command Check test');
  const second = r.indexOf('## The command Check lint');
  assert.ok(first > 0 && second > first, r);
  assert.ok(r.includes('not ok 3 - widgets render') && r.includes('lib/widgets.mjs: 1 problem'), r);
  assert.equal(r.match(/## Repo commands/g).length, 1, 'the frame lists the commands once');
});

test('the test-fix brief forbids changing committed tests', async () => {
  const t = await briefs.brief('test-fix.md', { ...base, output: 'not ok 3 - widgets render' });
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
  ['red', () => briefs.brief('red.md', base)],
  ['green', () => briefs.brief('green.md', { ...base, inputs: greenInputs })],
  ['fix', () => briefs.brief('fix.md', base)],
  ['review', () => briefs.brief('review.md', { ...base, inputs: { report: { claim: 'ok' }, red: storedRed }, diff: 'diff --git a/x b/x', changedTestFiles: [] })],
  ['recover', () => briefs.recoveryBrief('recover.md', { ...base, sections: [
    { brief: 'test-fix.md', id: 'test', kind: 'command', command: 'npm test', output: 'not ok 3 - widgets render' },
    { brief: 'still-green.md', id: 'red-check', kind: 'tests-fail', command: 'npm test', output: 'ok 1 - widgets render', failure: 'passed' },
  ] })],
]) {
  test(`the ${name} brief lists declared commands and never the worktree path`, async () => {
    const text = await build();
    assert.ok(text.includes('npm test'), 'lists npm test');
    assert.ok(text.includes('npm run lint'), 'lists npm run lint');
    assert.ok(text.includes(ticket.branch), 'names the branch');
    assert.ok(!text.includes(worktree), 'omits the worktree path');
    assert.doesNotMatch(text, /AGENTS\.md/);
  });
}

test('a red brief with no declared commands does not point at AGENTS.md', async () => {
  assert.doesNotMatch(await briefs.brief('red.md', { ...base, commands: {} }), /AGENTS\.md/);
});

test('the review brief lists test files changed since the red commit', async () => {
  const diff = 'diff --git a/lib/widgets.mjs b/lib/widgets.mjs\n+export const widget = 1;';
  const r = await briefs.brief('review.md', { ...base, inputs: { report: { claim: 'ok' }, red: storedRed }, diff, changedTestFiles: ['test/widgets.test.mjs'] });
  assert.ok(r.includes(diff), 'diff text');
  assert.ok(r.includes('test/widgets.test.mjs'), 'changed test file');
  assert.match(r, /red commit/i);
  const none = await briefs.brief('review.md', { ...base, inputs: { report: { claim: 'ok' }, red: storedRed }, diff, changedTestFiles: [] });
  assert.ok(none.includes(diff), none);
});
