import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as briefs from '../../lib/briefs.ts';
import * as checks from '../../lib/checks.ts';
import type * as referencePaths from '../../lib/reference-paths.ts';
import * as render from '../../lib/render.ts';
import * as exampleLayer from '../support/example-layer.ts';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

const ticket = {
  number: 7,
  title: 'Add widgets',
  body: '## Definition of done\n- [ ] widgets',
  branch: 'ticket/7-add-widgets',
};
const commands = { test: 'npm test', lint: 'npm run lint' };
const worktree = 'C:\\dev\\worktrees\\repo\\ticket-7';
const base = { ticket, baseBranch: 'origin/main', commands, worktree, history: [] };
const redOutput = 'not ok 1 - widgets render\n  AssertionError: expected widget';
const testFiles = ['test/widgets.test.mjs', 'test/support/widget-fixture.mjs'];
const greenInputs = { testFiles, red: { command: 'npm test', output: redOutput } };
const IMMUTABLE = /committed tests must not be changed/i;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/templates/${name}`, import.meta.url), 'utf8');

// A template of the example `gg init` writes, or gg's own (the nudge is an engine template).
const text = (name: string) =>
  exampleLayer.TEMPLATE_NAMES.includes(name) ? exampleLayer.fixtureText(name) : render.engineTemplate(name);
// An example Brief by its file name, and the recovery Brief with a section per `{ brief, ...check }`.
const shipped = (name: string, context: briefs.BriefContext) => briefs.brief(text(name), context);
type RecoveryContext = briefs.BriefContext & { sections: { brief: string; [field: string]: unknown }[] };
const recovery = (name: string, context: RecoveryContext) =>
  briefs.recoveryBrief(text(name), {
    ...context,
    sections: context.sections.map(({ brief, ...check }) => ({
      text: text(brief),
      ...check,
    })),
  });
// An example schema declares its properties and which are required.
type ShippedSchema = referencePaths.SchemaNode & Required<Pick<referencePaths.SchemaNode, 'properties' | 'required'>>;
const schema = (name: string) => JSON.parse(exampleLayer.fixtureText(`${name}.schema.json`)) as ShippedSchema;
const SCHEMAS: Record<string, ShippedSchema> = {
  RED_SCHEMA: schema('red'),
  IMPLEMENT_SCHEMA: schema('implement'),
  REVIEW_SCHEMA: schema('review'),
};

// The fixtures are the builders' output before #105, with its named changes: FIX VISIT, and diagnosis for a blocked
// Claim. Each names its template and the context it renders with.
interface BriefFixture {
  template: string;
  // eslint-disable-next-line id-denylist -- the key briefs.json names the context by
  opts: briefs.BriefContext;
}
const BRIEF_FIXTURES = JSON.parse(fixture('briefs.json')) as Record<string, BriefFixture>;
for (const [name, briefFixture] of Object.entries(BRIEF_FIXTURES)) {
  test(`each Brief template matches its builder's output: ${name}`, async () => {
    assert.equal(await shipped(briefFixture.template, briefFixture.opts), fixture(`${name}.txt`));
  });
}

// The stop comment shows diagnosis, not notes (W6), so a Brief that offers a blocked Claim says where its reason goes.
for (const name of ['green.md', 'command-recovery.md', 'recover.md']) {
  test(`the ${name} Brief tells a blocked agent to explain in diagnosis`, async () => {
    assert.match(
      await shipped(name, { ...base, inputs: greenInputs, output: 'not ok 1' }),
      /claim blocked and say why in "diagnosis"/,
    );
  });
}

test('a Brief that does not name the diff never computes it', async () => {
  const diff = () => {
    throw new Error('the diff was computed');
  };
  assert.match(await shipped('red.md', { ...base, diff, changedTestFiles: diff }), /^RED VISIT/);
});

