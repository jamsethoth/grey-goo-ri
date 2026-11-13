import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as labels from '../../lib/labels.ts';
import type * as model from '../../lib/model.ts';
import * as procedures from '../../lib/procedures.ts';
import * as exampleLayer from '../support/example-layer.ts';

// The Resolved Flow is built from the values the validator's checks judged (#391, D1 A): each check gives the typed
// value it judged, or gives up by reporting it, so a Flow with no error resolves and one whose copied value was refused
// does not, with no second judgment of the value.

/* eslint-disable id-denylist -- a Problem's key is at */

type Edit = (layer: exampleLayer.Layer, files: ReturnType<typeof exampleLayer.schemas>) => void;

// The review response with an integer field, which only an operator or integer rule condition reads.
const withScore: Edit = (_, files) => {
  exampleLayer.putAt(files, ['review.schema.json', 'properties', 'score'], { type: 'integer' });
  const { required } = files['review.schema.json']!;
  exampleLayer.putAt(
    files,
    ['review.schema.json', 'required'],
    [...(Array.isArray(required) ? required : []), 'score'],
  );
};
const scoreRow =
  (condition: unknown): Edit =>
  (layer, files) => {
    withScore(layer, files);
    layer.procedures.review.passed.unshift({ when: { 'response.score': condition }, outcome: 'retest' });
  };

// Each form a copied value's type allows that the example lacks, in a configuration with no error.
const FORMS: Record<string, Edit> = {
  'an Edge with no max': (layer) => (layer.flows.default.ticket.vertices.red.route.ok = { to: 'green' }),
  'a Vertex whose own Agent keys name its Agent': (layer) => {
    const { red } = layer.flows.default.ticket.vertices;
    delete red.use;
    Object.assign(red, { harness: 'fake', persona: 'implementer.md', access: 'workspace-write' });
  },
  'a stop Claim token with no comment': (layer) => delete layer.procedures['tests-fail'].claimTokens.blocked.comment,
  'an await-approval Action': (layer) => {
    layer.procedures.approval = { actions: [{ id: 'ask', do: 'await-approval' }] };
    layer.flows.default.ticket.vertices.approve = {
      procedure: 'approval',
      route: { approved: { end: 'needs-human' }, rejected: { end: 'needs-replan' } },
    };
  },
  'an integer rule condition': scoreRow(3),
  ...Object.fromEntries(
    procedures.OPERATORS.map((operator) => [`a ${operator} rule condition`, scoreRow({ [operator]: 2 })]),
  ),
};

// The configurations a Flow with no error resolves from: the example, and the example with each form.
function corpus() {
  const example = exampleLayer.check(exampleLayer.config());
  return [
    ['the example', example] as const,
    ...Object.entries(FORMS).map(([form, edit]) => {
      const layer = exampleLayer.config();
      const files = exampleLayer.schemas();
      edit(layer, files);
      return [form, exampleLayer.check(layer, files)] as const;
    }),
  ];
}

for (const [form, checked] of corpus())
  test(`a Flow with no error resolves to the Flow as written, with ${form}`, () => {
    assert.deepEqual(exampleLayer.firedRules(checked.errors), []);
    assert.ok(checked.flows.default, 'the Flow resolves');
    assert.deepEqual(checked.flows.default, checked.declared.default);
  });

type Add = (set: string, form: unknown) => void;
const agentForm = (vertex: model.ResolvedVertexJson) => {
  if (vertex.agent === null) return 'none';
  return vertex.use === null ? 'own' : 'declared';
};
const tokenForm = (token: procedures.ClaimToken) => {
  if (!token.stop) return 'requires';
  return token.comment === undefined ? 'stop' : 'stop with comment';
};

// The forms of a Procedure's values, by the closed set each is drawn from.
function procedureForms(add: Add, proc: procedures.Procedure) {
  for (const action of proc.actions) {
    add('action', action.do);
    if (action.kind !== undefined) add('check', action.kind);
  }
  add('tests', typeof proc.tests === 'string' ? proc.tests : 'named');
  for (const token of Object.values(proc.claimTokens)) add('token', tokenForm(token));
  for (const row of [...proc.passed, ...proc.failed, ...proc.stopped])
    for (const condition of Object.values(row.when))
      if (typeof condition === 'object' && condition !== null)
        Object.keys(condition).forEach((op) => add('condition', op));
      else add('condition', typeof condition);
}

