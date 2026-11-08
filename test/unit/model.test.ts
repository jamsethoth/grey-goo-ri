import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as model from '../../lib/model.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as namedFlow from '../support/named-flow.ts';

// The Config Hash of a Pinned Configuration holding `flow` and nothing else.
const pinnedHash = (flow: unknown) =>
  config.configHash({ flow, files: {}, harnesses: {}, commands: {}, testPaths: [] });

test("the model's JSON round-trips to the same Config Hash", () => {
  const example = exampleLayer.check(exampleLayer.config()).flows.default;
  // The named Flow's JSON with every name an Object.prototype property's, each __proto__ an own key.
  const prototype = namedFlow.renamed(Object.values(namedFlow.validated(namedFlow.ORDINARY).flows)[0]);
  for (const json of [example, prototype]) {
    const roundTripped = model.toJson(model.fromJson(json));
    assert.deepEqual(roundTripped, json);
    assert.equal(pinnedHash(roundTripped), pinnedHash(json));
  }
});