// One limit covers every output a Brief quotes, whatever its template or reference (owner, 2026-11-06).
test('every quoted output keeps its last 6000 characters', async () => {
  const old = 'old diagnostic '.repeat(100) + '\n';
  const output = old + 'x'.repeat(5980) + '\nlast line';
  const quoted = [
    await shipped('green.md', { ...base, inputs: { testFiles, red: { command: 'npm test', output } } }),
    await shipped('command-recovery.md', { ...base, output }),
    await shipped('tests-fail-recovery.md', { ...base, output, failure: 'passed' }),
  ];
  for (const brief of quoted) {
    assert.ok(brief.includes('```\n' + 'x'.repeat(5980) + '\nlast line\n```'), brief);
    assert.doesNotMatch(brief, /old diagnostic/);
  }
});

// The limit cuts a command's text; a response field that happens to be named output keeps its structure.
test('a structured field named output prints as JSON, uncut', async () => {
  const output = { answer: 'details', steps: ['x'.repeat(7000)] };
  const rendered = await briefs.brief('{{inputs.report.output}}', { inputs: { report: { output } } });
  assert.equal(rendered, JSON.stringify(output, null, 2));
});

test('an absent optional input renders empty through a direct reference', async () => {
  const green = await shipped('green.md', { ...base, inputs: { testFiles: undefined, red: undefined } });
  const fix = await shipped('fix.md', { ...base, inputs: { findings: undefined } });
  const review = await shipped('review.md', {
    ...base,
    inputs: { report: { claim: 'ok' }, red: storedRed, green: undefined },
    diff: '',
    changedTestFiles: [],
  });
  assert.match(green, /## Committed tests\nNo failing test was committed\.\n/);
  assert.doesNotMatch(fix, /## Review findings/);
  assert.match(review, /## Green Evidence\nThe test command has no passing run\.\n/);
});

for (const name of ['command-recovery.md', 'tests-fail-recovery.md']) {
  test(`agent-facing ${name} preserves distinguishable path-case failures`, async () => {
    const output = `expected '${homedir().toLowerCase()}\\a' to equal '${homedir().toUpperCase()}\\a'`;
    const brief = await shipped(name, { ...base, output, failure: 'passed' });
    assert.ok(brief.includes(output), brief);
    assert.ok(!brief.includes('[local]'), brief);
  });
}

const evidencePath = `${homedir().replaceAll('\\', '/')}/repo/test/widgets.test.mjs`;
const storedRed = checks.checkEvidence('npm test', {
  output: `not ok 1 - widgets render\n    at (${evidencePath}:3:4)\n`,
});

test('stored Check evidence reaches the green Brief unredacted', async () => {
  const green = await shipped('green.md', { ...base, inputs: { testFiles: testFiles, red: storedRed } });
  assert.ok(green.includes(`${evidencePath}:3:4`), green);
  assert.ok(!green.includes('[local]'), green);
});

test('stored Check evidence reaches the review Brief unredacted', async () => {
  const review = await shipped('review.md', {
    ...base,
    inputs: { report: { claim: 'ok' }, red: storedRed, green: storedRed },
    diff: '',
    changedTestFiles: [],
  });
  assert.ok(review.includes(`${evidencePath}:3:4`), review);
  assert.ok(!review.includes('[local]'), review);
});

const validRed = { claim: 'ok', reason: 'none', summary: 's', tests: ['widgets render'], notes: '', diagnosis: '' };
for (const name of ['RED_SCHEMA', 'IMPLEMENT_SCHEMA', 'REVIEW_SCHEMA']) {
  test(`${name} is strict`, () => {
    assert.equal(typeof SCHEMAS[name], 'object');
    assert.doesNotThrow(() => briefs.assertStrict(SCHEMAS[name]));
  });
}

test('assertStrict rejects a property missing from required', () => {
  assert.throws(
    () =>
      briefs.assertStrict({
        type: 'object',
        // eslint-disable-next-line id-length -- the property the expected error may name
        properties: { a: { type: 'string' } },
        required: [],
        additionalProperties: false,
      }),
    /required|a/,
  );
});

test('assertStrict rejects a nested object without additionalProperties', () => {
  const nested = {
    type: 'object',
    properties: {
      // eslint-disable-next-line id-length -- a property name the schema declares
      list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
    },
    required: ['list'],
    additionalProperties: false,
  };
  assert.throws(() => briefs.assertStrict(nested), /additionalProperties/);
});

const example = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/example/${name}.schema.json`, import.meta.url), 'utf8'),
  ) as referencePaths.SchemaNode;

for (const name of ['red', 'implement', 'review']) {
  test(`the example's ${name}.schema.json is inside the strict subset`, () => {
    assert.doesNotThrow(() => briefs.assertStrict(example(name), `${name}.schema.json`));
  });
}

