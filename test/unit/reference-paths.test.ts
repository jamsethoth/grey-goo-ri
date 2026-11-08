import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as referencePaths from '../../lib/reference-paths.ts';

test('a reference path parses into its segments', () => {
  assert.deepEqual(referencePaths.parse('reviewer.review.response.findings'), {
    steps: ['reviewer', 'review', 'response', 'findings'],
  });
});

for (const [path, error] of [
  ['', 'the field path is empty'],
  ['a..b', '"a..b" has an empty segment'],
  [3, 'the field path must be a string, not number'],
  [null, 'the field path must be a string, not null'],
]) {
  test(`a malformed reference path is one error (${JSON.stringify(path)})`, () => {
    assert.deepEqual(referencePaths.parse(path), { error });
  });
}

test('read gives the value at a path, or undefined through a missing or non-object step', () => {
  assert.equal(referencePaths.read({ response: { reason: 'none' } }, 'response.reason'), 'none');
  assert.equal(referencePaths.read({ response: 'x' }, 'response.reason'), undefined);
  assert.equal(referencePaths.read({}, 'toString'), undefined);
});

test('write sets own properties only, so __proto__ stays data', () => {
  const target = {};
  referencePaths.write(target, '__proto__.polluted', true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(target), ['__proto__']);
});

test("resolve types a path through a scope, keeping gg's integer bounds", () => {
  const scope = { type: 'object', properties: { pass: { type: 'integer', min: 1, max: 2 } } };
  assert.deepEqual(referencePaths.resolve(scope, 'pass'), {
    type: { kind: 'integer', min: 1, max: 2 },
    node: scope.properties.pass,
  });
  // A path that does not resolve gives the validator's Finding, its params naming the path and the missing segment.
  assert.deepEqual(referencePaths.resolve(scope, 'pass.x'), {
    error: '"pass.x" is not defined',
    finding: {
      code: 'undefined-reference',
      message: '"pass.x" is not defined',
      params: { path: 'pass.x', missing: 'pass.x' },
    },
  });
});

test("resolve in read mode types a path as read reads it: a list by length or index, never its items' fields", () => {
  const item = { type: 'object', properties: { file: { type: 'string' } } };
  const scope = { type: 'object', properties: { findings: { type: 'array', items: item } } };
  assert.deepEqual(
    referencePaths.resolve(scope, 'findings.file').type,
    { kind: 'list', of: { kind: 'string' } },
    'typing projects',
  );
  const intoList = '"findings.file": "findings" is a list, so a path reads only its length or an item by index';
  assert.deepEqual(referencePaths.resolve(scope, 'findings.file', 'defined', { read: true }), {
    error: intoList,
    finding: {
      code: 'reference-into-list',
      message: intoList,
      params: { path: 'findings.file', list: 'findings' },
    },
    list: 'findings',
  });
  assert.deepEqual(referencePaths.resolve(scope, 'findings.length', 'defined', { read: true }).type, {
    kind: 'integer',
  });
  assert.deepEqual(referencePaths.resolve(scope, 'findings.0.file', 'defined', { read: true }).type, {
    kind: 'string',
  });
});

test('only the resolver splits reference paths in lib', () => {
  const lib = new URL('../../lib/', import.meta.url);
  const splitting = readdirSync(lib)
    .filter((file) => /\.(?:mjs|ts)$/.test(file) && file !== 'reference-paths.ts')
    .filter((file) => /\.split\(\s*['"]\.['"]\s*\)/.test(readFileSync(new URL(file, lib), 'utf8')));
  assert.deepEqual(splitting, []);
});
