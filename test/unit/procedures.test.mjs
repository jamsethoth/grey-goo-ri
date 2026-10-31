import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    'tests-fail': ['command', 'names'],
    response: ['field', 'is', 'none', 'any', 'all', 'count', 'where', '<', '<=', '>', '>=', '=', 'all-of'],
    repeat: ['list', 'fields'],
  });
});

test("an agent Action's response is typed by its schema; a Check gives evidence and a commit its files", () => {
  const schema = { type: 'object', properties: { claim: { type: 'string', enum: ['ok'] } }, required: ['claim'], additionalProperties: false };
  assert.deepEqual(Object.keys(procedures.outputs({ do: 'agent' }, schema).properties), ['response', 'cleanup']);
  assert.equal(procedures.outputs({ do: 'agent' }, schema).properties.response, schema);
  assert.deepEqual(procedures.outputs({ do: 'check' }).properties.evidence.properties, { command: { type: 'string' }, output: { type: 'string' } });
  assert.deepEqual(procedures.outputs({ do: 'commit' }).properties, { files: { type: 'array', items: { type: 'string' } } });
  assert.deepEqual(procedures.outputs({ do: 'push' }).properties, {});
});
