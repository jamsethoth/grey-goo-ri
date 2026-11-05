import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as report from '../../lib/validate/report.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// Every expected error and warning is a Problem, whose persisted key is `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('a Claim enum that differs from the declared tokens is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].claimTokens.stuck = { stop: true };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.tests-fail.claimTokens',
      message:
        'red.schema.json: claim: enum "ok" | "blocked" does not equal the declared tokens "ok" | "blocked" | "stuck"',
    },
  ]);
});

test('a schema outside the strict subset is an error naming the file', () => {
  const files = exampleLayer.schemas();
  files['review.schema.json'].properties.summary = { type: 'string', minLength: 1 };
  assert.deepEqual(exampleLayer.check(exampleLayer.config(), files).errors, [
    {
      at: 'procedures.review.actions[0]',
      message: 'review.schema.json: (root).summary: keyword "minLength" is outside the strict subset',
    },
  ]);
});

test('a schema that cannot be read is an error naming the file', () => {
  const files = exampleLayer.schemas();
  delete files['review.schema.json'];
  assert.deepEqual(exampleLayer.check(exampleLayer.config(), files).errors, [
    {
      at: 'procedures.review.actions[0]',
      message: 'schema review.schema.json cannot be read: no such file',
    },
  ]);
});

test('an undeclared command is an error naming the Check', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.implement, 'test').command = 'lint';
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.implement.actions[1]',
      message: 'Check test names command "lint", which the repository Layer does not declare',
    },
  ]);
});

test('a reference to a field the schema lacks is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'response.cause': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'reviewer.review.response.issues';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'procedures.tests-fail.stopped[0]', message: '"response.cause" is not defined' },
    { at: `${VERTICES}.red.inputs.findings`, message: '"reviewer.review.response.issues" is not defined' },
  ]);
});

test("a reference through an Action the Vertex's Procedure lacks is an error", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.inputs.testFiles.from = ['red.commits.files', 'senior-red.commit.files'];
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.green.inputs.testFiles`, message: '"red.commits.files": "red.commits" is not defined' },
  ]);
});

test('a malformed reference path is the same error in a rule field and an input', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'a..b': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'a..b';
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(errors, [
    { at: 'procedures.tests-fail.stopped[0]', message: '"a..b" has an empty segment' },
    { at: `${VERTICES}.red.inputs.findings`, message: '"a..b" has an empty segment' },
  ]);
});

test('a list input with sources of different types is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.inputs.report.from = ['green.green.response', 'red.red.response'];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.reviewer.inputs.report`,
      message: 'sources "green.green.response" and "red.red.response" have different types',
    },
  ]);
});

test('pick on a source that is not a list of objects is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.testFiles = {
    from: 'reviewer.review.response.summary',
    pick: 'file',
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.implementer-fix.inputs.testFiles`,
      message: 'pick needs a list of objects; "reviewer.review.response.summary" is {"kind":"string"}',
    },
  ]);
});

test('tests: named reading anything but a list of strings is an error', () => {
  const config = exampleLayer.config();
  config.procedures.fix.tests.named = 'inputs.findings';
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.implementer-fix (procedure fix).tests`,
      message: 'tests: named must read a list of strings; "inputs.findings" is {"kind":"list","of":{"kind":"object"}}',
    },
    {
      at: `${VERTICES}.senior-dev (procedure fix).tests`,
      message: 'tests: named must read a list of strings; "inputs.findings" is {"kind":"list","of":{"kind":"object"}}',
    },
  ]);
});

test('a Check parameter of the wrong type is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures['tests-fail'], 'red-check').testNames = 'response.summary';
  procedureActions.actionById(config.procedures.review, 'repeat').fields = ['file', 'line'];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.tests-fail.actions[1]',
      message: 'testNames must read a list of strings; "response.summary" is {"kind":"string"}',
    },
    { at: 'procedures.review.actions[2]', message: 'fields: "line" is not a field of the list\'s items' },
  ]);
});

