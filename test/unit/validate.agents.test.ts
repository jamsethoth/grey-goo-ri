import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as resolved from '../../lib/validate/resolved.ts';
import * as exampleLayer from '../support/example-layer.ts';

// The Agent keys the validator checks (#386). A case about a rule asserts which one fired and where.
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// Every Agent key the interpreter reads is checked wherever an Agent key is written (#386), so a Run cannot fail on one
// at Visit entry: resolved.AGENT_FIELDS is model.Agent's declared keys, and each must be here.
const AGENT_KEY_ERRORS: Record<string, { under: boolean; code: string }> = {
  harness: { under: false, code: 'invalid-name' },
  persona: { under: true, code: 'file-not-named' },
  model: { under: true, code: 'not-a-string' },
  effort: { under: true, code: 'not-a-string' },
  network: { under: true, code: 'not-a-boolean' },
};
const AGENT_SITES: Record<string, (config: exampleLayer.Layer) => { site: Record<string, unknown>; at: string }> = {
  'a declared Agent': (config) => ({ site: config.agents.implementer, at: 'agents.implementer' }),
  "a Vertex's override of its Agent": (config) => ({
    site: config.flows.default.ticket.vertices.red,
    at: `${VERTICES}.red`,
  }),
  'an inline Vertex Agent': (config) => {
    const red = config.flows.default.ticket.vertices.red;
    delete red.use;
    Object.assign(red, config.agents.implementer);
    return { site: red, at: `${VERTICES}.red` };
  },
};

test('the Agent keys checked at each site are every key the Resolved Flow declares for an Agent', () => {
  assert.deepEqual(Object.keys(AGENT_KEY_ERRORS).sort(), Object.keys(resolved.AGENT_FIELDS).sort());
});

for (const key of Object.keys(resolved.AGENT_FIELDS))
  for (const [where, place] of Object.entries(AGENT_SITES))
    test(`an Agent's ${key} of the wrong type at ${where} is an error there`, () => {
      const config = exampleLayer.config();
      const { site, at } = place(config);
      site[key] = { wrong: true };
      const { under, code } = AGENT_KEY_ERRORS[key]!;
      assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
        { at: under ? `${at}.${key}` : at, code },
      ]);
    });

test("an Agent with no persona is one error at the Agent, used or not, which a Vertex's own does not excuse", () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.persona;
  config.flows.default.ticket.vertices.reviewer.persona = 'reviewer.md';
  config.agents.spare = { harness: 'fake' };
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: 'agents.reviewer', code: 'required-key-missing' },
    { at: 'agents.spare', code: 'required-key-missing' },
  ]);
  assert.deepEqual(errors[0]!.params, { key: 'persona' });
});

test('an inline Vertex Agent with no persona is an error at the Vertex', () => {
  const config = exampleLayer.config();
  const red = config.flows.default.ticket.vertices.red;
  delete red.use;
  Object.assign(red, { harness: 'fake', access: 'workspace-write' });
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'required-key-missing' },
  ]);
});

test("a Vertex may override its Agent's persona with another file", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.persona = 'reviewer.md';
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default!.ticket.vertices.red!.agent!.persona, 'reviewer.md');
});

test('an empty persona names no file, and a null one is only a null', () => {
  const config = exampleLayer.config();
  config.agents.reviewer.persona = ' ';
  config.agents.senior.persona = null;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.senior.persona', code: 'null-value' },
    { at: 'agents.reviewer.persona', code: 'file-not-named' },
  ]);
});
