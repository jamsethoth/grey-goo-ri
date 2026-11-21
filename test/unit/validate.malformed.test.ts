import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as validate from '../../lib/validate/index.ts';
import * as exampleSource from '../support/example-source.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// Each malformed edit, named for the case, with the errors it gives.
const MALFORMED: [string, (config: exampleSource.Source) => void, exampleSource.FiredRule[]][] = [
  [
    'a Procedure that is null',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish'], null);
    },
    [
      { at: 'procedures.publish', code: 'null-value' },
      { at: 'procedures.publish', code: 'not-an-object' },
    ],
  ],
  [
    'actions that are a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish', 'actions'], 3);
    },
    [{ at: 'procedures.publish', code: 'not-a-list' }],
  ],
  [
    'requires that is a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'implement', 'claimTokens', 'ok', 'requires'], 3);
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
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'repeat'), ['fields'], true);
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
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'repeat'), ['fields'], [1]);
    },
    [{ at: 'procedures.review.actions[2]', code: 'invalid-name' }],
  ],
  [
    'decisions that are a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish', 'actions', '3'], {
        id: 'ask',
        do: 'await-approval',
        decisions: 3,
      });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'not-a-list' }],
  ],
  [
    'decisions holding a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish', 'actions', '3'], {
        id: 'ask',
        do: 'await-approval',
        decisions: [1],
      });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'invalid-name' }],
  ],
  [
    'vertices that are a list',
    (config) => {
      exampleSource.putAt(config, VERTICES.split('.'), []);
    },
    [
      { at: VERTICES, code: 'not-an-object' },
      { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    ],
  ],
  [
    'a table row that is null',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'review', 'passed', '0'], null);
    },
    [
      { at: 'procedures.review.passed[0]', code: 'null-value' },
      { at: 'procedures.review.passed[0]', code: 'malformed-row' },
    ],
  ],
  [
    'routes that are a list',
    (config) => {
      exampleSource.putAt(config, ['flows', 'default', 'ticket', 'routes'], []);
    },
    [{ at: 'flows.default.ticket.routes', code: 'not-an-object' }],
  ],
  [
    'inputs that are a number',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red', 'inputs'], 12);
    },
    [{ at: `${VERTICES}.red.inputs`, code: 'not-an-object' }],
  ],
  [
    'an Agent that is a string',
    (config) => {
      exampleSource.putAt(config, ['agents', 'reviewer'], 'reviewer.md');
    },
    [{ at: 'agents.reviewer', code: 'not-an-object' }],
  ],
  [
    'flows given as a list',
    (config) => {
      exampleSource.putAt(config, ['flows'], []);
    },
    [{ at: 'flows', code: 'not-an-object' }],
  ],
  [
    'an Action kind given as a list',
    (config) => {
      const { publish } = config.procedures;
      exampleSource.putAt(
        publish,
        ['actions'],
        publish.actions.map((action) => (action.id === 'pr-ready' ? { id: 'ready', do: ['pr-ready'] } : action)),
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
      exampleSource.putAt(procedureActions.actionById(config.procedures['base-check'], 'test'), ['kind'], ['command']);
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
      exampleSource.putAt(procedureActions.actionById(config.procedures['base-check'], 'test'), ['command'], ['test']);
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
      exampleSource.putAt(config, [...VERTICES.split('.'), 'publish', 'procedure'], ['publish']);
    },
    [{ at: `${VERTICES}.publish`, code: 'undeclared-procedure' }],
  ],
  [
    'a harness given as a list',
    (config) => {
      exampleSource.putAt(config, ['agents', 'reviewer', 'harness'], ['fake']);
    },
    [{ at: 'agents.reviewer', code: 'invalid-name' }],
  ],
  [
    'recoverable that is a string',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures['base-check'], 'test'), ['recoverable'], 'yes');
    },
    [{ at: 'procedures.base-check.actions[0]', code: 'not-a-boolean' }],
  ],
  [
    'optional that is a string',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'green', 'inputs', 'testFiles', 'optional'], 'yes');
    },
    [{ at: `${VERTICES}.green.inputs.testFiles`, code: 'not-a-boolean' }],
  ],
  [
    'a table that is a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'review', 'stopped'], 3);
    },
    [{ at: 'procedures.review.stopped', code: 'not-a-list' }],
  ],
  [
    'an agent Action with no claimTokens',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'review', 'claimTokens'], {});
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
      exampleSource.putAt(config, ['procedures', 'review', 'claimTokens']);
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
      exampleSource.putAt(config, ['procedures', 'review', 'claimTokens'], 3);
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
      exampleSource.putAt(config, ['procedures', 'implement', 'tests'], {});
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
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '0'], {
        field: 'summary',
        is: 'x',
      });
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
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '0'], {
        is: true,
      });
    },
    [{ at: 'procedures.review.actions[1]', code: 'malformed-condition' }],
  ],
  [
    'a count condition with no operator',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '0'], {
        count: 'findings',
        where: {},
      });
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
      exampleSource.putAt(config, ['procedures', 'publish', 'actions', '0'], 3);
    },
    [
      { at: 'procedures.publish.actions[0]', code: 'not-an-object' },
      { at: 'procedures.publish.actions[2]', code: 'pr-ready-without-checks' },
    ],
  ],
  [
    'a pr-upsert with that is a number',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures.implement, 'pr'), ['with'], 3);
    },
    [{ at: 'procedures.implement.actions[4]', code: 'not-an-object' }],
  ],
  [
    'await-approval with no decisions',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish', 'actions', '3'], {
        id: 'ask',
        do: 'await-approval',
        decisions: [],
      });
    },
    [{ at: 'procedures.publish.actions[3]', code: 'empty-list' }],
  ],
  [
    'a list condition reading a string',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '2'], {
        none: 'summary',
        where: {},
      });
    },
    [{ at: 'procedures.review.actions[1]', code: 'not-a-list-of-objects' }],
  ],
  [
    'a where that is a number',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '2'], {
        none: 'findings',
        where: 3,
      });
    },
    [{ at: 'procedures.review.actions[1]', code: 'not-an-object' }],
  ],
  [
    'a response condition that is a number',
    (config) => {
      exampleSource.putAt(procedureActions.actionById(config.procedures.review, 'review-pass'), ['allOf', '0'], 3);
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
      exampleSource.putAt(config, ['flows', 'default', 'ticket'], 3);
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
      exampleSource.putAt(config, VERTICES.split('.'), {});
    },
    [
      { at: VERTICES, code: 'no-vertex-declared' },
      { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    ],
  ],
  [
    'a Vertex route that is a number',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red', 'route'], 3);
    },
    [{ at: `${VERTICES}.red.route`, code: 'not-an-object' }],
  ],
  [
    'a Vertex that is a number',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red'], 3);
    },
    [{ at: `${VERTICES}.red`, code: 'not-an-object' }],
  ],
  [
    'a Flow that is a number',
    (config) => {
      exampleSource.putAt(config, ['flows', 'default'], 3);
    },
    [{ at: 'flows.default', code: 'not-an-object' }],
  ],
  [
    'procedures that are a number',
    (config) => {
      exampleSource.putAt(config, ['procedures'], 3);
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
      exampleSource.putAt(config, ['agents'], 3);
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
      exampleSource.putAt(config, [...VERTICES.split('.'), 'nowhere'], 3);
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red', 'inputs', 'oddly'], {
        from: 'nowhere.x.y',
        pick: 'a..b',
        optional: true,
      });
    },
    [
      { at: `${VERTICES}.red.inputs.oddly`, code: 'malformed-reference' },
      { at: `${VERTICES}.nowhere`, code: 'not-an-object' },
    ],
  ],
  [
    'an input that is a number',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red', 'inputs', 'oddly'], 3);
    },
    [{ at: `${VERTICES}.red.inputs.oddly`, code: 'not-an-object' }],
  ],
  [
    'an input with no sources',
    (config) => {
      exampleSource.putAt(config, [...VERTICES.split('.'), 'red', 'inputs', 'oddly'], { from: [] });
    },
    [{ at: `${VERTICES}.red.inputs.oddly`, code: 'empty-list' }],
  ],
  [
    'a Claim token that is a number',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'review', 'claimTokens', 'blocked'], 3);
    },
    [
      { at: 'procedures.review.claimTokens.blocked', code: 'malformed-claim-token' },
      { at: 'procedures.review.stopped', code: 'table-never-applies' },
    ],
  ],
  [
    'recover on a Procedure with no agent Action',
    (config) => {
      exampleSource.putAt(config, ['procedures', 'publish', 'recover'], { max: 1, brief: 'recover.md' });
    },
    [{ at: 'procedures.publish.recover', code: 'needs-agent-action' }],
  ],
  [
    'a response Check on a Procedure with no agent Action',
    (config) => {
      const { actions } = config.procedures.publish;
      exampleSource.putAt(
        config,
        ['procedures', 'publish', 'actions'],
        [actions[0], { id: 'said', do: 'check', kind: 'response', field: 'x', is: true }, ...actions.slice(1)],
      );
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
    const config = exampleSource.config();
    mutate(config);
    assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), errors);
  });
}

// The holds read only a key's own check, so a Procedure key read as absent when null would hold nothing (#436, D5).
// Each key counts only at the path its own check reports at: `actions` at the Procedure, every other key at itself.
test('every Procedure key that is null is reported by its own check too', () => {
  const unreported = validate.PROCEDURE_KEYS.filter((key) => {
    const config = exampleSource.config();
    exampleSource.putAt(config, ['procedures', 'review', key], null);
    return !exampleSource
      .check(config)
      .errors.some(
        (problem) =>
          problem.code !== 'null-value' &&
          (key === 'actions' ? problem.at === 'procedures.review' : problem.at.startsWith(`procedures.review.${key}`)),
      );
  });
  assert.deepEqual(unreported, []);
});