test('a response Check condition outside the schema or its values is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = {
    field: 'definitionOfDoneMet',
    is: 'yes',
  };
  procedureActions.actionById(config.procedures.review, 'review-pass').allOf[2].where = {
    severity: ['blocker', 'critical'],
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.review.actions[1]',
      message: 'allOf[0]: "definitionOfDoneMet" is a boolean, so is must be true or false',
    },
    {
      at: 'procedures.review.actions[1]',
      message: 'allOf[2]: where "severity": "critical" is not one of blocker | major | minor',
    },
  ]);
});

test('a rule on a free-text field is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'response.summary': 'x' };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.tests-fail.stopped[0]',
      message: 'rule field "response.summary" is {"kind":"string"}; rules match only enum, boolean and integer fields',
    },
  ]);
});

test('a malformed rule condition is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.passed[1].when = { 'check.repeat': { '!=': 'passed' } };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.review.passed[1]',
      message:
        'condition on "check.repeat" must be a string, boolean or integer, or an object of <, <=, >, >=, = with ' +
        'integers',
    },
  ]);
});

test('a condition that does not fit its field is an error', () => {
  const config = exampleLayer.config();
  config.procedures.implement.passed = [{ when: { pass: 'two' }, outcome: 'ok' }];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.implement.passed[0]',
      message: 'condition "two" on "pass" does not fit its field, which is {"kind":"integer","min":1,"max":2}',
    },
  ]);
});

test('a row that never fires is an error from the rule table analysis', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped.push({ when: { 'response.reason': 'misscoped' }, outcome: 'again' });
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.tests-fail.stopped',
      message: 'rule table tests-fail.stopped: row 3 (again) never fires: earlier rows match every input it matches',
    },
  ]);
});

test('a passed row on a required Check failing is unreachable', () => {
  const config = exampleLayer.config();
  config.procedures.implement.passed = [{ when: { 'check.test': 'failed' }, outcome: 'odd' }];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.implement.passed',
      message: 'rule table implement.passed: row 1 (odd) is unreachable: it matches no input',
    },
  ]);
});

test('a failed table in a Procedure whose tokens require no Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.failed = [{ when: { 'check.repeat': 'failed' }, outcome: 'repeat' }];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.review.failed',
      message: 'no Claim token requires a Check, so the failed table never applies',
    },
  ]);
});

