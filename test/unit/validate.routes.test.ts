import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// Every expected error and warning is a Problem, whose persisted key is `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// A ticket's routes that end every Outcome no Vertex routes at needs-human.
const UNROUTED_NEEDS_HUMAN = { '*': { end: 'needs-human' } };

// The error for an Outcome whose route reaches ready-for-qa without passing the Vertex that runs pr-ready.
const skipsPrReady = (outcome: string) =>
  `Outcome ${outcome} reaches end ready-for-qa on a route that may skip pr-ready; admission checks routes, not runs, ` +
  'so route it through the Vertex that runs pr-ready';

test('a route or entry naming no Vertex is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.entry = 'start';
  config.flows.default.ticket.vertices.green.route.ok = 'review';
  config.flows.default.ticket.vertices.reviewer.route.retest.exhausted = 'senior';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'flows.default.ticket.entry', message: '"start" is not a Vertex' },
    { at: `${VERTICES}.green.route.ok`, message: '"review" is not a Vertex' },
    { at: `${VERTICES}.reviewer.route.retest`, message: '"senior" is not a Vertex' },
  ]);
});

test('an end naming done or no end is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.publish.route.ok = { end: 'done' };
  config.flows.default.ticket.routes['*'] = { end: 'merged' };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket.routes.*',
      message: 'end "merged" is not one of ready-for-qa, needs-human, needs-replan',
    },
    { at: `${VERTICES}.publish.route.ok`, message: 'end "done" is the human-only end, which no route may name' },
  ]);
});

test('an unrouted Outcome is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  delete config.flows.default.ticket.vertices.reviewer.route.repeat;
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.reviewer`, message: "Outcome repeat is not routed by the Vertex or the Flow's routes" },
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket',
      message:
        'the cycle through reviewer, implementer-fix has no edge or Vertex with max; the Action Cap does not bound ' +
        'a cycle',
    },
  ]);
});

test("a cycle through an edge's exhausted target is not bounded by that edge's max", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.reviewer.route.changes = {
    to: 'implementer-fix',
    max: 2,
    exhausted: 'implementer-fix',
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket',
      message:
        'the cycle through reviewer, implementer-fix has no edge or Vertex with max; the Action Cap does not bound ' +
        'a cycle',
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.reviewer`,
      message: skipsPrReady('ok'),
    },
  ]);
});

test('pr-ready in a Procedure whose token requires no Check is an error', () => {
  const config = exampleLayer.config();
  const { publish } = config.procedures;
  publish.actions = publish.actions.filter((action: { id: string }) => action.id !== 'test');
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.publish.actions[1]',
      message: 'pr-ready publishes only after passing Checks, but Claim token ok requires none',
    },
  ]);
});

test('a passing write path without a commit is an error', () => {
  const config = exampleLayer.config();
  const { implement } = config.procedures;
  implement.actions = implement.actions.filter((action: { id: string }) => action.id !== 'commit');
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.green`,
      message:
        'Vertex green writes, so it must commit on every passing path, but procedure implement has no commit Action',
    },
    {
      at: `${VERTICES}.senior-green`,
      message:
        'Vertex senior-green writes, so it must commit on every passing path, but procedure implement has no commit ' +
        'Action',
    },
  ]);
});

test('a write Vertex whose committing token requires no Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.fix.claimTokens.ok.requires = [];
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.implementer-fix`,
      message: 'Vertex implementer-fix writes, so its committing Claim token ok must require a Check',
    },
    {
      at: `${VERTICES}.senior-dev`,
      message: 'Vertex senior-dev writes, so its committing Claim token ok must require a Check',
    },
  ]);
});

test('an unreachable Vertex is a warning', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.orphan = { procedure: 'base-check', route: { ok: 'red' } };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), {
    at: `${VERTICES}.orphan`,
    message: 'Vertex orphan is not reachable from the entry',
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
  assert.deepEqual(errors, [
    {
      at: 'procedures.implement.actions[1]',
      message: 'Check test names command "lint", which the repository Layer does not declare',
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.senior-green.exhausted`,
      message: 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }',
    },
    {
      at: `${VERTICES}.reviewer.route.retest`,
      message: 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }',
    },
    { at: `${VERTICES}.senior-dev.max`, message: 'max must be a positive integer' },
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket.vertices.q',
      message: skipsPrReady('ok'),
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.green.route.bad-test`, message: 'an edge with max names its exhausted target' },
    { at: `${VERTICES}.senior-dev`, message: 'a Vertex with max names its exhausted target' },
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: `${VERTICES}.ship`,
      message: skipsPrReady('blocked'),
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket',
      message: 'the exhausted targets of x, y form a loop: once their Visits reach max, no Vertex is ever entered',
    },
  ]);
});

test('an exhausted target without a bound is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.exhausted = { end: 'needs-human' };
  config.flows.default.ticket.vertices.green.route.ok = { to: 'reviewer', exhausted: { end: 'needs-human' } };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.red`, message: 'a Vertex names exhausted only with max' },
    { at: `${VERTICES}.green.route.ok`, message: 'an edge names exhausted only with max' },
  ]);
});

test("a Flow's graph checks wait only for its own errors and those outside every Flow, in either order", () => {
  const unrouted = {
    plan: null,
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  const misspelt = {
    plan: null,
    actionCap: 20,
    ticket: {
      entry: 'gate',
      vertices: { gate: { procedure: 'base-check', rout: {}, route: { ok: { end: 'needs-human' } } } },
    },
  };
  const first = exampleLayer.config();
  first.flows = { unrouted, misspelt };
  assert.deepEqual(exampleLayer.check(first).errors, [
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      message: "Outcome ok is not routed by the Vertex or the Flow's routes",
    },
    { at: 'flows.misspelt.ticket.vertices.gate', message: 'unknown key "rout"' },
  ]);
  const second = exampleLayer.config();
  second.flows = { misspelt, unrouted };
  assert.deepEqual(exampleLayer.check(second).errors, [
    { at: 'flows.misspelt.ticket.vertices.gate', message: 'unknown key "rout"' },
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      message: "Outcome ok is not routed by the Vertex or the Flow's routes",
    },
  ]);
});

test("an error outside every Flow holds every Flow's graph checks", () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures['base-check'], 'test').command = 'lint';
  config.flows.light = {
    plan: null,
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.base-check.actions[0]',
      message: 'Check test names command "lint", which the repository Layer does not declare',
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket',
      message: 'the exhausted targets of x form a loop: once their Visits reach max, no Vertex is ever entered',
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows.default.ticket',
      message: 'the exhausted targets of a, b form a loop: once their Visits reach max, no Vertex is ever entered',
    },
  ]);
});

test("an Agent's error holds the graph checks of the Flows that use it, and only them", () => {
  const config = exampleLayer.config();
  config.agents.senior.harness = 'other';
  config.agents.spare = { persona: 'implementer.md', harness: 'other' };
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  config.flows.unrouted = {
    plan: null,
    actionCap: 20,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.senior', message: 'agent senior names harness "other", which is not registered' },
    { at: 'agents.spare', message: 'agent spare names harness "other", which is not registered' },
    {
      at: 'flows.unrouted.ticket.vertices.gate',
      message: "Outcome ok is not routed by the Vertex or the Flow's routes",
    },
  ]);
});
