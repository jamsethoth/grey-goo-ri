import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('a reference path parses into its segments', async () => {
  const refs = await import('../../lib/refs.mjs');
  assert.deepEqual(refs.parse('reviewer.review.response.findings'), { steps: ['reviewer', 'review', 'response', 'findings'] });
});

for (const [path, error] of [
  ['', 'the field path is empty'],
  ['a..b', '"a..b" has an empty segment'],
  [3, 'the field path must be a string, not number'],
  [null, 'the field path must be a string, not null'],
]) {
  test(`a malformed reference path is one error (${JSON.stringify(path)})`, async () => {
    const refs = await import('../../lib/refs.mjs');
    assert.deepEqual(refs.parse(path), { error });
  });
}

test('read gives the value at a path, or undefined through a missing or non-object step', async () => {
  const refs = await import('../../lib/refs.mjs');
  assert.equal(refs.read({ response: { reason: 'none' } }, 'response.reason'), 'none');
  assert.equal(refs.read({ response: 'x' }, 'response.reason'), undefined);
  assert.equal(refs.read({}, 'toString'), undefined);
});

test('write sets own properties only, so __proto__ stays data', async () => {
  const refs = await import('../../lib/refs.mjs');
  const o = {};
  refs.write(o, '__proto__.polluted', true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(o), ['__proto__']);
});

test('resolve types a path through a scope, keeping gg\'s integer bounds', async () => {
  const refs = await import('../../lib/refs.mjs');
  const scope = { type: 'object', properties: { pass: { type: 'integer', min: 1, max: 2 } } };
  assert.deepEqual(refs.resolve(scope, 'pass'), { type: { kind: 'integer', min: 1, max: 2 }, node: scope.properties.pass });
  assert.deepEqual(refs.resolve(scope, 'pass.x'), { error: '"pass.x" is not defined' });
});

test('resolve in read mode types a path as read reads it: a list by length or index, never its items\' fields', async () => {
  const refs = await import('../../lib/refs.mjs');
  const item = { type: 'object', properties: { file: { type: 'string' } } };
  const scope = { type: 'object', properties: { findings: { type: 'array', items: item } } };
  assert.deepEqual(refs.resolve(scope, 'findings.file').type, { kind: 'list', of: { kind: 'string' } }, 'typing projects');
  assert.deepEqual(refs.resolve(scope, 'findings.file', 'defined', { read: true }),
    { error: '"findings.file": "findings" is a list, so a path reads only its length or an item by index', list: 'findings' });
  assert.deepEqual(refs.resolve(scope, 'findings.length', 'defined', { read: true }).type, { kind: 'integer' });
  assert.deepEqual(refs.resolve(scope, 'findings.0.file', 'defined', { read: true }).type, { kind: 'string' });
});

test('only the resolver splits reference paths in lib', () => {
  const lib = new URL('../../lib/', import.meta.url);
  const splitting = readdirSync(lib).filter((f) => f.endsWith('.mjs') && f !== 'refs.mjs')
    .filter((f) => /\.split\(\s*['"]\.['"]\s*\)/.test(readFileSync(new URL(f, lib), 'utf8')));
  assert.deepEqual(splitting, []);
});
