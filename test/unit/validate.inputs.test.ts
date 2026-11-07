import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// A ticket's routes that end every Outcome no Vertex routes at needs-human.
const UNROUTED_NEEDS_HUMAN = { '*': { end: 'needs-human' } };

// A read-only Procedure `judge`: its agent Action claims ok, changes or blocked, ok and changes requiring the Checks
// `requires` names, then a command Check for each id in `checks`, then the rule tables given.
function judge(requires: { ok: string[]; changes: string[] }, checks: string[], tables: object = {}) {
  return {
    access: 'read-only',
    claimTokens: { ok: { requires: requires.ok }, changes: { requires: requires.changes }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      ...checks.map((id) => ({ id, do: 'check', kind: 'command', command: 'test' })),
    ],
    ...tables,
  };
}

test('a required input missing on one path is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.vertices.green.inputs.testFiles.optional;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.green.inputs.testFiles`,
      code: 'required-input-unsure',
    },
  ]);
});

test('an optional input no route produces is a warning', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.previous = { from: 'publish.rescue', optional: true };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
    at: `${VERTICES}.implementer-fix.inputs.previous`,
    code: 'optional-input-unsure',
  });
});

test('a required list input is met when each passing token produces a different source', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['a'], changes: ['b'] }, ['a', 'b'], {
    passed: [
      { when: { claim: 'ok' }, outcome: 'go' },
      { when: { claim: 'changes' }, outcome: 'go' },
    ],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: ['judge.a.evidence', 'judge.b.evidence'] } } },
    },
  };
  assert.deepEqual(exampleLayer.check(config).errors, []);
});

test("a row's Outcome counts for every Claim token of its table, so an input one token's Check gives is unmet", () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['a'], changes: [] }, ['a'], {
    passed: [{ when: { claim: 'ok' }, outcome: 'go' }],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.a.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test("a Vertex's exhausted target counts from its first entry, so an input the Vertex gives is unmet there", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'start',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      start: { procedure: 'base-check', route: { ok: 'producer' } },
      producer: { procedure: 'base-check', max: 1, exhausted: 'consumer', route: { ok: 'producer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test("an edge's exhausted target counts from its first traversal, so an input its target gives is unmet there", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'start',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      start: { procedure: 'base-check', route: { ok: { to: 'producer', max: 1, exhausted: 'consumer' } } },
      producer: { procedure: 'base-check', route: { ok: 'start' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test('a failed Claim guarantees no evidence, so an optional input reading only it is warned', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'producer',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      producer: { procedure: 'base-check', route: { failed: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
    at: `${VERTICES}.consumer.inputs.evidence`,
    code: 'optional-input-unsure',
  });
});

test('a Vertex max above 1 counts as spent from the first entry, so an input a later Vertex gives is unmet', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'a',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      /* eslint-disable id-length -- single-letter Vertex ids, as the expected Problems name them */
      a: { procedure: 'base-check', max: 2, exhausted: 'consumer', route: { ok: 'b' } },
      b: { procedure: 'base-check', max: 1, exhausted: 'c', route: { ok: 'a' } },
      c: { procedure: 'base-check', route: { ok: 'a' } },
      /* eslint-enable id-length */
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'c.test.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test('a row taken by an earlier row counts its Outcome for every token, so an input one token gives is unmet', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['a'], changes: ['b'] }, ['a', 'b'], {
    passed: [
      { when: { claim: 'ok' }, outcome: 'a-go' },
      { when: {}, outcome: 'b-go' },
    ],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'b-go': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.b.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test(
  'a failed Claim guarantees no evidence of a later required Check, ' + 'so an optional input reading it is warned',
  () => {
    const config = exampleLayer.config();
    config.procedures.both = {
      actions: [
        { id: 'a', do: 'check', kind: 'command', command: 'test' },
        { id: 'b', do: 'check', kind: 'command', command: 'test' },
      ],
    };
    config.flows.default.ticket = {
      entry: 'producer',
      routes: UNROUTED_NEEDS_HUMAN,
      vertices: {
        producer: { procedure: 'both', route: { failed: 'consumer' } },
        consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.b.evidence', optional: true } } },
      },
    };
    const { errors, warnings } = exampleLayer.check(config);
    assert.deepEqual(errors, []);
    assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'optional-input-unsure',
    });
  },
);

test('an Outcome of the stopped table carries no evidence, whatever a row names', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['test'], changes: [] }, ['test'], {
    stopped: [{ when: { 'check.test': 'passed' }, outcome: 'has-evidence' }],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'has-evidence': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.test.evidence' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test('a stopped Claim guarantees no evidence, so an optional input reading it is warned', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['test'], changes: [] }, ['test'], {
    stopped: [{ when: { 'check.test': 'failed' }, outcome: 'no-evidence' }],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'no-evidence': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.test.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
    at: `${VERTICES}.consumer.inputs.evidence`,
    code: 'optional-input-unsure',
  });
});

test('an Outcome of stopped rows carries no evidence, even when each needs a different Check passed', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: [], changes: [] }, ['a', 'b'], {
    stopped: [
      { when: { 'check.a': 'passed' }, outcome: 'go' },
      { when: { 'check.b': 'passed' }, outcome: 'go' },
    ],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: ['judge.a.evidence', 'judge.b.evidence'] } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.evidence`,
      code: 'required-input-unsure',
    },
  ]);
});

test('an optional input that only some ways of an Outcome produce is warned', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: ['a'], changes: [] }, ['a'], {
    passed: [
      { when: { claim: 'ok' }, outcome: 'go' },
      { when: { claim: 'changes' }, outcome: 'go' },
    ],
  });
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.a.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
    at: `${VERTICES}.consumer.inputs.evidence`,
    code: 'optional-input-unsure',
  });
});

test('a harness failure leaves no response', () => {
  const config = exampleLayer.config();
  config.procedures.judge = judge({ ok: [], changes: [] }, []);
  config.flows.default.ticket = {
    entry: 'judge',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'harness-timeout': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { report: { from: 'judge.judge.response' } } },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.consumer.inputs.report`,
      code: 'required-input-unsure',
    },
  ]);
});

test('a passing Outcome leaves no rescue', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.inputs.previous = { from: 'green.rescue' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.reviewer.inputs.previous`,
      code: 'required-input-unsure',
    },
  ]);
});

test('a read-only Vertex leaves no rescue', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.access = 'read-only';
  delete config.flows.default.ticket.vertices['senior-green'].inputs.previous.optional;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.senior-green.inputs.previous`,
      code: 'required-input-unsure',
    },
  ]);
});
