import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as model from '../../lib/model.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as namedFlow from '../support/named-flow.ts';

// The Config Hash of a Pinned Configuration holding `flow` and nothing else.
const pinnedHash = (flow: model.ResolvedFlowJson) =>
  config.configHash({ flow, files: {}, harnesses: {}, commands: {}, testPaths: [] });

test("the model's JSON round-trips to the same Config Hash", () => {
  const example = exampleLayer.check(exampleLayer.config()).flows.default!;
  // The named Flow's JSON with every name an Object.prototype property's, each __proto__ an own key.
  const prototype = Object.values(namedFlow.validated(namedFlow.PROTOTYPE).flows)[0]!;
  for (const json of [example, prototype]) {
    const roundTripped = model.toJson(model.fromJson(json));
    assert.deepEqual(roundTripped, json);
    assert.equal(pinnedHash(roundTripped), pinnedHash(json));
  }
});

// Only the validator and fromJson produce a Resolved Flow, so a name it lacks is a broken invariant, which the accessor
// names; the Flow's collections are read-only after admission.
test('vertex and procedure give what the validator admitted, and name what it did not', () => {
  const flow = model.fromJson(exampleLayer.check(exampleLayer.config()).flows.default!);
  assert.equal(model.vertex(flow, 'red'), flow.ticket.vertices.get('red'));
  assert.equal(model.procedure(flow, 'implement'), flow.procedures.get('implement'));
  assert.throws(() => model.vertex(flow, 'constructor'), /Vertex "constructor" is not in Flow default/);
  assert.throws(() => model.procedure(flow, '__proto__'), /Procedure "__proto__" is not in Flow default/);
  // @ts-expect-error -- the collections are ReadonlyMaps, so nothing writes an admitted Flow
  flow.ticket.vertices.set('x', model.vertex(flow, 'red'));
});
