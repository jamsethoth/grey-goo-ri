import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as report from '../../lib/validate/report.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// What every Problem carries beside its code (lib/validate/report.ts): the values its sentence names, in `params`, and
// a location that is a plain path in the merged configuration.
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('a Problem carries the values its sentence names in params, and a code that names none takes none', () => {
  const problems = report.newReport();
  report.error(problems, 'agents.spare', 'unknown-key', 'unknown key "colour"', { key: 'colour' });
  report.error(problems, 'flows', 'no-flow-declared', 'an error');
  report.warn(problems, 'agents.spare', 'unused-agent', 'agent spare is used by no Vertex', { agent: 'spare' });
  assert.deepEqual(problems, {
    errors: [
      { at: 'agents.spare', code: 'unknown-key', message: 'unknown key "colour"', params: { key: 'colour' } },
      { at: 'flows', code: 'no-flow-declared', message: 'an error' },
    ],
    warnings: [
      {
        at: 'agents.spare',
        code: 'unused-agent',
        message: 'agent spare is used by no Vertex',
        params: { agent: 'spare' },
      },
    ],
  });
});

test('the params a code takes are checked at type-check time, from the one map beside the codes', () => {
  const problems = report.newReport();
  // @ts-expect-error -- unknown-key's params name the key, not a name
  report.error(problems, 'agents', 'unknown-key', 'unknown key "x"', { name: 'x' });
  // @ts-expect-error -- unknown-key's sentence names its key, so its params are required
  report.error(problems, 'agents', 'unknown-key', 'unknown key "x"');
  // @ts-expect-error -- no-flow-declared's sentence names no value, so it takes no params
  report.warn(problems, 'flows', 'no-flow-declared', 'no Flow', { key: 'flows' });
  assert.equal(problems.errors.length + problems.warnings.length, 3);
});

