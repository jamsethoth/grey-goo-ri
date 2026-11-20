import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// A ticket's routes that end every Outcome no Vertex routes at needs-human.
const UNROUTED_NEEDS_HUMAN = { '*': { end: 'needs-human' } };

test('a route or entry naming no Vertex is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.entry = 'start';
  config.flows.default.ticket.vertices.green.route.ok = 'review';
  config.flows.default.ticket.vertices.reviewer.route.retest.exhausted = 'senior';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    { at: `${VERTICES}.green.route.ok`, code: 'unknown-vertex' },
    { at: `${VERTICES}.reviewer.route.retest`, code: 'unknown-vertex' },
  ]);
});

test('an end naming done or no end is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.publish.route.ok = { end: 'done' };
  config.flows.default.ticket.routes['*'] = { end: 'merged' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'flows.default.ticket.routes.*',
      code: 'unknown-end',
    },
    { at: `${VERTICES}.publish.route.ok`, code: 'human-only-end' },
  ]);
});

test('an unrouted Outcome is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  delete config.flows.default.ticket.vertices.reviewer.route.repeat;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.reviewer`, code: 'unrouted-outcome' },
  ]);
});

test('the engine Outcomes default to end: needs-human', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.failed, {
    target: { end: 'needs-human' },
    by: 'engine default',
    work: 'left in place',
  });
  assert.deepEqual(flows.default.ticket.vertices.reviewer.routing['harness-timeout'], {
    target: { end: 'needs-human' },
    by: 'engine default',
    work: null,
  });
});

test('a cycle bounded only by the Action Cap is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [{ at: 'flows.default.ticket', code: 'unbounded-cycle' }]);
  assert.deepEqual(errors[0].params, { cycle: ['reviewer', 'implementer-fix'] });
});

test("a cycle through an edge's exhausted target is not bounded by that edge's max", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.route.changes = {
    to: 'implementer-fix',
    max: 2,
    exhausted: 'implementer-fix',
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'flows.default.ticket',
      code: 'unbounded-cycle',
    },
  ]);
});

test('a self-edge with max is a bounded cycle', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.baseline.route.failed = {
    to: 'baseline',
    max: 2,
    exhausted: { end: 'needs-human' },
  };
  assert.deepEqual(exampleLayer.check(config).errors, []);
});

test('an agentless Vertex may be the entry', () => {
  const { errors, flows } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.entry, 'baseline');
  assert.equal(flows.default.ticket.vertices.baseline.agent, null);
});

test('a path to ready-for-qa without pr-ready is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.reviewer`,
      code: 'pr-ready-skippable',
    },
  ]);
});

test('pr-ready in a Procedure whose token requires no Check is an error', () => {
  const config = exampleLayer.config();
  const { publish } = config.procedures;
  publish.actions = publish.actions.filter((action: { id: string }) => action.id !== 'test');
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.publish.actions[1]',
      code: 'pr-ready-without-checks',
    },
  ]);
});

