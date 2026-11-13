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
  assert.deepEqual(resolved.resolvedFlow(declared), exampleLayer.check(exampleLayer.config()).flows.default);
});

for (const [place, fields] of Object.entries(model.COPIED_FIELDS))
  for (const field of fields)
    test(`a declared Flow whose ${place} ${field} has the wrong type does not resolve`, () => {
      const { declared, places } = placed();
      places[place as keyof typeof places][field] = WRONG;
      assert.equal(resolved.resolvedFlow(declared), undefined);
    });