test('a rule on an input is typed at each Vertex using the Procedure', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.needsTest = {
    from: 'reviewer.review.response.needsTest',
    optional: true,
  };
  config.procedures.fix.passed = [{ when: { 'inputs.needsTest': true }, outcome: 'ok' }];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.senior-dev (procedure fix).passed[0]`,
      message: '"inputs.needsTest" is not defined',
    },
  ]);
});

// Each malformed edit, named for the case, with the errors it gives.
const MALFORMED: [string, (config: exampleLayer.Layer) => void, report.Problem[]][] = [
  [
    'a Procedure that is null',
    (config) => {
      config.procedures.publish = null;
    },
    [{ at: 'procedures.publish', message: 'a Procedure must be an object' }],
  ],
  [
    'actions that are a number',
    (config) => {
      config.procedures.publish.actions = 3;
    },
    [{ at: 'procedures.publish', message: 'actions must be a non-empty list' }],
  ],
  [
    'requires that is a number',
    (config) => {
      config.procedures.implement.claimTokens.ok.requires = 3;
    },
    [
      {
        at: 'procedures.implement.claimTokens.ok',
        message: 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }',
      },
    ],
  ],
  [
    'repeat fields that are a boolean',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'repeat').fields = true;
    },
    [{ at: 'procedures.review.actions[2]', message: 'fields must be a non-empty list of field names' }],
  ],
  [
    'a table row that is null',
    (config) => {
      config.procedures.review.passed[0] = null;
    },
    [{ at: 'procedures.review.passed[0]', message: 'a row is { when: { <field>: <condition> }, outcome: <name> }' }],
  ],
  [
    'routes that are a list',
    (config) => {
      config.flows.default.ticket.routes = [];
    },
    [{ at: 'flows.default.ticket.routes', message: 'routes must be an object from Outcome to target' }],
  ],
  [
    'inputs that are a number',
    (config) => {
      config.flows.default.ticket.vertices.red.inputs = 12;
    },
    [{ at: `${VERTICES}.red.inputs`, message: 'inputs must be an object from name to { from, optional?, pick? }' }],
  ],
  [
    'an Agent that is a string',
    (config) => {
      config.agents.reviewer = 'reviewer.md';
    },
    [{ at: 'agents.reviewer', message: 'an Agent must be an object' }],
  ],
  [
    'flows given as a list',
    (config) => {
      config.flows = [];
    },
    [{ at: 'flows', message: 'flows must be an object from name to Flow' }],
  ],
  [
    'an Action kind given as a list',
    (config) => {
      const { publish } = config.procedures;
      publish.actions = publish.actions.map((action: { id: string }) =>
        action.id === 'pr-ready' ? { id: 'ready', do: ['pr-ready'] } : action,
      );
    },
    [
      {
        at: 'procedures.publish.actions[2]',
        message:
          'do ["pr-ready"] is not one of agent, check, commit, push, pr-upsert, pr-ready, comment, await-approval',
      },
    ],
  ],
  [
    'a Check kind given as a list',
    (config) => {
      procedureActions.actionById(config.procedures['base-check'], 'test').kind = ['command'];
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        message: 'Check kind ["command"] is not one of command, tests-fail, response, repeat',
      },
    ],
  ],
  [
    'a command given as a list',
    (config) => {
      procedureActions.actionById(config.procedures['base-check'], 'test').command = ['test'];
    },
    [
      {
        at: 'procedures.base-check.actions[0]',
        message: 'Check test names command ["test"], which the repository Layer does not declare',
      },
    ],
  ],
  [
    'a Procedure name given as a list',
    (config) => {
      config.flows.default.ticket.vertices.publish.procedure = ['publish'];
    },
    [{ at: `${VERTICES}.publish`, message: 'procedure ["publish"] is not declared' }],
  ],
  [
    'a harness given as a list',
    (config) => {
      config.agents.reviewer.harness = ['fake'];
    },
    [{ at: 'agents.reviewer', message: 'agent reviewer names harness ["fake"], which is not registered' }],
  ],
];
for (const [what, mutate, errors] of MALFORMED) {
  test(`malformed configuration is an error, never a throw: ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    assert.deepEqual(exampleLayer.check(config).errors, errors);
  });
}

test(
  'a passed row on a Check its token requires failing is unreachable ' + 'even when another token requires nothing',
  () => {
    const config = exampleLayer.config();
    config.procedures.implement.claimTokens.partial = { requires: [] };
    config.procedures.implement.passed = [{ when: { claim: 'ok', 'check.test': 'failed' }, outcome: 'odd' }];
    const files = exampleLayer.schemas();
    files['implement.schema.json'].properties.claim.enum = ['ok', 'blocked', 'partial'];
    config.procedures.fix.claimTokens.partial = { requires: [] };
    assert.deepEqual(exampleLayer.check(config, files).errors, [
      {
        at: 'procedures.implement.passed',
        message: 'rule table implement.passed: row 1 (odd) is unreachable: it matches no input',
      },
    ]);
  },
);

test("a failed row on its token's only required Check passing is unreachable", () => {
  const config = exampleLayer.config();
  config.procedures.implement.failed = [{ when: { 'check.test': 'passed' }, outcome: 'odd' }];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.implement.failed',
      message: 'rule table implement.failed: row 1 (odd) is unreachable: it matches no input',
    },
  ]);
});