test('a passing write path without a commit is an error', () => {
  const config = exampleLayer.config();
  const { implement } = config.procedures;
  implement.actions = implement.actions.filter((action: { id: string }) => action.id !== 'commit');
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.green`,
      code: 'write-without-commit',
    },
    {
      at: `${VERTICES}.senior-green`,
      code: 'write-without-commit',
    },
  ]);
});

test('a write Vertex whose committing token requires no Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.fix.claimTokens.ok.requires = [];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    // With no Check to fail, the Vertex no longer produces failed, so its failed route is one gg never takes (#436).
    { at: `${VERTICES}.implementer-fix.route.failed`, code: 'unknown-outcome' },
    {
      at: `${VERTICES}.implementer-fix`,
      code: 'commit-without-check',
    },
    {
      at: `${VERTICES}.senior-dev`,
      code: 'commit-without-check',
    },
  ]);
});

test('an unreachable Vertex is a warning', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.orphan = { procedure: 'base-check', route: { ok: 'red' } };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings).at(-1), {
    at: `${VERTICES}.orphan`,
    code: 'unreachable-vertex',
  });
});

test("the example's routing reproduces its admission summary", () => {
  const { errors, warnings, flows } = exampleLayer.check(exampleLayer.config());
  const vertices = flows.default.ticket.vertices;
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.deepEqual(vertices.baseline.routing.failed, { target: { end: 'needs-human' }, by: 'Flow "*"', work: null });
  assert.deepEqual(vertices.red.routing.blocked, {
    target: { end: 'needs-human' },
    by: 'Flow "*"',
    work: 'left in place',
  });
  assert.deepEqual(vertices.red.routing['no-test'], { target: 'green', by: 'Vertex route', work: 'rescued' });
  assert.deepEqual(vertices.green.routing.failed, {
    target: 'senior-green',
    by: 'Vertex route',
    work: 'rescued, or left in place once exhausted',
  });
  assert.deepEqual(vertices.green.routing['bad-test'], {
    target: { to: 'red', max: 1, exhausted: { end: 'needs-human' } },
    by: 'Vertex route',
    work: 'rescued, or left in place once exhausted',
  });
  assert.deepEqual(vertices['implementer-fix'].routing.failed, {
    target: 'senior-dev',
    by: 'Vertex route',
    work: 'rescued, or left in place once exhausted',
  });
  assert.deepEqual(vertices['senior-red'].routing['no-test'], {
    target: 'senior-dev',
    by: 'Vertex route',
    work: 'rescued, or left in place once exhausted',
  });
  assert.deepEqual(vertices.reviewer.routing.misscoped, {
    target: { end: 'needs-replan' },
    by: 'Flow routes',
    work: null,
  });
  assert.deepEqual(vertices.publish.routing.ok, { target: { end: 'ready-for-qa' }, by: 'Vertex route', work: null });
  assert.deepEqual(vertices.publish.routing.failed, { target: { end: 'needs-human' }, by: 'Flow "*"', work: null });
});

// implement's error holds green and senior-green; the cycle through reviewer and implementer-fix reads neither (#449).
test("a cycle among sound Vertices is reported beside another Vertex's Procedure error", () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.implement, 'test').command = 'lint';
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  const { errors, declared } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.implement.actions[1]',
      code: 'undeclared-command',
    },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
  // A Flow with an error at a value it copies is declared only (#391); gg doctor prints its routing.
  assert.deepEqual(declared.default?.ticket.vertices.reviewer?.routing.changes, {
    target: 'implementer-fix',
    by: 'Vertex route',
    work: null,
  });
});

// Where work goes is read from the typed targets, so a Vertex whose routes were refused names none (#454).
test("a Vertex whose route target is refused shows no work for its Outcomes' routing", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.route['bad-test'] = { to: 'nowhere' };
  const { errors, declared } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: `${VERTICES}.green.route.bad-test`, code: 'unknown-vertex' },
  ]);
  assert.deepEqual(declared.default?.ticket.vertices.green?.routing.failed, {
    target: 'senior-green',
    by: 'Vertex route',
    work: null,
  });
});

test('malformed routing is an error, never a throw, in the graph checks', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices['senior-green'].exhausted = ['nowhere'];
  config.flows.default.ticket.vertices.reviewer.route.retest = { to: 'red', max: 2, exhausted: 7 };
  config.flows.default.ticket.vertices['senior-dev'].max = 'one';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.senior-green.exhausted`,
      code: 'malformed-route-target',
    },
    {
      at: `${VERTICES}.reviewer.route.retest`,
      code: 'malformed-route-target',
    },
    { at: `${VERTICES}.senior-dev.max`, code: 'not-a-positive-integer' },
  ]);
});

test("a Vertex's exhausted target is a landing of every route into it", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'q',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      /* eslint-disable id-length -- single-letter Vertex ids, as the expected Problems name them */
      q: { procedure: 'base-check', route: { ok: { to: 'p', max: 1, exhausted: { end: 'needs-human' } } } },
      p: { procedure: 'base-check', max: 1, exhausted: { end: 'ready-for-qa' }, route: { ok: 'q' } },
      /* eslint-enable id-length */
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'flows.default.ticket.vertices.q',
      code: 'pr-ready-skippable',
    },
  ]);
});

test('an explicit Flow route beats the Vertex\'s "*"', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.route['*'] = { end: 'needs-human' };
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.misscoped, {
    target: { end: 'needs-replan' },
    by: 'Flow routes',
    work: 'left in place',
  });
  assert.deepEqual(flows.default.ticket.vertices.red.routing.blocked, {
    target: { end: 'needs-human' },
    by: 'Vertex "*"',
    work: 'left in place',
  });
});