const LEFT_OUT = 'required-key-missing' as const;
// Each required key left out, with what it reports. The sentence is the behaviour here: it says what to add, and never
// prints "undefined" as though that were a value. Its params name the key left out, as Ajv's missingProperty does.
const LEFT_OUT_KEYS: [string, (config: exampleLayer.Layer) => void, report.Problem[]][] = [
  [
    "a Vertex's procedure",
    (config) => {
      delete config.flows.default.ticket.vertices.publish.procedure;
    },
    [
      {
        at: `${VERTICES}.publish`,
        code: LEFT_OUT,
        message: 'a Vertex must name a procedure',
        params: { key: 'procedure' },
      },
    ],
  ],
  [
    "a ticket's entry",
    (config) => {
      delete config.flows.default.ticket.entry;
    },
    [
      {
        at: 'flows.default.ticket.entry',
        code: LEFT_OUT,
        message: 'a ticket must name its entry Vertex',
        params: { key: 'entry' },
      },
    ],
  ],
  [
    "a ticket's vertices",
    (config) => {
      delete config.flows.default.ticket.vertices;
    },
    [
      { at: VERTICES, code: LEFT_OUT, message: 'vertices must be a non-empty object', params: { key: 'vertices' } },
      {
        at: 'flows.default.ticket.entry',
        code: 'unknown-vertex',
        message: '"baseline" is not a Vertex',
        params: { vertex: 'baseline' },
      },
    ],
  ],
  [
    "a Flow's ticket",
    (config) => {
      delete config.flows.default.ticket;
    },
    [
      { at: 'flows.default.ticket', code: LEFT_OUT, message: 'ticket must be an object', params: { key: 'ticket' } },
      { at: VERTICES, code: LEFT_OUT, message: 'vertices must be a non-empty object', params: { key: 'vertices' } },
      {
        at: 'flows.default.ticket.entry',
        code: LEFT_OUT,
        message: 'a ticket must name its entry Vertex',
        params: { key: 'entry' },
      },
    ],
  ],
  [
    "a Flow's actionCap",
    (config) => {
      delete config.flows.default.actionCap;
    },
    [
      {
        at: 'flows.default.actionCap',
        code: LEFT_OUT,
        message: 'actionCap must be a positive integer',
        params: { key: 'actionCap' },
      },
    ],
  ],
  [
    "a Procedure's actions",
    (config) => {
      delete config.procedures.publish.actions;
    },
    [
      {
        at: 'procedures.publish',
        code: LEFT_OUT,
        message: 'actions must be a non-empty list',
        params: { key: 'actions' },
      },
    ],
  ],
  [
    "an Action's id",
    (config) => {
      delete procedureActions.actionById(config.procedures.publish, 'pr-ready').id;
    },
    [
      {
        at: 'procedures.publish.actions[2]',
        code: LEFT_OUT,
        message: 'an Action must have an id',
        params: { key: 'id' },
      },
    ],
  ],
  [
    "an Action's do",
    (config) => {
      delete procedureActions.actionById(config.procedures.publish, 'pr-ready').do;
    },
    [
      {
        at: 'procedures.publish.actions[2]',
        code: LEFT_OUT,
        message: 'an Action must name its kind in do',
        params: { key: 'do' },
      },
    ],
  ],
  [
    "a Check's kind",
    (config) => {
      delete procedureActions.actionById(config.procedures['base-check'], 'test').kind;
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        code: LEFT_OUT,
        message: 'a Check must name its kind',
        params: { key: 'kind' },
      },
    ],
  ],
  [
    "a Check's command",
    (config) => {
      delete procedureActions.actionById(config.procedures['base-check'], 'test').command;
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        code: LEFT_OUT,
        message: 'Check test must name a command',
        params: { key: 'command', id: 'test' },
      },
    ],
  ],
  [
    "a tests-fail Check's testNames",
    (config) => {
      delete procedureActions.actionById(config.procedures['tests-fail'], 'red-check').testNames;
    },
    [
      {
        at: 'procedures.tests-fail.actions[1]',
        code: LEFT_OUT,
        message: 'a tests-fail Check must name testNames',
        params: { key: 'testNames' },
      },
    ],
  ],
  [
    "a repeat Check's list",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'repeat').list;
    },
    [
      {
        at: 'procedures.review.actions[2]',
        code: LEFT_OUT,
        message: 'a repeat Check must name its list',
        params: { key: 'list' },
      },
    ],
  ],
  [
    "a repeat Check's fields",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'repeat').fields;
    },
    [
      {
        at: 'procedures.review.actions[2]',
        code: LEFT_OUT,
        message: 'fields must be a non-empty list of field names',
        params: { key: 'fields' },
      },
    ],
  ],
  [
    "a comment's target",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'comment').target;
    },
    [
      {
        at: 'procedures.review.actions[3]',
        code: LEFT_OUT,
        message: 'target must be pr or ticket',
        params: { key: 'target' },
      },
    ],
  ],
  [
    "an input's from",
    (config) => {
      config.flows.default.ticket.vertices.red.inputs.oddly = { optional: true };
    },
    [
      {
        at: `${VERTICES}.red.inputs.oddly`,
        code: LEFT_OUT,
        message: 'from must name at least one source',
        params: { key: 'from' },
      },
    ],
  ],
  [
    "a response condition's is",
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = { field: 'definitionOfDoneMet' };
    },
    [
      {
        at: 'procedures.review.actions[1]',
        code: LEFT_OUT,
        message: 'allOf[0]: "definitionOfDoneMet" is a boolean, so is must be true or false',
        params: { key: 'is', field: 'definitionOfDoneMet' },
      },
    ],
  ],
  [
    "a response condition's is, on an enum field",
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = { field: 'reason' };
    },
    [
      {
        at: 'procedures.review.actions[1]',
        code: LEFT_OUT,
        message: 'allOf[0]: "reason" is an enum, so is must be one of none | misscoped | needs-input | environment',
        params: { key: 'is', field: 'reason', values: ['none', 'misscoped', 'needs-input', 'environment'] },
      },
    ],
  ],
  [
    "a Check's id and command",
    (config) => {
      const check = procedureActions.actionById(config.procedures['base-check'], 'test');
      delete check.id;
      delete check.command;
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        code: LEFT_OUT,
        message: 'an Action must have an id',
        params: { key: 'id' },
      },
      {
        at: 'procedures.base-check.actions[0]',
        code: LEFT_OUT,
        message: 'Check with no id must name a command',
        params: { key: 'command' },
      },
    ],
  ],
  [
    "a Check's id, when its command is not declared",
    (config) => {
      const check = procedureActions.actionById(config.procedures['base-check'], 'test');
      delete check.id;
      check.command = 'lint';
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        code: LEFT_OUT,
        message: 'an Action must have an id',
        params: { key: 'id' },
      },
      {
        at: 'procedures.base-check.actions[0]',
        code: 'undeclared-command',
        message: 'Check with no id names command "lint", which the repository Layer does not declare',
        params: { command: 'lint' },
      },
    ],
  ],
  [
    "a Check's id, when it comes after an effect",
    (config) => {
      config.procedures.publish.actions.push({ do: 'check', kind: 'command', command: 'test' });
    },
    [
      {
        at: 'procedures.publish.actions[3]',
        code: LEFT_OUT,
        message: 'an Action must have an id',
        params: { key: 'id' },
      },
      {
        at: 'procedures.publish.actions[3]',
        code: 'check-after-effect',
        message:
          'Check with no id comes after pr-upsert Action pr; every Check comes before any effect, so no effect runs ' +
          'before its pass is decided',
        params: { effect: 'pr-upsert', effectId: 'pr' },
      },
    ],
  ],
  [
    "an effect's id, when a Check comes after it",
    (config) => {
      delete procedureActions.actionById(config.procedures.publish, 'pr').id;
      config.procedures.publish.actions.push({ id: 'late', do: 'check', kind: 'command', command: 'test' });
    },
    [
      {
        at: 'procedures.publish.actions[1]',
        code: LEFT_OUT,
        message: 'an Action must have an id',
        params: { key: 'id' },
      },
      {
        at: 'procedures.publish.actions[3]',
        code: 'check-after-effect',
        message:
          'Check late comes after pr-upsert Action with no id; every Check comes before any effect, so no effect ' +
          'runs before its pass is decided',
        params: { id: 'late', effect: 'pr-upsert' },
      },
    ],
  ],
  [
    "a response condition's where",
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[2] = { none: 'findings' };
    },
    [
      {
        at: 'procedures.review.actions[1]',
        code: LEFT_OUT,
        message: 'allOf[2]: where must be an object of item fields',
        params: { key: 'where' },
      },
    ],
  ],
];

