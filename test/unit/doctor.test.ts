import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as exampleLayer from '../support/example-layer.ts';

const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// The example Layer as loadLayers gives it: its schemas loaded beside it, and a template naming nothing for each
// template it names (its own templates arrive with #120).
function example() {
  const layer = exampleLayer.config();
  layer.files = Object.fromEntries([
    ...exampleLayer.SCHEMA_NAMES.map((name) => [name, file(exampleLayer.fixtureText(name))]),
    ...Object.entries(exampleLayer.templates()).map(([name, text]) => [name, file(text)]),
  ]);
  return layer;
}

test("gg doctor prints each Vertex's Procedure, Checks, tables and Outcomes", () => {
  const { text, exitCode } = doctor.doctor({ config: example(), harnesses: { fake: {} } });
  assert.equal(text, exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n'));
  assert.equal(exitCode, 0);
});

test('gg doctor reports a malformed table row rather than throwing', () => {
  const config = example();
  config.procedures.review.passed[0] = null;
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(text.includes('\n  passed:\n    1. no conditions -> undefined\n'), text);
  assert.ok(
    text.includes(
      '\nerror: procedures.review.passed[0]: a row is { when: { <field>: <condition> }, outcome: <name> }\n',
    ),
    text,
  );
});

test('gg doctor exits non-zero on an error', () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(
    text.endsWith('\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared\n1 error, 2 warnings\n'),
    text,
  );
});

test('gg doctor reports a Procedure name with a colon at its location', () => {
  const config = example();
  config.procedures['base:check'] = config.procedures['base-check'];
  delete config.procedures['base-check'];
  config.flows.default.ticket.vertices.baseline.procedure = 'base:check';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      '\nerror: procedures.base:check: Procedure "base:check" must be non-empty with no ":", ".", "/", "--" or ' +
        'whitespace\n',
    ),
    text,
  );
});

test("gg doctor reports an Agent's access outside the Permission Intents at agents.<name>.access", () => {
  const config = example();
  config.agents.implementer.access = 'read-write';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(
    text.endsWith(
      '\nerror: agents.implementer.access: access "read-write" is not a Permission Intent: read-only or ' +
        'workspace-write\n1 error, 2 warnings\n',
    ),
    text,
  );
});

test('gg doctor reports an Outcome named after an Object.prototype property as reserved', () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].outcome = 'toString';
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.equal(
    text,
    'error: procedures.tests-fail.stopped[0]: outcome "toString" is reserved: every object inherits a property of ' +
      'that name from Object.prototype\n1 error\n',
  );
});

test('gg doctor reads schemas from the loaded Layer files', () => {
  const config = example();
  const schema = JSON.parse(config.files['review.schema.json'].bytes);
  schema.properties.claim.enum = ['ok', 'changes'];
  config.files['review.schema.json'] = file(JSON.stringify(schema));
  const { text, exitCode } = doctor.doctor({ config, harnesses: { fake: {} } });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      '\nerror: procedures.review.claimTokens: review.schema.json: claim: enum "ok" | "changes" does not equal the ' +
        'declared tokens "ok" | "changes" | "blocked"\n',
    ),
    text,
  );
});

test('gg doctor accepts the shipped defaults once a harness is set', () => {
  const shipped: exampleLayer.Layer = config.loadDefaults();
  shipped.agents.implementer.harness = 'fake';
  shipped.agents.reviewer.harness = 'fake';
  shipped.commands = { test: 'npm test' };
  const { text, exitCode } = doctor.doctor({ config: shipped, harnesses: { fake: {} } });
  assert.ok(text.startsWith('flow default\n  actionCap: 180\n  entry: red\n'), text);
  // The example's intended overlap (U4): a clean ok whose findings repeat earlier ones stays ok.
  assert.ok(
    text.endsWith(
      '\nwarning: procedures.review.passed: rule table review.passed: ' +
        'row 2 (check.repeat = failed) is partly taken by ' +
        'row 1 (claim = ok and check.review-pass = passed), ' +
        'for example {"claim":"ok","check":{"review-pass":"passed","repeat":"failed"}}\n' +
        '0 errors, 1 warning\n',
    ),
    text,
  );
  assert.equal(exitCode, 0);
});