test('a bound without an exhausted target is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.vertices.green.route['bad-test'].exhausted;
  delete config.flows.default.ticket.vertices['senior-dev'].exhausted;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.green.route.bad-test`, code: 'max-without-exhausted' },
    { at: `${VERTICES}.senior-dev`, code: 'max-without-exhausted' },
  ]);
});

test('a Vertex whose Agent sets no access is read-only', () => {
  const config = exampleLayer.config();
  delete config.agents.implementer.access;
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.vertices.red.access, 'read-only');
  assert.equal(flows.default.ticket.vertices.baseline.access, 'read-only');
  assert.equal(flows.default.ticket.vertices['senior-red'].access, 'workspace-write');
});

test('pr-ready counts only from the passed table', () => {
  const config = exampleLayer.config();
  config.procedures.ship = {
    access: 'read-only',
    claimTokens: { ok: { requires: ['test'] }, changes: { requires: ['test'] }, blocked: { stop: true } },
    actions: [
      { id: 'ship', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'test', do: 'check', kind: 'command', command: 'test' },
      { id: 'pr-ready', do: 'pr-ready' },
    ],
  };
  config.flows.default.ticket = {
    entry: 'ship',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      ship: {
        use: 'reviewer',
        procedure: 'ship',
        route: { ok: { end: 'ready-for-qa' }, blocked: { end: 'ready-for-qa' } },
      },
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: `${VERTICES}.ship`,
      code: 'pr-ready-skippable',
    },
  ]);
});

test("a Vertex's own route for an Outcome beats the Flow's", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.route.misscoped = { end: 'needs-human' };
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.misscoped, {
    target: { end: 'needs-human' },
    by: 'Vertex route',
    work: 'left in place',
  });
});

test('a loop of exhausted targets is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'start',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      start: { procedure: 'base-check', route: { ok: 'x' } },
      /* eslint-disable id-length -- single-letter Vertex ids, as the expected Problems name them */
      x: { procedure: 'base-check', max: 1, exhausted: 'y', route: { ok: 'y' } },
      y: { procedure: 'base-check', max: 1, exhausted: 'x', route: { ok: 'x' } },
      /* eslint-enable id-length */
    },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'flows.default.ticket',
      code: 'exhausted-loop',
    },
  ]);
});

test('an exhausted target without a bound is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.exhausted = { end: 'needs-human' };
  config.flows.default.ticket.vertices.green.route.ok = { to: 'reviewer', exhausted: { end: 'needs-human' } };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'exhausted-without-max' },
    { at: `${VERTICES}.green.route.ok`, code: 'exhausted-without-max' },
  ]);
});

test("a Flow's graph checks wait only for its own errors and those outside every Flow, in either order", () => {
  const unrouted = {
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  const misspelt = {
    actionCap: 20,
    ticket: {
      entry: 'gate',
      vertices: { gate: { procedure: 'base-check', rout: {}, route: { ok: { end: 'needs-human' } } } },
    },
  };
  const first = exampleLayer.config();
  first.flows = { unrouted, misspelt };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(first).errors), [
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      code: 'unrouted-outcome',
    },
    { at: 'flows.misspelt.ticket.vertices.gate', code: 'unknown-key' },
  ]);
  const second = exampleLayer.config();
  second.flows = { misspelt, unrouted };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(second).errors), [
    { at: 'flows.misspelt.ticket.vertices.gate', code: 'unknown-key' },
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      code: 'unrouted-outcome',
    },
  ]);
});

// base-check is named by baseline and by gate, so each waits; no other error stands (#449, Q3 A).
test('a Procedure error holds the graph checks of every Vertex naming it, in every Flow', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures['base-check'], 'test').command = 'lint';
  config.flows.light = {
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.base-check.actions[0]',
      code: 'undeclared-command',
    },
  ]);
});

test('a Vertex whose exhausted target is itself is a loop', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'x',
    routes: UNROUTED_NEEDS_HUMAN,
    // eslint-disable-next-line id-length -- a single-letter Vertex id, as the expected Problem names it
    vertices: { x: { procedure: 'base-check', max: 1, exhausted: 'x', route: { ok: { end: 'needs-human' } } } },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'flows.default.ticket',
      code: 'exhausted-loop',
    },
  ]);
});

test('a loop of exhausted targets reached through a tail names only the loop, once', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket = {
    entry: 'start',
    routes: UNROUTED_NEEDS_HUMAN,
    vertices: {
      start: { procedure: 'base-check', route: { ok: 't' } },
      t: { procedure: 'base-check', max: 1, exhausted: 'a', route: { ok: 'a' } },
      /* eslint-disable id-length -- single-letter Vertex ids, as the expected Problems name them */
      a: { procedure: 'base-check', max: 1, exhausted: 'b', route: { ok: 'b' } },
      b: { procedure: 'base-check', max: 1, exhausted: 'a', route: { ok: 'a' } },
      /* eslint-enable id-length */
    },
  };
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [{ at: 'flows.default.ticket', code: 'exhausted-loop' }]);
  assert.deepEqual(errors[0].params, { loop: ['a', 'b'] });
});

// senior's error holds the senior Vertices; the cycle through reviewer and implementer-fix uses neither (#449, Q1 A).
test("an Agent's error holds the graph checks of the Vertices that use it, and only them", () => {
  const config = exampleLayer.config();
  config.agents.senior.harness = 'other';
  config.agents.spare = { persona: 'implementer.md', harness: 'other' };
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  config.flows.unrouted = {
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.senior', code: 'harness-unregistered' },
    { at: 'agents.spare', code: 'harness-unregistered' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      code: 'unrouted-outcome',
    },
  ]);
});

// A route key is held to the Outcomes gg routes by at run time, the Vertex's `outcomes` (#436, Q1 A).
const outcomesOf = (checked: ReturnType<typeof exampleLayer.check>, vertex: string): string[] =>
  checked.declared.default?.ticket.vertices[vertex]?.outcomes ?? [];

test('a route keyed by an Outcome the Procedure cannot produce is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.route.pased = 'reviewer';
  config.flows.default.ticket.vertices.green.route['integrity-violation'] = { end: 'needs-human' };
  config.flows.default.ticket.vertices.baseline.route['harness-timeout'] = { end: 'needs-human' };
  const checked = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(checked.errors), [
    { at: `${VERTICES}.baseline.route.harness-timeout`, code: 'unknown-outcome' },
    { at: `${VERTICES}.green.route.pased`, code: 'unknown-outcome' },
    { at: `${VERTICES}.green.route.integrity-violation`, code: 'unknown-outcome' },
  ]);
  assert.deepEqual(
    checked.errors.map(({ params }) => params),
    [
      { outcome: 'harness-timeout', outcomes: ['ok', 'failed'] },
      { outcome: 'pased', outcomes: outcomesOf(checked, 'green') },
      { outcome: 'integrity-violation', outcomes: outcomesOf(checked, 'green') },
    ],
  );
});

// A default the Rule Table rows leave no input to fall through to is not producible (#436, Q1 A).
test('a route keyed by a default no input falls through to is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.passed.push({ when: {}, outcome: 'catch-all' });
  config.flows.default.ticket.vertices.reviewer.route['catch-all'] = 'publish';
  const checked = exampleLayer.check(config);
  assert.equal(outcomesOf(checked, 'reviewer').includes('changes'), false);
  assert.deepEqual(exampleLayer.firedRules(checked.errors), [
    { at: `${VERTICES}.reviewer.route.changes`, code: 'unknown-outcome' },
  ]);
});

test('a default route keyed by an Outcome no Vertex produces is reported', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.routes.misscope = { end: 'needs-replan' };
  config.flows.default.ticket.routes['harness-timeout'] = { end: 'needs-human' };
  const checked = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(checked.errors), [
    { at: 'flows.default.ticket.routes.misscope', code: 'unknown-outcome' },
  ]);
  const vertices = Object.keys(config.flows.default.ticket.vertices);
  const union = [...new Set(vertices.flatMap((vertex) => outcomesOf(checked, vertex)))];
  assert.deepEqual(checked.errors[0]?.params, { outcome: 'misscope', outcomes: union });
});

test('the example Flow has no unproducible route key', () => {
  const config = exampleLayer.config();
  const checked = exampleLayer.check(config);
  assert.deepEqual(checked.errors, []);
  const { ticket } = config.flows.default;
  const vertices = Object.keys(ticket.vertices);
  const unproducible = vertices.flatMap((vertex) =>
    Object.keys(ticket.vertices[vertex].route ?? {})
      .filter((key) => key !== '*' && !outcomesOf(checked, vertex).includes(key))
      .map((key) => `${vertex}.${key}`),
  );
  const union = new Set(vertices.flatMap((vertex) => outcomesOf(checked, vertex)));
  unproducible.push(...Object.keys(ticket.routes).filter((key) => key !== '*' && !union.has(key)));
  assert.deepEqual(unproducible, []);
});

// Every site that keys a route by Outcome, read from the example: each Vertex's route and each Flow's default routes,
// with "*" exempt at both (#436, Q2 A).
test('every route key site refuses an Outcome nothing produces, and never "*"', () => {
  const config = exampleLayer.config();
  const expected: exampleLayer.FiredRule[] = [];
  for (const [name, declaration] of Object.entries<any>(config.flows)) {
    declaration.ticket.routes = {
      ...declaration.ticket.routes,
      pased: { end: 'needs-human' },
      '*': { end: 'needs-human' },
    };
    expected.push({ at: `flows.${name}.ticket.routes.pased`, code: 'unknown-outcome' });
    for (const [id, vertex] of Object.entries<any>(declaration.ticket.vertices)) {
      vertex.route = { ...vertex.route, pased: { end: 'needs-human' }, '*': { end: 'needs-human' } };
      expected.push({ at: `flows.${name}.ticket.vertices.${id}.route.pased`, code: 'unknown-outcome' });
    }
  }
  const fired = exampleLayer.firedRules(exampleLayer.check(config).errors);
  const sorted = (rules: exampleLayer.FiredRule[]) => rules.map(({ at, code }) => `${code} ${at}`).sort();
  assert.deepEqual(sorted(fired), sorted(expected));
});

// A Vertex whose Procedure is undeclared is reported as that, and its route keys are not held to an empty list.
test('the route keys of a Vertex with an undeclared Procedure are not reported', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.publish.procedure = 'missing';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.publish`, code: 'undeclared-procedure' },
  ]);
});