const withCount = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
  additionalProperties: false,
};

test('an integer property is inside the strict subset', () => {
  assert.doesNotThrow(() => briefs.assertStrict(withCount));
});

test('validateResponse accepts an integer where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: 3 }), { valid: true, token: null, reason: null });
});

test('validateResponse rejects a fraction where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: 1.5 }), {
    valid: false,
    token: null,
    reason: 'count must be an integer',
  });
});

test('validateResponse rejects a numeric string where an integer is declared', () => {
  assert.deepEqual(briefs.validateResponse(withCount, { count: '3' }), {
    valid: false,
    token: null,
    reason: 'count must be an integer',
  });
});

test('validateResponse rejects an extra property where the object declares no properties', () => {
  const empty = { type: 'object', required: [], additionalProperties: false };
  assert.deepEqual(briefs.validateResponse(empty, { extra: 1 }), {
    valid: false,
    token: null,
    reason: 'extra is not in the schema',
  });
});

test('a schema keyword outside the strict subset is rejected with its path (in an example schema)', () => {
  const bad = example('implement');
  exampleLayer.putAt(
    bad,
    ['properties', 'qa', 'properties', 'steps', 'items', 'properties', 'action', 'pattern'],
    '^x',
  );
  assert.throws(() => briefs.assertStrict(bad, 'bad.schema.json'), {
    message: 'bad.schema.json.qa.steps[].action: keyword "pattern" is outside the strict subset',
  });
});

// assertStrict types what it passes as a SchemaNode, whose required is a list of property names, for any input (#354).
test('a required entry that names no property is rejected, an undefined one too', () => {
  for (const entry of [undefined, null, 1])
    assert.throws(
      () => briefs.assertStrict({ type: 'object', properties: {}, required: [entry], additionalProperties: false }),
      { message: `(root): required names ${JSON.stringify(entry)}, which is not a property` },
      String(entry),
    );
});

// The enum assertStrict checks is the enum a reader of the SchemaNode gets, an inherited one too (#354).
test('an inherited enum is checked like an own one', () => {
  const inherited: unknown = Object.assign(Object.create({ enum: [1] }), { type: 'string' });
  assert.throws(() => briefs.assertStrict(inherited), { message: '(root): enum must be a non-empty list of strings' });
});

const inField = (field: unknown) => ({
  type: 'object',
  properties: { field },
  required: ['field'],
  additionalProperties: false,
});

for (const [what, field, message] of [
  [
    'minItems',
    { type: 'array', items: { type: 'string' }, minItems: 1 },
    'x.schema.json.field: keyword "minItems" is outside the strict subset',
  ],
  ['type number', { type: 'number' }, 'x.schema.json.field: type "number" is outside the strict subset'],
  ['oneOf', { oneOf: [{ type: 'string' }] }, 'x.schema.json.field: keyword "oneOf" is outside the strict subset'],
  ['format', { type: 'string', format: 'date' }, 'x.schema.json.field: keyword "format" is outside the strict subset'],
  ['an array without items', { type: 'array' }, 'x.schema.json.field: array lacks items'],
  [
    'a keyword with an empty name',
    { type: 'string', '': 1 },
    'x.schema.json.field: keyword "" is outside the strict subset',
  ],
]) {
  test(`a schema keyword outside the strict subset is rejected with its path (${what})`, () => {
    assert.throws(() => briefs.assertStrict(inField(field), 'x.schema.json'), { message });
  });
}

// Nested under an array of objects, so the path shows every step (PR #138 review).
const inList = (field: unknown) => ({
  type: 'object',
  properties: { list: { type: 'array', items: inField(field) } },
  required: ['list'],
  additionalProperties: false,
});

