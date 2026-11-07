import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';
import type * as report from '../../lib/validate/report.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// Each malformed edit, named for the case, with the errors it gives.
const MALFORMED: [string, (config: exampleLayer.Layer) => void, exampleLayer.FiredRule[]][] = [
  [
    'a Procedure that is null',
    (config) => {
      config.procedures.publish = null;
    },
    [
      { at: 'procedures.publish', code: 'null-value' },
      { at: 'procedures.publish', code: 'not-an-object' },
    ],
  ],
  [
    'actions that are a number',
    (config) => {
      config.procedures.publish.actions = 3;
    },
    [{ at: 'procedures.publish', code: 'not-a-list' }],
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
    [{ at: 'procedures.review.actions[2]', code: 'not-a-list' }],
  ],
  [
    'actions that are empty',
    (config) => {
      config.procedures.publish.actions = [];
    },
    [{ at: 'procedures.publish', code: 'empty-list' }],
  ],
  [
    'repeat fields that are empty',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'repeat').fields = [];
    },
    [{ at: 'procedures.review.actions[2]', code: 'empty-list' }],
  ],
  [
    'repeat fields holding a number',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'repeat').fields = [1];
    },
    [{ at: 'procedures.review.actions[2]', code: 'invalid-name' }],
  ],
  [
    'decisions that are a number',
    (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval', decisions: 3 });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'not-a-list' }],
  ],
  [
    'decisions holding a number',
    (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval', decisions: [1] });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'invalid-name' }],
  ],
  [
    'vertices that are a list',
    (config) => {
      config.flows.default.ticket.vertices = [];
    },
    [
      { at: VERTICES, code: 'not-an-object' },
      { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    ],
  ],
  [
    'a table row that is null',
    (config) => {
      config.procedures.review.passed[0] = null;
    },
    [
      { at: 'procedures.review.passed[0]', code: 'null-value' },
      { at: 'procedures.review.passed[0]', code: 'malformed-row' },
    ],
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
    'an agent Action with claimTokens left out',
    (config) => {
      delete config.procedures.review.claimTokens;
    },
    [
      { at: 'procedures.review.claimTokens', code: 'claim-tokens-missing' },
      { at: 'procedures.review.passed', code: 'table-never-applies' },
      { at: 'procedures.review.stopped', code: 'table-never-applies' },
    ],
  ],
  [
    'claimTokens that are a number',
    (config) => {
      config.procedures.review.claimTokens = 3;
    },
    [
      { at: 'procedures.review.claimTokens', code: 'not-an-object' },
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
    'tests that are an object with no named',
    (config) => {
      config.procedures.implement.tests = {};
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
  [
    'an Action id gg reads as a reference head',
    (config) => {
      procedureActions.actionById(config.procedures['base-check'], 'test').id = 'rescue';
    },
    [{ at: 'procedures.base-check.actions[0]', code: 'reserved-name' }],
  ],
  [
    'an Action that is a number',
    (config) => {
      config.procedures.publish.actions[0] = 3;
    },
    [
      { at: 'procedures.publish.actions[0]', code: 'not-an-object' },
      { at: 'procedures.publish.actions[2]', code: 'pr-ready-without-checks' },
    ],
  ],
  [
    'a pr-upsert with that is a number',
    (config) => {
      procedureActions.actionById(config.procedures.implement, 'pr').with = 3;
    },
    [{ at: 'procedures.implement.actions[4]', code: 'not-an-object' }],
  ],
  [
    'await-approval with no decisions',
    (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval', decisions: [] });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'empty-list' }],
  ],
  [
    'a list condition reading a string',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[2] = { none: 'summary', where: {} };
    },
    [{ at: 'procedures.review.actions[1]', code: 'not-a-list-of-objects' }],
  ],
  [
    'a where that is a number',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[2] = { none: 'findings', where: 3 };
    },
    [{ at: 'procedures.review.actions[1]', code: 'not-an-object' }],
  ],
  [
    'a response condition that is a number',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'review-pass').allOf[0] = 3;
    },
    [{ at: 'procedures.review.actions[1]', code: 'not-an-object' }],
  ],
  [
    'an edge max of zero',
    (config) => {
      config.flows.default.ticket.vertices.reviewer.route.retest.max = 0;
    },
    [{ at: `${VERTICES}.reviewer.route.retest`, code: 'not-a-positive-integer' }],
  ],
  [
    'a ticket that is a number',
    (config) => {
      config.flows.default.ticket = 3;
    },
    [
      { at: 'flows.default.ticket', code: 'not-an-object' },
      { at: VERTICES, code: 'required-key-missing' },
      { at: 'flows.default.ticket.entry', code: 'required-key-missing' },
    ],
  ],
  [
    'no Vertices',
    (config) => {
      config.flows.default.ticket.vertices = {};
    },
    [
      { at: VERTICES, code: 'no-vertex-declared' },
      { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    ],
  ],
  [
    'a Vertex route that is a number',
    (config) => {
      config.flows.default.ticket.vertices.red.route = 3;
    },
    [{ at: `${VERTICES}.red.route`, code: 'not-an-object' }],
  ],
  [
    'a Vertex that is a number',
    (config) => {
      config.flows.default.ticket.vertices.red = 3;
    },
    [{ at: `${VERTICES}.red`, code: 'not-an-object' }],
  ],
  [
    'a Flow that is a number',
    (config) => {
      config.flows.default = 3;
    },
    [{ at: 'flows.default', code: 'not-an-object' }],
  ],
  [
    'procedures that are a number',
    (config) => {
      config.procedures = 3;
    },
    [
      { at: 'procedures', code: 'not-an-object' },
      { at: `${VERTICES}.baseline`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.red`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.green`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.senior-green`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.reviewer`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.senior-red`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.implementer-fix`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.senior-dev`, code: 'undeclared-procedure' },
      { at: `${VERTICES}.publish`, code: 'undeclared-procedure' },
    ],
  ],
  [
    'agents that are a number',
    (config) => {
      config.agents = 3;
    },
    [
      { at: 'agents', code: 'not-an-object' },
      { at: `${VERTICES}.red`, code: 'undeclared-agent' },
      { at: `${VERTICES}.green`, code: 'undeclared-agent' },
      { at: `${VERTICES}.senior-green`, code: 'undeclared-agent' },
      { at: `${VERTICES}.reviewer`, code: 'undeclared-agent' },
      { at: `${VERTICES}.senior-red`, code: 'undeclared-agent' },
      { at: `${VERTICES}.implementer-fix`, code: 'undeclared-agent' },
      { at: `${VERTICES}.senior-dev`, code: 'undeclared-agent' },
    ],
  ],
  [
    'a pick that does not parse, on a source of unknown type',
    (config) => {
      config.flows.default.ticket.vertices.nowhere = 3;
      config.flows.default.ticket.vertices.red.inputs.oddly = { from: 'nowhere.x.y', pick: 'a..b', optional: true };
    },
    [
      { at: `${VERTICES}.red.inputs.oddly`, code: 'malformed-reference' },
      { at: `${VERTICES}.nowhere`, code: 'not-an-object' },
    ],
  ],
  [
    'an input that is a number',
    (config) => {
      config.flows.default.ticket.vertices.red.inputs.oddly = 3;
    },
    [{ at: `${VERTICES}.red.inputs.oddly`, code: 'not-an-object' }],
  ],
  [
    'an input with no sources',
    (config) => {
      config.flows.default.ticket.vertices.red.inputs.oddly = { from: [] };
    },
    [{ at: `${VERTICES}.red.inputs.oddly`, code: 'empty-list' }],
  ],
  [
    'a Claim token that is a number',
    (config) => {
      config.procedures.review.claimTokens.blocked = 3;
    },
    [
      { at: 'procedures.review.claimTokens.blocked', code: 'malformed-claim-token' },
      { at: 'procedures.review.stopped', code: 'table-never-applies' },
    ],
  ],
  [
    'recover on a Procedure with no agent Action',
    (config) => {
      config.procedures.publish.recover = { max: 1, brief: 'recover.md' };
    },
    [{ at: 'procedures.publish.recover', code: 'needs-agent-action' }],
  ],
  [
    'a response Check on a Procedure with no agent Action',
    (config) => {
      config.procedures.publish.actions.splice(1, 0, {
        id: 'said',
        do: 'check',
        kind: 'response',
        field: 'x',
        is: true,
      });
    },
    [{ at: 'procedures.publish.actions[1]', code: 'needs-agent-action' }],
  ],
  [
    'a repeat list reading a string',
    (config) => {
      procedureActions.actionById(config.procedures.review, 'repeat').list = 'response.summary';
    },
    [{ at: 'procedures.review.actions[2]', code: 'not-a-list-of-objects' }],
  ],
];
for (const [what, mutate, errors] of MALFORMED) {
  test(`malformed configuration is an error, never a throw: ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), errors);
  });
}

const LEFT_OUT = 'required-key-missing' as const;
// Each required key left out, with what it reports. The sentence is the behaviour here: it says what to add, and never
// prints "undefined" as though that were a value.
const LEFT_OUT_KEYS: [string, (config: exampleLayer.Layer) => void, report.Problem[]][] = [
  [
    "a Vertex's procedure",
    (config) => {
      delete config.flows.default.ticket.vertices.publish.procedure;
    },
    [{ at: `${VERTICES}.publish`, code: LEFT_OUT, message: 'a Vertex must name a procedure' }],
  ],
  [
    "a ticket's entry",
    (config) => {
      delete config.flows.default.ticket.entry;
    },
    [{ at: 'flows.default.ticket.entry', code: LEFT_OUT, message: 'a ticket must name its entry Vertex' }],
  ],
  [
    "a ticket's vertices",
    (config) => {
      delete config.flows.default.ticket.vertices;
    },
    [
      { at: VERTICES, code: LEFT_OUT, message: 'vertices must be a non-empty object' },
      { at: 'flows.default.ticket.entry', code: 'unknown-vertex', message: '"baseline" is not a Vertex' },
    ],
  ],
  [
    "a Flow's ticket",
    (config) => {
      delete config.flows.default.ticket;
    },
    [
      { at: 'flows.default.ticket', code: LEFT_OUT, message: 'ticket must be an object' },
      { at: VERTICES, code: LEFT_OUT, message: 'vertices must be a non-empty object' },
      { at: 'flows.default.ticket.entry', code: LEFT_OUT, message: 'a ticket must name its entry Vertex' },
    ],
  ],
  [
    "a Flow's actionCap",
    (config) => {
      delete config.flows.default.actionCap;
    },
    [{ at: 'flows.default.actionCap', code: LEFT_OUT, message: 'actionCap must be a positive integer' }],
  ],
  [
    "a Procedure's actions",
    (config) => {
      delete config.procedures.publish.actions;
    },
    [{ at: 'procedures.publish', code: LEFT_OUT, message: 'actions must be a non-empty list' }],
  ],
  [
    "an Action's id",
    (config) => {
      delete procedureActions.actionById(config.procedures.publish, 'pr-ready').id;
    },
    [{ at: 'procedures.publish.actions[2]', code: LEFT_OUT, message: 'an Action must have an id' }],
  ],
  [
    "an Action's do",
    (config) => {
      delete procedureActions.actionById(config.procedures.publish, 'pr-ready').do;
    },
    [{ at: 'procedures.publish.actions[2]', code: LEFT_OUT, message: 'an Action must name its kind in do' }],
  ],
  [
    "a Check's kind",
    (config) => {
      delete procedureActions.actionById(config.procedures['base-check'], 'test').kind;
    },
    [{ at: 'procedures.base-check.actions[0]', code: LEFT_OUT, message: 'a Check must name its kind' }],
  ],
  [
    "a Check's command",
    (config) => {
      delete procedureActions.actionById(config.procedures['base-check'], 'test').command;
    },
    [{ at: 'procedures.base-check.actions[0]', code: LEFT_OUT, message: 'Check test must name a command' }],
  ],
  [
    "a tests-fail Check's testNames",
    (config) => {
      delete procedureActions.actionById(config.procedures['tests-fail'], 'red-check').testNames;
    },
    [{ at: 'procedures.tests-fail.actions[1]', code: LEFT_OUT, message: 'a tests-fail Check must name testNames' }],
  ],
  [
    "a repeat Check's list",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'repeat').list;
    },
    [{ at: 'procedures.review.actions[2]', code: LEFT_OUT, message: 'a repeat Check must name its list' }],
  ],
  [
    "a repeat Check's fields",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'repeat').fields;
    },
    [{ at: 'procedures.review.actions[2]', code: LEFT_OUT, message: 'fields must be a non-empty list of field names' }],
  ],
  [
    "an await-approval's decisions",
    (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval' });
    },
    [{ at: 'procedures.publish.actions[3]', code: LEFT_OUT, message: 'decisions must be a non-empty list of names' }],
  ],
  [
    "a comment's target",
    (config) => {
      delete procedureActions.actionById(config.procedures.review, 'comment').target;
    },
    [{ at: 'procedures.review.actions[3]', code: LEFT_OUT, message: 'target must be pr or ticket' }],
  ],
  [
    "an input's from",
    (config) => {
      config.flows.default.ticket.vertices.red.inputs.oddly = { optional: true };
    },
    [{ at: `${VERTICES}.red.inputs.oddly`, code: LEFT_OUT, message: 'from must name at least one source' }],
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
      { at: 'procedures.base-check.actions[0]', code: LEFT_OUT, message: 'an Action must have an id' },
      { at: 'procedures.base-check.actions[0]', code: LEFT_OUT, message: 'Check with no id must name a command' },
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
      { at: 'procedures.base-check.actions[0]', code: LEFT_OUT, message: 'an Action must have an id' },
      {
        at: 'procedures.base-check.actions[0]',
        code: 'undeclared-command',
        message: 'Check with no id names command "lint", which the repository Layer does not declare',
      },
    ],
  ],
  [
    "a Check's id, when it comes after an effect",
    (config) => {
      config.procedures.publish.actions.push({ do: 'check', kind: 'command', command: 'test' });
    },
    [
      { at: 'procedures.publish.actions[3]', code: LEFT_OUT, message: 'an Action must have an id' },
      {
        at: 'procedures.publish.actions[3]',
        code: 'check-after-effect',
        message:
          'Check with no id comes after pr-upsert Action pr; every Check comes before any effect, so no effect runs ' +
          'before its pass is decided',
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
      { at: 'procedures.publish.actions[1]', code: LEFT_OUT, message: 'an Action must have an id' },
      {
        at: 'procedures.publish.actions[3]',
        code: 'check-after-effect',
        message:
          'Check late comes after pr-upsert Action with no id; every Check comes before any effect, so no effect ' +
          'runs before its pass is decided',
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
      },
    ],
  ],
];

for (const [what, mutate, errors] of LEFT_OUT_KEYS) {
  test(`a required key left out says so: ${what}`, () => {
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
    },
  ]);
});