test('a token whose every passing case a row maps away is not an Outcome', () => {
  const config = exampleLayer.config();
  config.procedures.implement.claimTokens.partial = { requires: ['test'] };
  config.procedures.implement.passed = [{ when: { claim: 'ok' }, outcome: 'done-ish' }];
  const files = exampleLayer.schemas();
  files['implement.schema.json'].properties.claim.enum = ['ok', 'blocked', 'partial'];
  config.procedures.fix.claimTokens.partial = { requires: ['test'] };
  config.flows.default.ticket.routes['done-ish'] = 'reviewer';
  const { errors, flows } = exampleLayer.check(config, files);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.green.outcomes, [
    'done-ish',
    'partial',
    'failed',
    'misscoped',
    'bad-test',
    'blocked',
    'harness-timeout',
    'harness-transient',
    'harness-unparsed',
  ]);
});

test('engine outputs have their fields: rescue, evidence and cleanup', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.inputs.previous.from = 'green.rescue.ref';
  config.flows.default.ticket.vertices.green.inputs.red.from = [
    'red.red-check.evidence.output',
    'senior-red.red-check.cleanup.confirmed',
  ];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.green.inputs.red`,
      message:
        'sources "red.red-check.evidence.output" and "senior-red.red-check.cleanup.confirmed" have different types',
    },
  ]);
});

test("a rescue and a Check's evidence are different types", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.inputs.previous.from = ['green.rescue', 'green.test.evidence'];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.green.inputs.previous`,
      message: 'sources "green.rescue" and "green.test.evidence" have different types',
    },
  ]);
});

test('schemas that differ only in the order of required or enum are one type', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.fix, 'fix').schema = 'fix.schema.json';
  const files = exampleLayer.schemas();
  files['fix.schema.json'] = structuredClone(files['implement.schema.json']);
  files['fix.schema.json'].required.reverse();
  files['fix.schema.json'].properties.reason.enum.reverse();
  assert.deepEqual(exampleLayer.check(config, files).errors, []);
});

test("a Check's evidence and a response object of the same fields are one type", () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.fix, 'fix').schema = 'fix.schema.json';
  const files = exampleLayer.schemas();
  files['fix.schema.json'] = structuredClone(files['implement.schema.json']);
  files['fix.schema.json'].properties.output = {
    type: 'object',
    properties: { command: { type: 'string' }, output: { type: 'string' }, foundByNameOnly: { type: 'boolean' } },
    required: ['command', 'output', 'foundByNameOnly'],
    additionalProperties: false,
  };
  files['fix.schema.json'].required.push('output');
  config.flows.default.ticket.vertices.green.inputs.red.from = [
    'red.red-check.evidence',
    'implementer-fix.fix.response.output',
  ];
  config.flows.default.ticket.vertices.reviewer.inputs.report.from = [
    'green.green.response',
    'senior-green.green.response',
  ];
  config.flows.default.ticket.vertices['implementer-fix'].inputs.report.from = ['green.green.response'];
  config.flows.default.ticket.vertices['senior-dev'].inputs.report.from = ['green.green.response'];
  config.flows.default.ticket.vertices.publish.inputs.report.from = ['green.green.response'];
  assert.deepEqual(exampleLayer.check(config, files).errors, []);
});

test('a row partly taken only across Claim tokens is warned once', () => {
  const config = exampleLayer.config();
  // In token ok's inputs row 1 takes all of row 2; in token changes' row 2 is free. Together it is partly taken.
  config.procedures.review.passed = [
    { when: { claim: 'ok' }, outcome: 'ok' },
    { when: {}, outcome: 'other' },
  ];
  // The reviewer still loops back, so the Flow's inputs keep a producing path; with no changes, implementer-fix is cut
  // off.
  config.flows.default.ticket.vertices.reviewer.route.other = { to: 'red', max: 2, exhausted: 'senior-red' };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    {
      at: 'procedures.review.passed',
      message:
        'rule table review.passed: row 2 (no conditions) is partly taken by row 1 (claim = ok), for example ' +
        '{"claim":"ok"}',
    },
    { at: `${VERTICES}.implementer-fix`, message: 'Vertex implementer-fix is not reachable from the entry' },
  ]);
});

