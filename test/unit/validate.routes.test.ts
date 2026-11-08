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
  assert.match(errors[0].message, /^the cycle through reviewer, implementer-fix has /);
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

test('the graph checks wait until no other check fails', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.implement, 'test').command = 'lint';
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.implement.actions[1]',
      code: 'undeclared-command',
    },
  ]);
  assert.deepEqual(flows.default.ticket.vertices.reviewer.routing.changes, {
    target: 'implementer-fix',
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

test("an error outside every Flow holds every Flow's graph checks", () => {
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
  assert.match(errors[0].message, /^the exhausted targets of a, b form a loop/);
});

test("an Agent's error holds the graph checks of the Flows that use it, and only them", () => {
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
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      code: 'unrouted-outcome',
    },
  ]);
});
