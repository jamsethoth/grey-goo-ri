import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../../lib/procedures.ts';
import * as requestTables from '../support/request-tables.ts';

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
  assert.deepEqual(procedures.outputs({ do: 'check', kind: 'command' }).properties.evidence.properties, {
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

// A response or repeat Check runs no command, so it has no evidence and no process cleanup to declare.
test('a Check kind declares only the outputs it produces', () => {
  const kinds = (kind) => Object.keys(procedures.outputs({ do: 'check', kind }).properties);
  assert.deepEqual(kinds('command'), ['evidence', 'cleanup']);
  assert.deepEqual(kinds('tests-fail'), ['evidence', 'cleanup']);
  assert.deepEqual(kinds('response'), []);
  assert.deepEqual(kinds('repeat'), ['findingsHash']);
});

test("the request's tables list exactly each Action kind's and Check kind's outputs", () => {
  const outputsOf = (action) => Object.keys(procedures.outputs(action, {}).properties).sort();
  const byKind = (kinds, outputs) => Object.fromEntries(Object.keys(kinds).map((kind) => [kind, outputs(kind)]));
  // The check row names none: a Check's outputs depend on its kind, which the Check kind table gives.
  assert.deepEqual(
    requestTables.columnTable('`do`', 4),
    byKind(procedures.ACTION_KEYS, (kind) => (kind === 'check' ? [] : outputsOf({ do: kind }))),
  );
  assert.deepEqual(
    requestTables.columnTable('Check kind', 4),
    byKind(procedures.CHECK_KEYS, (kind) => outputsOf({ do: 'check', kind })),
  );
});

// The request lists each kind's keys for a Layer's author; this keeps the tables and the declared keys one list (#229).
test("the request's tables list exactly each Action kind's and Check kind's keys", () => {
  assert.deepEqual(requestTables.keyTable('`do`'), requestTables.sortedKeys(procedures.ACTION_KEYS));
  assert.deepEqual(requestTables.keyTable('Check kind'), requestTables.sortedKeys(procedures.CHECK_KEYS));
});