for (const [what, mutate, errors] of LEFT_OUT_KEYS) {
  test(`a required key left out says so and names it in params: ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    assert.deepEqual(exampleLayer.check(config).errors, errors);
  });
}

test('a response condition whose is fits no value of its enum field keeps its code and message', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = { field: 'reason', is: 'x' };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.review.actions[1]',
      code: 'condition-value-mismatch',
      message: 'allOf[0]: "reason": "x" is not one of none | misscoped | needs-input | environment',
      params: { field: 'reason', value: 'x', values: ['none', 'misscoped', 'needs-input', 'environment'] },
    },
  ]);
});

// Every path to a value of the example Layer, as keys and list indices.
function valuePaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  const children: [string | number, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value !== null && typeof value === 'object' ? value : {});
  return [...(path.length ? [path] : []), ...children.flatMap(([key, item]) => valuePaths(item, [...path, key]))];
}
// A key's value left out, or replaced by a number, which every key but a count refuses.
function mutated(path: (string | number)[], leftOut: boolean) {
  const config = exampleLayer.config();
  const parent = path.slice(0, -1).reduce((value, key) => value[key], config);
  const key = path.at(-1) as string | number;
  if (!leftOut) parent[key] = 3;
  else if (Array.isArray(parent)) parent.splice(key as number, 1);
  else delete parent[key];
  return config;
}
// Dotted keys and [index], with no spaces or parentheses: what a program can split back into the configuration's keys.
const PLAIN_PATH = /^[^\s().[\]]+(\.[^\s().[\]]+|\[\d+\])*$/;

test('every at is a plain configuration path, across a mutation of every key of the example Layer', () => {
  const offending = new Map<string, string>();
  for (const path of valuePaths(exampleLayer.config())) {
    for (const leftOut of [true, false]) {
      const { errors, warnings } = exampleLayer.check(
        mutated(path, leftOut),
        exampleLayer.schemas(),
        exampleLayer.templates(),
      );
      for (const problem of [...errors, ...warnings])
        if (!PLAIN_PATH.test(problem.at)) offending.set(problem.at, `${path.join('.')}: ${problem.code}`);
    }
  }
  assert.deepEqual([...offending].slice(0, 5), []);
});

test('two Vertices report the same Procedure problem once each, at the Procedure, naming the Vertex', () => {
  const config = exampleLayer.config();
  config.procedures.fix.tests.named = 'inputs.findings';
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedAtVertices(errors), [
    { at: 'procedures.fix.tests', code: 'not-a-list-of-strings', flow: 'default', vertex: 'implementer-fix' },
    { at: 'procedures.fix.tests', code: 'not-a-list-of-strings', flow: 'default', vertex: 'senior-dev' },
  ]);
  assert.match(errors[0].message, /^Vertex implementer-fix of Flow default: tests: named must read a list of strings/);
  assert.match(errors[1].message, /^Vertex senior-dev of Flow default: /);
});

test('the same Vertex in two Flows reports a Procedure problem once in each', () => {
  const config = exampleLayer.config();
  config.procedures.fix.tests.named = 'inputs.findings';
  config.flows.other = structuredClone(config.flows.default);
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(
    exampleLayer.firedAtVertices(errors).map(({ flow, vertex }) => `${flow}.${vertex}`),
    ['default.implementer-fix', 'default.senior-dev', 'other.implementer-fix', 'other.senior-dev'],
  );
});

test('an unset harness names its Agent in params, or the Vertex whose own Agent keys left it out', () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.harness;
  const red = config.flows.default.ticket.vertices.red;
  delete red.use;
  red.model = 'model-x';
  const unset = exampleLayer.check(config).errors.filter((problem) => problem.code === 'harness-unset');
  assert.deepEqual(unset, [
    {
      at: 'agents.reviewer',
      code: 'harness-unset',
      message: 'agent reviewer names no harness; set one in a user or repository Layer',
      params: { agent: 'reviewer' },
    },
    {
      at: `${VERTICES}.red`,
      code: 'harness-unset',
      message: 'the agent of Vertex red names no harness; set one in a user or repository Layer',
      params: { vertex: 'red' },
    },
  ]);
});

// A value a sentence names is in params even where `at` spells it too, so a program never parses `at` for it.
const NAMED_IN_AT: [string, (config: exampleLayer.Layer) => void, Pick<report.Problem, 'code' | 'params'>][] = [
  [
    'a required input some route may not produce',
    (config) => {
      config.flows.default.ticket.vertices.green.inputs.previous = { from: 'green.commit.files' };
    },
    { code: 'required-input-unsure', params: { input: 'previous', vertex: 'green' } },
  ],
  [
    'an unreachable Vertex',
    (config) => {
      config.flows.default.ticket.vertices.spare = { procedure: 'base-check', route: { ok: { end: 'needs-human' } } };
    },
    { code: 'unreachable-vertex', params: { vertex: 'spare' } },
  ],
  [
    'a table no Claim token reaches',
    (config) => {
      config.procedures['base-check'].stopped = [{ when: {}, outcome: 'x' }];
    },
    { code: 'table-never-applies', params: { table: 'stopped' } },
  ],
  [
    'a table that is not a list',
    (config) => {
      config.procedures['base-check'].passed = 3;
    },
    { code: 'not-a-list', params: { table: 'passed' } },
  ],
];
for (const [what, mutate, expected] of NAMED_IN_AT) {
  test(`a value the sentence names is in params, though at spells it too: ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    const { errors, warnings } = exampleLayer.check(config);
    const found = [...errors, ...warnings].filter((problem) => problem.code === expected.code);
    assert.deepEqual(
      found.map(({ code, params }) => ({ code, params })),
      [expected],
    );
  });
}

test("a Finding takes its code's params as report.error does", () => {
  const problems = report.newReport();
  // @ts-expect-error -- unknown-key's params name the key, so a Finding of it carries them
  report.errorOf(problems, 'agents', { code: 'unknown-key', message: 'unknown key "x"' });
  report.errorOf(problems, 'agents', { code: 'unknown-key', message: 'unknown key "x"', params: { key: 'x' } });
  assert.equal(problems.errors.length, 2);
});