// The forms one Resolved Flow holds, by the closed set each is drawn from.
function formsOf(flow: model.ResolvedFlowJson) {
  const found = new Map<string, Set<unknown>>();
  const add: Add = (set, form) => found.set(set, (found.get(set) ?? new Set()).add(form));
  const target = (value: model.Target) => {
    if (typeof value === 'string') add('target', 'vertex');
    else add('end', value.end);
  };
  const routeTarget = (value: model.RouteTarget) => {
    if (typeof value !== 'object' || !('to' in value)) return target(value);
    add('edge', value.max === undefined ? 'unbounded' : 'bounded');
    target(value.to);
    if (value.exhausted !== undefined) target(value.exhausted);
  };
  Object.values(flow.ticket.routes).forEach(routeTarget);
  for (const vertex of Object.values(flow.ticket.vertices)) {
    Object.values(vertex.route).forEach(routeTarget);
    if (vertex.exhausted !== null) target(vertex.exhausted);
    add('agent', agentForm(vertex));
  }
  for (const proc of Object.values(flow.procedures)) procedureForms(add, proc);
  return found;
}

// Every form of every closed set a copied value's type draws from, so the cases above cannot miss a form the checks
// accept: an end, an Edge with and without max, an Agent of each kind, each Action and Check kind, each tests setting,
// each Claim token form, and each rule condition.
const CLOSED_SETS: Record<string, unknown[]> = {
  target: ['vertex'],
  end: labels.END_STATES,
  edge: ['bounded', 'unbounded'],
  agent: ['none', 'own', 'declared'],
  action: Object.keys(procedures.ACTION_KEYS),
  check: Object.keys(procedures.CHECK_KEYS),
  tests: ['frozen', 'write', 'named'],
  token: ['requires', 'stop', 'stop with comment'],
  condition: ['string', 'boolean', 'number', ...procedures.OPERATORS],
};

test('the Flows with no error hold every form of every closed set a copied value is drawn from', () => {
  const held = new Map<string, Set<unknown>>();
  for (const [, checked] of corpus())
    for (const [set, forms] of formsOf(checked.flows.default!))
      held.set(set, new Set([...(held.get(set) ?? []), ...forms]));
  const missing = Object.entries(CLOSED_SETS).flatMap(([set, forms]) =>
    forms.filter((form) => !held.get(set)?.has(form)).map((form) => `${set}: ${String(form)}`),
  );
  assert.deepEqual(missing, []);
});

// A value its check refuses, each of which a guard of #364 let resolve: the check that reports it is the one that
// types it, so the Flow is only declared.
const REFUSED: Record<string, [Edit, exampleLayer.FiredRule]> = {
  'an actionCap that is not an integer': [
    (layer) => (layer.flows.default.actionCap = 1.5),
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
  ],
  'a Vertex max of 0': [
    (layer) => (layer.flows.default.ticket.vertices['senior-green'].max = 0),
    { at: 'flows.default.ticket.vertices.senior-green.max', code: 'not-a-positive-integer' },
  ],
  "an Edge's max of 0": [
    (layer) => (layer.flows.default.ticket.vertices['senior-green'].route['bad-test'].max = 0),
    { at: 'flows.default.ticket.vertices.senior-green.route.bad-test', code: 'not-a-positive-integer' },
  ],
  'an Edge with max and no exhausted target': [
    (layer) => delete layer.flows.default.ticket.vertices['senior-green'].route['bad-test'].exhausted,
    { at: 'flows.default.ticket.vertices.senior-green.route.bad-test', code: 'max-without-exhausted' },
  ],
  'a route to an undeclared Vertex': [
    (layer) => (layer.flows.default.ticket.vertices.red.route.ok = 'nowhere'),
    { at: 'flows.default.ticket.vertices.red.route.ok', code: 'unknown-vertex' },
  ],
  'a recover max of 0': [
    (layer) => (layer.procedures['tests-fail'].recover.max = 0),
    { at: 'procedures.tests-fail.recover', code: 'malformed-recover' },
  ],
  'an empty rule condition': [
    (layer) => (layer.procedures['tests-fail'].stopped[0].when['response.reason'] = {}),
    { at: 'procedures.tests-fail.stopped[0]', code: 'invalid-rule-condition' },
  ],
};

for (const [what, [edit, fired]] of Object.entries(REFUSED))
  test(`a Flow with ${what} is declared and does not resolve`, () => {
    const layer = exampleLayer.config();
    edit(layer, exampleLayer.schemas());
    const { errors, flows, declared } = exampleLayer.check(layer);
    assert.deepEqual(exampleLayer.firedRules(errors), [fired]);
    assert.ok(declared.default, 'the Flow is declared');
    assert.equal(flows.default, undefined);
  });
