import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// #116 (Y20, L2): every name a template reads resolves in the scope of each Vertex that uses it.
test('a template that names an undeclared input is an error at its Action', () => {
  const { errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.templates({ 'green.md': 'tests: {{#inputs.testFiles}}{{.}}{{/inputs.testFiles}}\n{{inputs.nope}}\n' }),
  );
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.green (procedure implement).actions[0]`,
      code: 'undefined-reference',
    },
    {
      at: `${VERTICES}.senior-green (procedure implement).actions[0]`,
      code: 'undefined-reference',
    },
  ]);
});

test('a template may name gg context, own outputs, inputs and with aliases', () => {
  const { errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.templates({
      'green.md':
        '{{ticket.title}} {{baseBranch}} {{#commands}}{{name}}: {{command}}{{/commands}} ' +
        '{{#history}}{{text}}{{/history}} {{diff}}\n' +
        '{{#inputs.testFiles}}{{.}}{{/inputs.testFiles}} {{inputs.red.output}} ' +
        '{{#inputs.findings}}{{file}} {{severity}}{{/inputs.findings}}\n' +
        '{{green.response.summary}} {{test.evidence.output}} {{claim}} {{pass}} {{check.test}} ' +
        '{{#inputs.findings.length}}n{{/inputs.findings.length}}\n',
      'pr-body.md':
        '{{report.summary}} {{#report.definitionOfDone}}{{item}} {{#met}}y{{/met}}{{/report.definitionOfDone}} ' +
        '{{red.output}} {{redReport.summary}} {{ticket.number}} ' +
        '{{#provenance}}{{vertex}}{{/provenance}} {{marker}}\n',
      'review-comment.md':
        '{{review.response.summary}} {{#review.response.findings}}{{issue}}{{/review.response.findings}} ' +
        '{{agent.model}} {{marker}}\n',
      'blocked.md': '{{response.summary}} {{outcome}} {{end}} {{reason}} {{marker}}\n',
      'test-fix.md': '{{id}} {{kind}} {{command}} {{output}} {{#failure.passed}}p{{/failure.passed}}\n',
      'recover.md': '{{#sections}}{{.}}{{/sections}} {{ticket.branch}}\n',
    }),
  );
  assert.deepEqual(errors, []);
});

test('a template path that steps into a list of objects is an error, as rendering reads none', () => {
  const { errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.templates({
      'fix.md':
        '{{#inputs.findings}}{{file}}{{/inputs.findings}} {{inputs.findings.length}} {{inputs.findings.file}}\n',
    }),
  );
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.implementer-fix (procedure fix).actions[0]`,
      code: 'reference-into-list',
    },
    {
      at: `${VERTICES}.senior-dev (procedure fix).actions[0]`,
      code: 'reference-into-list',
    },
  ]);
});

test('a comment of a Procedure with no agent Action may not name the Agent', () => {
  const config = exampleLayer.config();
  config.procedures['base-check'].actions.push({ id: 'note', do: 'comment', target: 'ticket', body: 'note.md' });
  const { errors } = exampleLayer.check(
    config,
    exampleLayer.schemas(),
    exampleLayer.templates({ 'note.md': '{{agent.model}} {{marker}}\n' }),
  );
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.baseline (procedure base-check).actions[1]`,
      code: 'undefined-reference',
    },
  ]);
});

test('a template that cannot be read is an error at each Vertex rendering it', () => {
  const templates = exampleLayer.templates();
  delete templates['review.md'];
  const { errors } = exampleLayer.check(exampleLayer.config(), exampleLayer.schemas(), templates);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: `${VERTICES}.reviewer (procedure review).actions[0]`, code: 'template-unreadable' },
  ]);
});

test('a Brief reads the base branch as baseBranch', () => {
  const { errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.templates({ 'green.md': '{{baseBranch}} {{base}}\n' }),
  );
  assert.deepEqual(
    [...new Set(errors.map((problem) => problem.message))],
    ['brief green.md: {{base}}: "base" is not defined'],
  );
});

test("a comment reads its Agent's Persona hash as agent.personaHash", () => {
  const { errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.templates({ 'review-comment.md': '{{agent.personaHash}} {{agent.hash}} {{marker}}\n' }),
  );
  assert.deepEqual(
    [...new Set(errors.map((problem) => problem.message))],
    ['body review-comment.md: {{agent.hash}}: "agent.hash" is not defined'],
  );
});
