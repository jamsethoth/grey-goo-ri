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

test('gg doctor exits non-zero on an error', () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} }, readSchema });
  assert.equal(exitCode, 1);
  assert.ok(text.endsWith('\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared\n1 error, 2 warnings\n'), text);
});