for (const [what, field, message] of [
  ['type as a list', { type: ['string'] }, 'x.schema.json.list[].field: type ["string"] is outside the strict subset'],
  [
    'type naming an Object.prototype key',
    { type: 'constructor' },
    'x.schema.json.list[].field: type "constructor" is outside the strict subset',
  ],
  ['enum null', { type: 'string', enum: null }, 'x.schema.json.list[].field: enum must be a non-empty list of strings'],
  [
    'enum false',
    { type: 'string', enum: false },
    'x.schema.json.list[].field: enum must be a non-empty list of strings',
  ],
  [
    'an empty enum',
    { type: 'string', enum: [] },
    'x.schema.json.list[].field: enum must be a non-empty list of strings',
  ],
  [
    'an enum with a number',
    { type: 'string', enum: ['ok', 1] },
    'x.schema.json.list[].field: enum must be a non-empty list of strings',
  ],
  ['a repeated enum value', { type: 'string', enum: ['ok', 'ok'] }, 'x.schema.json.list[].field: enum repeats "ok"'],
  [
    'a repeated required entry',
    // eslint-disable-next-line id-length -- the property the expected error names
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'], additionalProperties: false },
    'x.schema.json.list[].field: required repeats "a"',
  ],
  [
    'required as a string',
    // eslint-disable-next-line id-length -- the property the expected error names
    { type: 'object', properties: { a: { type: 'string' } }, required: 'a', additionalProperties: false },
    'x.schema.json.list[].field: required must be a list',
  ],
  [
    'required naming no property',
    { type: 'object', properties: {}, required: ['ghost'], additionalProperties: false },
    'x.schema.json.list[].field: required names "ghost", which is not a property',
  ],
  [
    'an empty-named property missing from required',
    { type: 'object', properties: { '': { type: 'string' } }, required: [], additionalProperties: false },
    'x.schema.json.list[].field: required lacks property ""',
  ],
  [
    'an empty property name',
    { type: 'object', properties: { '': { type: 'string' } }, required: [''], additionalProperties: false },
    'x.schema.json.list[].field: property name "" cannot be reached by a dotted path',
  ],
  [
    'a property name with a dot',
    { type: 'object', properties: { 'a.b': { type: 'string' } }, required: ['a.b'], additionalProperties: false },
    'x.schema.json.list[].field: property name "a.b" cannot be reached by a dotted path',
  ],
  [
    'properties as a number',
    { type: 'object', properties: 5, required: [], additionalProperties: false },
    'x.schema.json.list[].field: properties must be an object',
  ],
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
  assert.throws(() => briefs.assertClaimEnum(example('red'), []), {
    message: 'claim: enum "ok" | "blocked" does not equal the declared tokens (none)',
  });
});

test('the claim enum must equal the declared tokens: an empty enum value is shown quoted', () => {
  const emptyValue = example('red');
  exampleLayer.putAt(emptyValue, ['properties', 'claim', 'enum'], ['ok', '']);
  assert.throws(() => briefs.assertClaimEnum(emptyValue, ['ok']), {
    message: 'claim: enum "ok" | "" does not equal the declared tokens "ok"',
  });
});

test('the claim enum must equal the declared tokens: case twins in the enum are rejected', () => {
  const caseTwins = example('red');
  exampleLayer.putAt(caseTwins, ['properties', 'claim', 'enum'], ['ok', 'Ok', 'blocked']);
  assert.throws(() => briefs.assertClaimEnum(caseTwins, ['ok', 'Ok', 'blocked']), {
    message: 'claim: "ok" | "Ok" | "blocked" repeats a value or differs only in case',
  });
});

test('the claim enum must equal the declared tokens: a schema with no claim is rejected', () => {
  const noClaim = example('red');
  exampleLayer.putAt(noClaim, ['properties', 'claim']);
  noClaim.required = ['summary', 'tests', 'notes', 'diagnosis', 'reason'];
  assert.throws(() => briefs.assertClaimEnum(noClaim, ['ok', 'blocked']), {
    message: 'claim: the schema has no claim enum',
  });
});

