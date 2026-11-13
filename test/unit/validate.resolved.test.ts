import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../../lib/model.ts';
import * as resolved from '../../lib/validate/resolved.ts';
import * as exampleLayer from '../support/example-layer.ts';

// The validator copies some fields as declared and narrows each to its Resolved Flow type by a guard (#364, D2): a
// field of the wrong type leaves the Flow only declared, so nothing reads it as resolved.

// A value no copied field takes: not a string, number, null, list, end, Edge, Agent, Claim token, row or recover.
const WRONG = { wrong: true };

// The example as declared, and the object each place of model.COPIED_FIELDS sits on in it.
function placed() {
  const declared = structuredClone(exampleLayer.check(exampleLayer.config()).declared.default!);
  const places: Record<keyof typeof model.COPIED_FIELDS, Record<string, unknown>> = {
    flow: declared,
    ticket: declared.ticket,
    vertex: declared.ticket.vertices.red!,
    procedure: declared.procedures['tests-fail']!,
  };
  return { declared, places };
}

test('the example as declared resolves to its Resolved Flow', () => {
  const { declared } = placed();
  const resolvedFlow = resolved.resolvedFlow(declared);
  assert.ok(resolvedFlow, 'the example resolves');
  assert.deepEqual(resolvedFlow, exampleLayer.check(exampleLayer.config()).flows.default);
});

for (const [place, fields] of Object.entries(model.COPIED_FIELDS))
  for (const field of fields)
    test(`a declared Flow whose ${place} ${field} has the wrong type does not resolve`, () => {
      const { declared, places } = placed();
      places[place as keyof typeof places][field] = WRONG;
      assert.equal(resolved.resolvedFlow(declared), undefined);
    });

// Puts `value` at `path` in the declared Flow, where a key already is: a case breaks one element the example holds.
function replaceAt(root: object, path: (string | number)[], value: unknown) {
  const parent: unknown = path
    .slice(0, -1)
    .reduce<unknown>(
      (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined),
      root,
    );
  const key = path.at(-1)!;
  if (typeof parent !== 'object' || parent === null || !Reflect.has(parent, key))
    throw new Error(`the example holds nothing at ${path.join('.')}`);
  Reflect.set(parent, key, value);
}

// Each guard that checks one element inside a field, by an element of the example it breaks, the field around it kept
// well-formed (#364, E1).
const ELEMENTS: Record<string, (string | number)[]> = {
  'a rule row': ['procedures', 'tests-fail', 'stopped', 0],
  'a rule row condition': ['procedures', 'tests-fail', 'stopped', 0, 'when', 'response.reason'],
  'an Action': ['procedures', 'tests-fail', 'actions', 0],
  'a Claim token': ['procedures', 'tests-fail', 'claimTokens', 'ok'],
  "an Edge's exhausted target": ['ticket', 'vertices', 'reviewer', 'route', 'retest', 'exhausted'],
  "a routing entry's target": ['ticket', 'vertices', 'red', 'routing', 'ok', 'target'],
  "a ticket route's target": ['ticket', 'routes', '*'],
  "an Agent's harness": ['ticket', 'vertices', 'red', 'agent', 'harness'],
};

for (const [element, path] of Object.entries(ELEMENTS))
  test(`a declared Flow with ${element} of the wrong type does not resolve`, () => {
    const { declared } = placed();
    replaceAt(declared, path, WRONG);
    assert.equal(resolved.resolvedFlow(declared), undefined);
  });
