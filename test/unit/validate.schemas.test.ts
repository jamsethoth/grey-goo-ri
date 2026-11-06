import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('a Claim enum that differs from the declared tokens is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].claimTokens.stuck = { stop: true };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.tests-fail.claimTokens',
      code: 'claim-enum-mismatch',
    },
  ]);
});

test('a schema outside the strict subset is an error naming the file', () => {
  const files = exampleLayer.schemas();
  files['review.schema.json'].properties.summary = { type: 'string', minLength: 1 };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(exampleLayer.config(), files).errors), [
    {
      at: 'procedures.review.actions[0]',
      code: 'schema-not-strict',
    },
  ]);
});

test('a schema that cannot be read is an error naming the file', () => {
  const files = exampleLayer.schemas();
  delete files['review.schema.json'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(exampleLayer.config(), files).errors), [
    {
      at: 'procedures.review.actions[0]',
      code: 'schema-unreadable',
    },
  ]);
});

test('an undeclared command is an error naming the Check', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.implement, 'test').command = 'lint';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.implement.actions[1]',
      code: 'undeclared-command',
    },
  ]);
});

test('a reference to a field the schema lacks is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'response.cause': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'reviewer.review.response.issues';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.tests-fail.stopped[0]', code: 'undefined-reference' },
    { at: `${VERTICES}.red.inputs.findings`, code: 'undefined-reference' },
  ]);
});

test("a reference through an Action the Vertex's Procedure lacks is an error", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.inputs.testFiles.from = ['red.commits.files', 'senior-red.commit.files'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.green.inputs.testFiles`, code: 'undefined-reference' },
  ]);
});

test('a malformed reference path is the same error in a rule field and an input', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'a..b': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'a..b';
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: 'procedures.tests-fail.stopped[0]', code: 'malformed-reference' },
    { at: `${VERTICES}.red.inputs.findings`, code: 'malformed-reference' },
  ]);
});

test('a list input with sources of different types is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.inputs.report.from = ['green.green.response', 'red.red.response'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.reviewer.inputs.report`,
      code: 'source-types-differ',
    },
  ]);
});

test('pick on a source that is not a list of objects is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.testFiles = {
    from: 'reviewer.review.response.summary',
    pick: 'file',
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.implementer-fix.inputs.testFiles`,
      code: 'not-a-list-of-objects',
    },
  ]);
});

test('tests: named reading anything but a list of strings is an error', () => {
  const config = exampleLayer.config();
  config.procedures.fix.tests.named = 'inputs.findings';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.implementer-fix (procedure fix).tests`,
      code: 'not-a-list-of-strings',
    },
    {
      at: `${VERTICES}.senior-dev (procedure fix).tests`,
      code: 'not-a-list-of-strings',
    },
  ]);
});

test('a Check parameter of the wrong type is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures['tests-fail'], 'red-check').testNames = 'response.summary';
  procedureActions.actionById(config.procedures.review, 'repeat').fields = ['file', 'line'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.tests-fail.actions[1]',
      code: 'not-a-list-of-strings',
    },
    { at: 'procedures.review.actions[2]', code: 'unknown-item-field' },
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
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.review.actions[1]',
      code: 'condition-value-mismatch',
    },
    {
      at: 'procedures.review.actions[1]',
      code: 'condition-value-mismatch',
    },
  ]);
});

test('a rule on a free-text field is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped[0].when = { 'response.summary': 'x' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.tests-fail.stopped[0]',
      code: 'invalid-rule-field',
    },
  ]);
});

test('a malformed rule condition is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.passed[1].when = { 'check.repeat': { '!=': 'passed' } };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.review.passed[1]',
      code: 'invalid-rule-condition',
    },
  ]);
});

test('a condition that does not fit its field is an error', () => {
  const config = exampleLayer.config();
  config.procedures.implement.passed = [{ when: { pass: 'two' }, outcome: 'ok' }];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.implement.passed[0]',
      code: 'rule-condition-mismatch',
    },
  ]);
});

test('a row that never fires is an error from the rule table analysis', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].stopped.push({ when: { 'response.reason': 'misscoped' }, outcome: 'again' });
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.tests-fail.stopped',
      code: 'never-firing-row',
    },
  ]);
});

test('a passed row on a required Check failing is unreachable', () => {
  const config = exampleLayer.config();
  config.procedures.implement.passed = [{ when: { 'check.test': 'failed' }, outcome: 'odd' }];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.implement.passed',
      code: 'unreachable-row',
    },
  ]);
});