// The validator collects every error, so these inputs can arrive from a schema or Flow that already failed (#106).
const selfList: unknown[] = ['ok'];
selfList.push(selfList);
const numericClaim = {
  type: 'object',
  properties: { claim: { type: 'string', enum: [1] } },
  required: ['claim'],
  additionalProperties: false,
};

for (const [what, schema, tokens, message] of [
  ['a null schema', null, ['ok'], 'claim: the schema has no claim enum'],
  ['a claim enum of numbers', numericClaim, ['ok'], 'claim: enum must be a non-empty list of strings'],
  [
    'a token that is not a string',
    example('red'),
    ['ok', true],
    'claim: the declared tokens must be a list of strings',
  ],
  ['a token list given as a string', example('red'), 'ok', 'claim: the declared tokens must be a list of strings'],
  [
    'a token list that contains itself',
    example('red'),
    selfList,
    'claim: the declared tokens must be a list of strings',
  ],
]) {
  test(`the claim enum must equal the declared tokens: ${what} is an error, not a TypeError`, () => {
    assert.throws(() => briefs.assertClaimEnum(schema as referencePaths.SchemaNode, tokens), {
      name: 'Error',
      message,
    });
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
  ['implement', 'definitionOfDone.met', { kind: 'list', of: { kind: 'boolean' } }],
] as [string, string, unknown][]) {
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
  [
    'a null schema',
    null,
    'claim',
    '"claim": the schema is outside the strict subset ((root): schema must be an object)',
  ],
  [
    'an array without items',
    inField({ type: 'array' }),
    'field',
    '"field": the schema is outside the strict subset ((root).field: array lacks items)',
  ],
  ['a number path', withCount, 3, 'the field path must be a string, not number'],
  ['a null path', withCount, null, 'the field path must be a string, not null'],
  [
    'an object path whose toString is null',
    withCount,
    { toString: null },
    'the field path must be a string, not object',
  ],
]) {
  test(`fieldType returns an error, not a TypeError, for ${what}`, () => {
    assert.deepEqual(briefs.fieldType(schema as referencePaths.SchemaNode, path), { error });
  });
}

test('validateResponse accepts exactly one lowercase enum token as the claim', () => {
  assert.deepEqual(briefs.validateResponse(SCHEMAS.RED_SCHEMA, validRed), { valid: true, token: 'ok', reason: null });
  assert.deepEqual(briefs.validateResponse(SCHEMAS.RED_SCHEMA, { ...validRed, claim: 'blocked' }), {
    valid: true,
    token: 'blocked',
    reason: null,
  });
  assert.deepEqual(SCHEMAS.RED_SCHEMA.properties.claim.enum, ['ok', 'blocked']);
  assert.deepEqual(SCHEMAS.IMPLEMENT_SCHEMA.properties.claim.enum, ['ok', 'blocked']);
  // Deliberate change: ff's verdict PASS | CHANGES becomes the lowercase claim ok | changes | blocked (R9).
  assert.deepEqual(SCHEMAS.REVIEW_SCHEMA.properties.claim.enum, ['ok', 'changes', 'blocked']);
});

for (const name of ['RED_SCHEMA', 'IMPLEMENT_SCHEMA', 'REVIEW_SCHEMA']) {
  test(`${name} asks for a claim, with no status or verdict`, () => {
    assert.equal(SCHEMAS[name].properties.status, undefined);
    assert.equal(SCHEMAS[name].properties.verdict, undefined);
  });
}

const noClaim: Partial<typeof validRed> = { ...validRed };
delete noClaim.claim;
for (const [what, response] of [
  ['a missing', noClaim],
  ['an uppercase', { ...validRed, claim: 'OK' }],
  ['an array', { ...validRed, claim: ['ok'] }],
  ['an unknown', { ...validRed, claim: 'done' }],
]) {
  test(`validateResponse rejects ${what} claim, naming the claim`, () => {
    const validation = briefs.validateResponse(SCHEMAS.RED_SCHEMA, response);
    assert.equal(validation.valid, false);
    assert.match(validation.reason ?? '', /claim/);
  });
}