// A Vertex's route keys wait only on its own Outcome list, so an error elsewhere shows beside them (#436, D3 C).
test('an unrelated error does not hold a misspelt route key', () => {
  const config = exampleLayer.config();
  config.flows.default.actionCap = -1;
  config.flows.default.ticket.vertices.green.route.pased = 'reviewer';
  config.flows.default.ticket.routes.misscope = { end: 'needs-replan' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: `${VERTICES}.green.route.pased`, code: 'unknown-outcome' },
    { at: 'flows.default.ticket.routes.misscope', code: 'unknown-outcome' },
  ]);
});

// reviewer's Outcomes, and so the union the Flow's default keys are held to, are unknown while review has an error.
test('a Vertex whose Procedure has an error holds only its own route keys, and the Flow defaults', () => {
  const config = exampleLayer.config();
  config.procedures.review.passed = 7;
  config.flows.default.ticket.vertices.green.route.pased = 'reviewer';
  config.flows.default.ticket.vertices.reviewer.route.chanegs = 'publish';
  config.flows.default.ticket.routes.misscope = { end: 'needs-replan' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.review.passed', code: 'not-a-list' },
    { at: `${VERTICES}.green.route.pased`, code: 'unknown-outcome' },
  ]);
});

test("a null Rule Table holds its Vertices' route keys and the Flow defaults, not an unrelated Vertex's", () => {
  const config = exampleLayer.config();
  config.procedures.review.passed = null;
  config.flows.default.actionCap = -1;
  config.flows.default.ticket.vertices.green.route.pased = 'reviewer';
  // repeat is an Outcome only review produces.
  config.flows.default.ticket.routes.repeat = { end: 'needs-human' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.review.passed', code: 'null-value' },
    { at: 'procedures.review.passed', code: 'not-a-list' },
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: `${VERTICES}.green.route.pased`, code: 'unknown-outcome' },
  ]);
});

// A table too large to analyse drops its default from the Outcome list, so its Procedure holds its Vertices' keys.
test("a Rule Table too large to analyse holds its Vertices' route keys, not a real key's report", () => {
  const config = exampleLayer.config();
  const files = exampleLayer.schemas();
  const values = Array.from({ length: 200 }, (_, i) => `v${i}`);
  for (const field of ['e1', 'e2']) {
    exampleLayer.putAt(files['review.schema.json'], ['properties', field], { type: 'string', enum: values });
    files['review.schema.json'].required!.push(field);
    for (const value of values.slice(1))
      config.procedures.review.passed.push({ when: { [`response.${field}`]: value }, outcome: 'retest' });
  }
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config, files).errors), [
    { at: 'procedures.review.passed', code: 'rule-table-too-large' },
  ]);
});

// A route target changes no Outcome, so an error there holds none of the Vertex's keys (D2 A).
test('a route target naming no Vertex does not hold a misspelt key beside it', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.route.pased = 'reviewer';
  config.flows.default.ticket.vertices.green.route.failed = 'nosuch';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.green.route.failed`, code: 'unknown-vertex' },
    { at: `${VERTICES}.green.route.pased`, code: 'unknown-outcome' },
  ]);
});
