import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as procedures from '../../lib/procedures.mjs';

test('the Action kinds and the keys each may declare', () => {
  assert.deepEqual(procedures.ACTION_KEYS, {
    agent: ['brief', 'schema'],
    check: ['kind', 'recoverBrief', 'recoverable'],
    commit: ['type'],
    push: [],
    'pr-upsert': ['body', 'with'],
    'pr-ready': [],
    comment: ['target', 'body'],
    'await-approval': ['decisions'],
  });
});

test('the Check kinds and the keys each may declare', () => {
  assert.deepEqual(procedures.CHECK_KEYS, {
    command: ['command', 'reuse'],
    'tests-fail': ['command', 'testNames'],
    response: ['field', 'is', 'none', 'any', 'all', 'count', 'where', '<', '<=', '>', '>=', '=', 'allOf'],
    repeat: ['list', 'fields'],
  });
});

test("an agent Action's response is typed by its schema; a Check gives evidence and a commit its files", () => {
  const schema = {
    type: 'object',
    properties: { claim: { type: 'string', enum: ['ok'] } },
    required: ['claim'],
    additionalProperties: false,
  };
  assert.deepEqual(Object.keys(procedures.outputs({ do: 'agent' }, schema).properties), ['response', 'cleanup']);
  assert.equal(procedures.outputs({ do: 'agent' }, schema).properties.response, schema);
  assert.deepEqual(procedures.outputs({ do: 'check' }).properties.evidence.properties, {
    command: { type: 'string' },
    output: { type: 'string' },
  });
  assert.deepEqual(procedures.outputs({ do: 'commit' }).properties, {
    files: { type: 'array', items: { type: 'string' } },
  });
  assert.deepEqual(procedures.outputs({ do: 'push' }).properties, {});
});

test("a tests-fail Check's evidence says whether it found the failing test by its name only", () => {
  assert.deepEqual(procedures.outputs({ do: 'check', kind: 'tests-fail' }).properties.evidence.properties, {
    command: { type: 'string' },
    output: { type: 'string' },
    foundByNameOnly: { type: 'boolean' },
  });
});

test('a repeat Check gives its Findings Hash', () => {
  assert.deepEqual(procedures.outputs({ do: 'check', kind: 'repeat' }).properties.findingsHash, { type: 'string' });
});

// The request lists each kind's keys for a Layer's author; this keeps the tables and the declared keys one list (#229).
test("the request lists every Action kind's and Check kind's keys", () => {
  const request = readFileSync(new URL('../../docs/requests/node-harness-dag.md', import.meta.url), 'utf8');
  const rowOf = (kind) =>
    request.split('\n').find((line) => line.startsWith('| ') && line.split('|')[1].includes(`\`${kind}\``));
  for (const [kind, keys] of [...Object.entries(procedures.ACTION_KEYS), ...Object.entries(procedures.CHECK_KEYS)]) {
    const row = rowOf(kind);
    assert.ok(row, `the request has a row for ${kind}`);
    for (const key of keys) assert.ok(row.includes(key), `the ${kind} row names ${key}`);
  }
});