test('validateResponse rejects a null response', () => {
  assert.deepEqual(briefs.validateResponse(SCHEMAS.RED_SCHEMA, null), {
    valid: false,
    token: null,
    reason: 'no structured response',
  });
});

test('validateResponse rejects a property of the wrong type, naming it', () => {
  const wrongType = briefs.validateResponse(SCHEMAS.RED_SCHEMA, { ...validRed, tests: 'widgets render' });
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.reason ?? '', /tests/);
});

test('validateResponse rejects a missing required property, naming it', () => {
  const { notes: _notes, ...noNotes } = validRed;
  assert.match(briefs.validateResponse(SCHEMAS.RED_SCHEMA, noNotes).reason ?? '', /notes/);
});

test('validateResponse and assertStrict catch an empty-named property', () => {
  const root = briefs.validateResponse(SCHEMAS.RED_SCHEMA, { ...validRed, '': 'x' });
  assert.equal(root.valid, false);
  assert.match(root.reason ?? '', /not in the schema/);
  const step = { action: 'a', expected: 'b', '': 'x' };
  const impl = {
    claim: 'ok',
    reason: 'none',
    summary: 's',
    definitionOfDone: [],
    qa: { setup: '', steps: [step], edgeCases: [], automated: [], manual: [] },
    diagnosis: '',
    notes: '',
  };
  const nested = briefs.validateResponse(SCHEMAS.IMPLEMENT_SCHEMA, impl);
  assert.equal(nested.valid, false);
  assert.match(nested.reason ?? '', /qa\.steps\[0\]\. is not in the schema/);
  assert.throws(
    () =>
      briefs.assertStrict({
        type: 'object',
        properties: { '': { type: 'string' } },
        required: [],
        additionalProperties: false,
      }),
    /required lacks property/,
  );
});

