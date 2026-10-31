import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as config from '../../lib/config.mjs';
import * as doctor from '../../lib/doctor.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const file = (bytes) => ({ bytes, hash: sha256(bytes) });

// The example Layer as loadConfig gives it: its schemas loaded beside it.
function example() {
  const config = JSON.parse(fixture('gg.json'));
  for (const agent of Object.values(config.agents)) agent.harness = 'fake';
  config.files = Object.fromEntries(['red', 'implement', 'review'].map((p) => [`${p}.schema.json`, file(fixture(`${p}.schema.json`))]));
  return config;
}

test('gg doctor prints each Vertex\'s Procedure, Checks, tables and Outcomes', () => {
  const { text, exitCode } = doctor.doctor({ config: example(), harnesses: { fake: {} } });
  assert.equal(text, fixture('doctor.txt').replaceAll('\r\n', '\n'));
  assert.equal(exitCode, 0);
});

test('gg doctor reports a malformed table row rather than throwing', () => {
  const config = example();
  config.procedures.review.passed[0] = null;
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(text.includes('\n  passed:\n    1. no conditions -> undefined\n'), text);
  assert.ok(text.includes('\nerror: procedures.review.passed[0]: a row is { when: { <field>: <condition> }, outcome: <name> }\n'), text);
});

test('gg doctor exits non-zero on an error', () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(text.endsWith('\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared\n1 error, 2 warnings\n'), text);
});

test('gg doctor reports an Outcome named after an Object.prototype property as reserved', () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].outcome = 'toString';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.equal(text, 'error: procedures.tests-fail.stopped[0]: outcome "toString" is reserved: every object inherits a property of that name from Object.prototype\n1 error\n');
});

test('gg doctor reads schemas from the loaded Layer files', () => {
  const config = example();
  const schema = JSON.parse(config.files['review.schema.json'].bytes);
  schema.properties.claim.enum = ['ok', 'changes'];
  config.files['review.schema.json'] = file(JSON.stringify(schema));
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(text.includes('\nerror: procedures.review.claims: review.schema.json: claim: enum "ok" | "changes" does not equal the declared tokens "ok" | "changes" | "blocked"\n'), text);
});

test('gg doctor accepts the shipped defaults once a harness is set', () => {
  const shipped = config.loadDefaults();
  for (const agent of Object.values(shipped.agents)) agent.harness = 'fake';
  shipped.commands = { test: 'npm test' };
  const { text, exitCode } = doctor.doctor({ config: shipped, harnesses: { fake: {} } });
  assert.ok(text.startsWith('flow default\n  plan: null\n  actionCap: 180\n  entry: red\n'), text);
  assert.ok(text.endsWith('\n0 errors\n'), text);
  assert.equal(exitCode, 0);
});