// A reference gg reads at run time is typed as it is read (refs.read): into a list only by length or an index.
test('a with alias that steps into a list of objects is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.fix, 'pr').with.files = 'inputs.findings.file';
  const { errors } = exampleLayer.check(config, exampleLayer.schemas(), exampleLayer.templates());
  assert.deepEqual(errors, [
    {
      at: `${VERTICES}.implementer-fix (procedure fix).actions[4]`,
      message:
        '"inputs.findings.file": "inputs.findings" is a list, so a path reads only its length or an item by index',
    },
    {
      at: `${VERTICES}.senior-dev (procedure fix).actions[4]`,
      message:
        '"inputs.findings.file": "inputs.findings" is a list, so a path reads only its length or an item by index',
    },
  ]);
});

test('an input source that steps into a list of objects is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.testFiles = {
    from: 'reviewer.review.response.findings.file',
  };
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(errors, [
    {
      at: `${VERTICES}.implementer-fix.inputs.testFiles`,
      message:
        '"reviewer.review.response.findings.file": "reviewer.review.response.findings" is a list, so a path reads ' +
        'only its length or an item by index',
    },
  ]);
});

// The review schema with an object and a list of objects inside each finding.
function nestedFindings() {
  const files = exampleLayer.schemas();
  const { items } = files['review.schema.json'].properties.findings;
  items.properties.detail = {
    type: 'object',
    properties: { severity: { type: 'string', enum: ['major', 'minor'] } },
    required: ['severity'],
    additionalProperties: false,
  };
  items.properties.details = {
    type: 'array',
    items: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
      additionalProperties: false,
    },
  };
  items.required.push('detail', 'details');
  return files;
}

test('a response condition list that steps into a list of objects is an error', () => {
  const config = exampleLayer.config();
  const { review } = config.procedures;
  review.actions = review.actions.map((action: { id: string }) =>
    action.id === 'review-pass'
      ? { id: 'review-pass', do: 'check', kind: 'response', none: 'findings.detail', where: { severity: 'major' } }
      : action,
  );
  const { errors } = exampleLayer.check(config, nestedFindings());
  assert.deepEqual(errors, [
    {
      at: 'procedures.review.actions[1]',
      message: '"findings.detail": "findings" is a list, so a path reads only its length or an item by index',
    },
  ]);
});

test('a where field or repeat field is one field of each item, not a path', () => {
  const config = exampleLayer.config();
  const { review } = config.procedures;
  review.actions = review.actions.map((action: { id: string }) =>
    action.id === 'review-pass'
      ? { id: 'review-pass', do: 'check', kind: 'response', none: 'findings', where: { 'detail.severity': 'major' } }
      : action,
  );
  procedureActions.actionById(config.procedures.review, 'repeat').fields = ['file', 'detail.severity'];
  const { errors } = exampleLayer.check(config, nestedFindings());
  assert.deepEqual(errors, [
    { at: 'procedures.review.actions[1]', message: 'where: "detail.severity" is not a field of the list\'s items' },
    { at: 'procedures.review.actions[2]', message: 'fields: "detail.severity" is not a field of the list\'s items' },
  ]);
});

test('a pick that steps into a list inside each item is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.details = {
    from: 'reviewer.review.response.findings',
    pick: 'details.file',
  };
  const { errors } = exampleLayer.check(config, nestedFindings());
  assert.deepEqual(errors, [
    {
      at: `${VERTICES}.implementer-fix.inputs.details`,
      message: 'pick: "details.file": "details" is a list, so a path reads only its length or an item by index',
    },
  ]);
});

test("an input may read a repeat Check's Findings Hash", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.findingsHash = {
    from: 'reviewer.repeat.findingsHash',
    optional: true,
  };
  assert.deepEqual(exampleLayer.check(config).errors, []);
});