test('a failed table in a Procedure whose tokens require no Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.failed = [{ when: { 'check.repeat': 'failed' }, outcome: 'repeat' }];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.review.failed',
      code: 'table-never-applies',
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
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.senior-dev (procedure fix).passed[0]`,
      code: 'undefined-reference',
    },
  ]);
});

// Each malformed edit, named for the case, with the errors it gives.
const MALFORMED: [string, (config: exampleLayer.Layer) => void, exampleLayer.FiredRule[]][] = [
  [
    'a Procedure that is null',
    (config) => {
      config.procedures.publish = null;
    },
    [{ at: 'procedures.publish', code: 'not-an-object' }],
  ],
  [
    'actions that are a number',
    (config) => {
      config.procedures.publish.actions = 3;
    },
    [{ at: 'procedures.publish', code: 'empty-collection' }],
  ],
  [
    'requires that is a number',
    (config) => {
      config.procedures.implement.claimTokens.ok.requires = 3;
    },
    [
      {
        at: 'procedures.implement.claimTokens.ok',
        code: 'malformed-claim-token',
      },
    ],
  ],
  [
    'repeat fields that are a boolean',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'repeat').fields = true;
    },
    [{ at: 'procedures.review.actions[2]', code: 'empty-collection' }],
  ],
  [
    'a table row that is null',
    (config) => {
      config.procedures.review.passed[0] = null;
    },
    [{ at: 'procedures.review.passed[0]', code: 'malformed-row' }],
  ],
  [
    'routes that are a list',
    (config) => {
      config.flows.default.ticket.routes = [];
    },
    [{ at: 'flows.default.ticket.routes', code: 'not-an-object' }],
  ],
  [
    'inputs that are a number',
    (config) => {
      config.flows.default.ticket.vertices.red.inputs = 12;
    },
    [{ at: `${VERTICES}.red.inputs`, code: 'not-an-object' }],
  ],
  [
    'an Agent that is a string',
    (config) => {
      config.agents.reviewer = 'reviewer.md';
    },
    [{ at: 'agents.reviewer', code: 'not-an-object' }],
  ],
  [
    'flows given as a list',
    (config) => {
      config.flows = [];
    },
    [{ at: 'flows', code: 'not-an-object' }],
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
        code: 'unknown-action-kind',
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
        code: 'unknown-check-kind',
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
        code: 'undeclared-command',
      },
    ],
  ],
  [
    'a Procedure name given as a list',
    (config) => {
      config.flows.default.ticket.vertices.publish.procedure = ['publish'];
    },
    [{ at: `${VERTICES}.publish`, code: 'undeclared-procedure' }],
  ],
  [
    'a harness given as a list',
    (config) => {
      config.agents.reviewer.harness = ['fake'];
    },
    [{ at: 'agents.reviewer', code: 'harness-unregistered' }],
  ],
  [
    'recoverable that is a string',
    (config) => {
      procedureActions.actionById(config.procedures['base-check'], 'test').recoverable = 'yes';
    },
    [{ at: 'procedures.base-check.actions[0]', code: 'not-a-boolean' }],
  ],
  [
    'optional that is a string',
    (config) => {
      config.flows.default.ticket.vertices.green.inputs.testFiles.optional = 'yes';
    },
    [{ at: `${VERTICES}.green.inputs.testFiles`, code: 'not-a-boolean' }],
  ],
  [
    'a table that is a number',
    (config) => {
      config.procedures.review.stopped = 3;
    },
    [{ at: 'procedures.review.stopped', code: 'not-a-list' }],
  ],
  [
    'an agent Action with no claimTokens',
    (config) => {
      config.procedures.review.claimTokens = {};
    },
    [
      { at: 'procedures.review.claimTokens', code: 'claim-tokens-missing' },
      { at: 'procedures.review.passed', code: 'table-never-applies' },
      { at: 'procedures.review.stopped', code: 'table-never-applies' },
    ],
  ],
  [
    'a commit with no type',
    (config) => {
      procedureActions.actionById(config.procedures.implement, 'commit').type = '';
    },
    [{ at: 'procedures.implement.actions[2]', code: 'commit-type-unnamed' }],
  ],
  [
    'a brief that names no file',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review').brief = ' ';
    },
    [{ at: 'procedures.review.actions[0]', code: 'file-not-named' }],
  ],
  [
    'a stop comment that names no file',
    (config) => {
      config.procedures.review.claimTokens.blocked.comment = ' ';
    },
    [{ at: 'procedures.review.claimTokens.blocked', code: 'file-not-named' }],
  ],
  [
    'a comment on neither the PR nor the ticket',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'comment').target = 'issue';
    },
    [{ at: 'procedures.review.actions[3]', code: 'invalid-comment-target' }],
  ],
  [
    'otherwise that names nothing',
    (config) => {
      config.procedures.review.otherwise = ' ';
    },
    [{ at: 'procedures.review.otherwise', code: 'invalid-otherwise' }],
  ],
  [
    'a Procedure access other than read-only',
    (config) => {
      config.procedures.review.access = 'workspace-write';
    },
    [{ at: 'procedures.review.access', code: 'invalid-procedure-access' }],
  ],
  [
    'a reuse other than tree',
    (config) => {
      procedureActions.actionById(config.procedures['base-check'], 'test').reuse = 'sha';
    },
    [{ at: 'procedures.base-check.actions[0]', code: 'invalid-reuse' }],
  ],
  [
    'tests that are neither frozen, write nor named',
    (config) => {
      config.procedures.implement.tests = 'open';
    },
    [{ at: 'procedures.implement.tests', code: 'invalid-tests-setting' }],
  ],
  [
    'a recover with no positive max',
    (config) => {
      config.procedures.implement.recover.max = 0;
    },
    [{ at: 'procedures.implement.recover', code: 'malformed-recover' }],
  ],
  [
    'a response condition on a free-text field',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = { field: 'summary', is: 'x' };
    },
    [{ at: 'procedures.review.actions[1]', code: 'invalid-condition-field' }],
  ],
  [
    'an empty allOf',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf = [];
    },
    [{ at: 'procedures.review.actions[1]', code: 'malformed-all-of' }],
  ],
  [
    'a response condition of no known form',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = { is: true };
    },
    [{ at: 'procedures.review.actions[1]', code: 'malformed-condition' }],
  ],
  [
    'a count condition with no operator',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = {
        count: 'findings',
        where: {},
      };
    },
    [{ at: 'procedures.review.actions[1]', code: 'malformed-count' }],
  ],
];
for (const [what, mutate, errors] of MALFORMED) {
  test(`malformed configuration is an error, never a throw: ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), errors);
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
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config, files).errors), [
      {
        at: 'procedures.implement.passed',
        code: 'unreachable-row',
      },
    ]);
  },
);