test('the green brief is a full brief for a fresh session', async () => {
  const green = await shipped('green.md', { ...base, inputs: greenInputs });
  assert.match(green, /#7/);
  assert.ok(green.includes(ticket.body), 'ticket body');
  assert.ok(green.includes(ticket.branch), 'branch');
  assert.ok(green.includes('test/widgets.test.mjs'), 'test file test/widgets.test.mjs');
  assert.ok(green.includes('test/support/widget-fixture.mjs'), 'test file test/support/widget-fixture.mjs');
  assert.ok(green.includes(redOutput), 'failing red output');
  assert.ok(green.includes('npm test'), 'command npm test');
  assert.ok(green.includes('npm run lint'), 'command npm run lint');
  assert.match(green, /Do not run git add/);
  assert.ok(!green.includes(worktree), 'no worktree path');
  assert.doesNotMatch(green, /fix it/i);
});

test('the green brief forbids changing committed tests', async () => {
  const green = await shipped('green.md', { ...base, inputs: greenInputs });
  assert.match(green, IMMUTABLE);
  assert.match(green, /notes/);
  assert.match(green, /blocked/);
});

// #115: the recovery Brief is the Procedure's frame with one section per failing Check (T4b).
test('the recovery Brief carries every failing Check its own section, in order', async () => {
  const recoveryBrief = await recovery('recover.md', {
    ...base,
    sections: [
      {
        brief: 'command-recovery.md',
        id: 'test',
        kind: 'command',
        command: 'npm test',
        output: 'not ok 3 - widgets render',
      },
      {
        brief: 'command-recovery.md',
        id: 'lint',
        kind: 'command',
        command: 'npm run lint',
        output: 'lib/widgets.mjs: 1 problem',
      },
    ],
  });
  const first = recoveryBrief.indexOf('## The command Check test');
  const second = recoveryBrief.indexOf('## The command Check lint');
  assert.ok(first > 0 && second > first, recoveryBrief);
  assert.ok(
    recoveryBrief.includes('not ok 3 - widgets render') && recoveryBrief.includes('lib/widgets.mjs: 1 problem'),
    recoveryBrief,
  );
  assert.equal(recoveryBrief.match(/## Declared Commands/g)?.length, 1, 'the frame lists the commands once');
});

// green and fix Visits share it, and a fix may change the test files its findings name (tests: named).
test('the command-recovery Brief forbids changing a test the Visit may not change', async () => {
  const commandRecovery = await shipped('command-recovery.md', { ...base, output: 'not ok 3 - widgets render' });
  assert.doesNotMatch(commandRecovery, IMMUTABLE);
  assert.match(commandRecovery, /Do not change a test your Visit may not change/);
  assert.match(commandRecovery, /if such a test is wrong, claim blocked with reason\s+bad-test/);
  assert.match(commandRecovery, /notes/);
  assert.match(commandRecovery, /blocked/);
  assert.doesNotMatch(commandRecovery, /fix it/i);
  assert.ok(commandRecovery.includes('not ok 3 - widgets render'), commandRecovery);
});

for (const name of ['RED_SCHEMA', 'REVIEW_SCHEMA', 'IMPLEMENT_SCHEMA']) {
  test(`${name} carries a diagnosis`, () => {
    assert.deepEqual(SCHEMAS[name].properties.diagnosis, { type: 'string' });
    assert.ok(SCHEMAS[name].required.includes('diagnosis'), JSON.stringify(SCHEMAS[name].required));
  });
}

const BUILDS: [string, () => Promise<string>][] = [
  ['red', () => shipped('red.md', base)],
  ['green', () => shipped('green.md', { ...base, inputs: greenInputs })],
  ['fix', () => shipped('fix.md', base)],
  [
    'review',
    () =>
      shipped('review.md', {
        ...base,
        inputs: { report: { claim: 'ok' }, red: storedRed },
        diff: 'diff --git a/x b/x',
        changedTestFiles: [],
      }),
  ],
  [
    'recover',
    () =>
      recovery('recover.md', {
        ...base,
        sections: [
          {
            brief: 'command-recovery.md',
            id: 'test',
            kind: 'command',
            command: 'npm test',
            output: 'not ok 3 - widgets render',
          },
          {
            brief: 'tests-fail-recovery.md',
            id: 'red-check',
            kind: 'tests-fail',
            command: 'npm test',
            output: 'ok 1 - widgets render',
            failure: 'passed',
          },
        ],
      }),
  ],
];
for (const [name, build] of BUILDS) {
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
  assert.doesNotMatch(await shipped('red.md', { ...base, commands: {} }), /AGENTS\.md/);
});

test('the review brief lists test files changed since the red commit', async () => {
  const diff = 'diff --git a/lib/widgets.mjs b/lib/widgets.mjs\n+export const widget = 1;';
  const reviewBrief = await shipped('review.md', {
    ...base,
    inputs: { report: { claim: 'ok' }, red: storedRed },
    diff,
    changedTestFiles: ['test/widgets.test.mjs'],
  });
  assert.ok(reviewBrief.includes(diff), 'diff text');
  assert.ok(reviewBrief.includes('test/widgets.test.mjs'), 'changed test file');
  assert.match(reviewBrief, /red commit/i);
  const none = await shipped('review.md', {
    ...base,
    inputs: { report: { claim: 'ok' }, red: storedRed },
    diff,
    changedTestFiles: [],
  });
  assert.ok(none.includes(diff), none);
});

// Carried from #183: a limit is keyed on the name the Brief's own context holds, never on a section item's field.
test("an excerpt limit applies only to a name the Brief's own context holds", async () => {
  const own = 'x'.repeat(6100);
  const item = 'y'.repeat(6100);
  const rendered = await briefs.brief('{{output}}|{{#items}}{{output}}{{/items}}', {
    output: own,
    items: [{ output: item }],
  });
  assert.equal(rendered, `${'x'.repeat(6000)}|${item}`);
});

// An untyped value, such as a History entry's list, prints as JSON, never as [object Object] (#198).
test('an untyped list of objects renders as JSON', async () => {
  const items = [{ file: 'a.mjs', line: 3 }];
  const rendered = await briefs.brief('{{items}}', { items });
  assert.equal(rendered, JSON.stringify(items, null, 2));
});
