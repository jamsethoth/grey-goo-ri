import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as doctor from '../../lib/doctor.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8');

function example() {
  const config = JSON.parse(fixture('gg.json'));
  for (const agent of Object.values(config.agents)) agent.harness = 'fake';
  return config;
}
const readSchema = (name) => JSON.parse(fixture(name));

test('gg doctor prints each Vertex\'s Procedure, Checks, tables and Outcomes', () => {
  const { text, exitCode } = doctor.doctor({ config: example(), harnesses: { fake: {} }, readSchema });
  assert.equal(text, fixture('doctor.txt').replaceAll('\r\n', '\n'));
  assert.equal(exitCode, 0);
});

test('gg doctor reports a malformed table row rather than throwing', () => {
  const config = example();
  config.procedures.review.passed[0] = null;
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} }, readSchema });
  assert.equal(exitCode, 1);
  assert.ok(text.includes('\n  passed:\n    1. no conditions -> undefined\n'), text);
  assert.ok(text.includes('\nerror: procedures.review.passed[0]: a row is { when: { <field>: <condition> }, outcome: <name> }\n'), text);
});

test('gg doctor exits non-zero on an error', () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} }, readSchema });
  assert.equal(exitCode, 1);
  assert.ok(text.endsWith('\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared\n1 error, 2 warnings\n'), text);
});

test('gg doctor prints an unrouted Outcome named after an Object property as unrouted', () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].outcome = 'toString';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} }, readSchema });
  assert.equal(exitCode, 0);
  assert.ok(text.includes('\n    toString -> end needs-human (Flow "*"); work left in place\n'), text);
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  const unrouted = doctor.doctor({ config, harnesses: { fake: {} }, readSchema });
  assert.equal(unrouted.exitCode, 1);
  assert.ok(unrouted.text.includes('\n    toString -> unrouted\n'), unrouted.text);
});