test("a failed row on its token's only required Check passing is unreachable", () => {
  const config = exampleLayer.config();
  config.procedures.implement.failed = [{ when: { 'check.test': 'passed' }, outcome: 'odd' }];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.implement.failed',
      code: 'unreachable-row',
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
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.green.inputs.red`,
      code: 'source-types-differ',
    },
  ]);
});

test("a rescue and a Check's evidence are different types", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.inputs.previous.from = ['green.rescue', 'green.test.evidence'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.green.inputs.previous`,
      code: 'source-types-differ',
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
  assert.deepEqual(exampleLayer.firedRules(warnings), [
    {
      at: 'procedures.review.passed',
      code: 'overlapping-rows',
    },
    { at: `${VERTICES}.implementer-fix`, code: 'unreachable-vertex' },
  ]);
});

// A reference gg reads at run time is typed as it is read (referencePaths.read): into a list only by length or an
// index.
test('a with alias that steps into a list of objects is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.fix, 'pr').with.files = 'inputs.findings.file';
  const { errors } = exampleLayer.check(config, exampleLayer.schemas(), exampleLayer.templates());
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.implementer-fix (procedure fix).actions[4]`,
      code: 'reference-into-list',
    },
    {
      at: `${VERTICES}.senior-dev (procedure fix).actions[4]`,
      code: 'reference-into-list',
    },
  ]);
});

test('an input source that steps into a list of objects is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.testFiles = {
    from: 'reviewer.review.response.findings.file',
  };
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.implementer-fix.inputs.testFiles`,
      code: 'reference-into-list',
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
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.review.actions[1]',
      code: 'reference-into-list',
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
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: 'procedures.review.actions[1]', code: 'unknown-item-field' },
    { at: 'procedures.review.actions[2]', code: 'unknown-item-field' },
  ]);
});

test('a pick that steps into a list inside each item is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.details = {
    from: 'reviewer.review.response.findings',
    pick: 'details.file',
  };
  const { errors } = exampleLayer.check(config, nestedFindings());
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.implementer-fix.inputs.details`,
      code: 'reference-into-list',
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
