import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as report from '../../lib/validate/report.ts';
import * as exampleLayer from '../support/example-layer.ts';

// A route-map check waits only on the values it reads, so an error elsewhere shows beside it in one run (#449). A case
// asserts which rule fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('a commit no Check guards is reported beside an unrelated error', () => {
  const config = exampleLayer.config();
  config.flows.default.actionCap = -1;
  config.procedures.fix.claimTokens.ok.requires = [];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: `${VERTICES}.implementer-fix.route.failed`, code: 'unknown-outcome' },
    { at: `${VERTICES}.implementer-fix`, code: 'commit-without-check' },
    { at: `${VERTICES}.senior-dev`, code: 'commit-without-check' },
  ]);
});

// Each route-map check's code in lib/validate/graph.ts, read from its source so a new one joins the case below.
const ROUTE_MAP_CODES = report.PROBLEM_CODES.filter((code) =>
  readFileSync(new URL('../../lib/validate/graph.ts', import.meta.url), 'utf8').includes(`'${code}'`),
);

type Layer = exampleLayer.Layer;
const exampleTicket = (config: Layer) => config.flows.default.ticket;

// A change to the example that fires each route-map check.
const ROUTE_MAP_CASES: Record<string, (config: Layer) => void> = {
  'unrouted-outcome': (config) => {
    delete exampleTicket(config).routes['*'];
    exampleTicket(config).routes.blocked = { end: 'needs-human' };
    delete exampleTicket(config).vertices.reviewer.route.repeat;
  },
  'write-without-commit': (config) => {
    const { implement } = config.procedures;
    implement.actions = implement.actions.filter((action: { id: string }) => action.id !== 'commit');
  },
  'commit-without-check': (config) => {
    config.procedures.fix.claimTokens.ok.requires = [];
  },
  'unbounded-cycle': (config) => {
    exampleTicket(config).vertices.reviewer.route.changes = 'implementer-fix';
  },
  'exhausted-loop': (config) => {
    Object.assign(exampleTicket(config).vertices.red, { max: 1, exhausted: 'green' });
    Object.assign(exampleTicket(config).vertices.green, { max: 1, exhausted: 'red' });
  },
  'pr-ready-skippable': (config) => {
    exampleTicket(config).vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  },
  'required-input-unsure': (config) => {
    exampleTicket(config).vertices.baseline.inputs = { last: { from: 'green.commit.files' } };
  },
  'optional-input-unsure': (config) => {
    exampleTicket(config).vertices.baseline.inputs = { last: { from: 'green.commit.files', optional: true } };
  },
  'unreachable-vertex': (config) => {
    exampleTicket(config).vertices.orphan = { procedure: 'base-check', route: { ok: 'red' } };
  },
};

// An error none of the route-map checks reads, with its code: the Flow's Action Cap, another Flow's error, a route key
// gg never takes, and a Procedure or Agent no Vertex names (#449, Q3 A).
const UNRELATED_ERRORS: Record<string, { code: string; change: (config: Layer) => void }> = {
  'an Action Cap': {
    code: 'not-a-positive-integer',
    change: (config) => {
      config.flows.default.actionCap = -1;
    },
  },
  "another Flow's error": {
    code: 'unknown-key',
    change: (config) => {
      const gate = { procedure: 'base-check', rout: {}, route: { ok: { end: 'needs-human' } } };
      config.flows.misspelt = { actionCap: 20, ticket: { entry: 'gate', vertices: { gate } } };
    },
  },
  'a route key gg never takes': {
    code: 'unknown-outcome',
    change: (config) => {
      exampleTicket(config).vertices.publish.route.pased = { end: 'needs-human' };
    },
  },
  'a Procedure no Vertex names': {
    code: 'not-a-list',
    change: (config) => {
      config.procedures.spare = { ...structuredClone(config.procedures.fix), passed: 7 };
    },
  },
  'an Agent no Vertex uses': {
    code: 'harness-unregistered',
    change: (config) => {
      config.agents.spare = { persona: 'implementer.md', harness: 'other' };
    },
  },
};

const firedCodes = (config: Layer) => {
  const { errors, warnings } = exampleLayer.check(config);
  return [...errors, ...warnings].map((problem): string => problem.code);
};

// Every route-map check, beside every error that reads none of its values.
test('the whole-map checks run beside an error that cannot change the route map', () => {
  assert.deepEqual(Object.keys(ROUTE_MAP_CASES).sort(), [...ROUTE_MAP_CODES].sort());
  const missed: string[] = [];
  for (const [code, change] of Object.entries(ROUTE_MAP_CASES)) {
    const alone = exampleLayer.config();
    change(alone);
    // The case fires its check alone, so a code missing below is a check the unrelated error held.
    assert.ok(firedCodes(alone).includes(code), code);
    for (const [unrelated, error] of Object.entries(UNRELATED_ERRORS)) {
      const config = exampleLayer.config();
      change(config);
      error.change(config);
      const fired = firedCodes(config);
      assert.ok(fired.includes(error.code), `${unrelated} fires ${error.code}`);
      if (!fired.includes(code)) missed.push(`${code} beside ${unrelated}`);
    }
  }
  assert.deepEqual(missed, []);
});

// The waits that stay are named in docs/interfaces/problems.md, "What one run cannot report".
const routeMapWarnings = (warnings: report.Problem[]) =>
  exampleLayer.firedRules(warnings).filter(({ code }) => ROUTE_MAP_CODES.includes(code));

// reviewer waits on review's error and drops out of the map; the cycle through red and green does not pass it, and the
// one through reviewer and implementer-fix waits with it. The warnings wait while any Vertex does (#449, Q2 A).
test('a Vertex whose Procedure has an error holds the checks that read it, and only those', () => {
  const config = exampleLayer.config();
  config.procedures.review.passed = 7;
  exampleTicket(config).vertices.green.route['bad-test'] = 'red';
  exampleTicket(config).vertices.reviewer.route.changes = 'implementer-fix';
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: 'procedures.review.passed', code: 'not-a-list' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
  assert.deepEqual(errors[1]?.params, { cycle: ['red', 'green'] });
  assert.deepEqual(routeMapWarnings(warnings), []);
});

// reviewer's refused access reads as a write, so implementer-fix, now run by reviewer, waits rather than report a
// commit it may never make; its route keys wait with it. senior-dev's commit is still reported (#449, Q1 A).
test('a Vertex whose Agent has an error holds the checks that read it, and only those', () => {
  const config = exampleLayer.config();
  config.agents.reviewer.access = 'readonly';
  exampleTicket(config).vertices['implementer-fix'].use = 'reviewer';
  config.procedures.fix.claimTokens.ok.requires = [];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.reviewer.access', code: 'unknown-permission-intent' },
    { at: `${VERTICES}.senior-dev`, code: 'commit-without-check' },
  ]);
});

// An error at a Vertex's own key may hide a route, its inputs or its access, so it holds the cycle through the Vertex
// (#449, Q1 A), an Agent key the map never reads among them.
test("an error at a Vertex's own key holds the cycle through it", () => {
  for (const [key, value, code] of [
    ['modle', 'x', 'unknown-key'],
    ['model', 7, 'not-a-string'],
  ] as const) {
    const config = exampleLayer.config();
    exampleTicket(config).vertices.green[key] = value;
    exampleTicket(config).vertices.green.route['bad-test'] = 'red';
    const at = key === 'model' ? `${VERTICES}.green.model` : `${VERTICES}.green`;
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [{ at, code }], key);
  }
});

// A refused bound reads as no bound, so the Vertex whose route holds it waits rather than report a false cycle (#449).
test('a refused bound holds the cycle checks that read its Vertex', () => {
  const config = exampleLayer.config();
  config.flows.default.actionCap = -1;
  exampleTicket(config).vertices.reviewer.route.changes.max = 0;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: `${VERTICES}.reviewer.route.changes`, code: 'not-a-positive-integer' },
  ]);
});

// A cycle and a loop read no entry; what a route guarantees, and so pr-ready and the inputs, starts from it (#449).
test('an entry naming no Vertex holds only the checks that read the entry', () => {
  const config = exampleLayer.config();
  exampleTicket(config).entry = 'nowhere';
  exampleTicket(config).vertices.green.route['bad-test'] = 'red';
  exampleTicket(config).vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: 'flows.default.ticket.entry', code: 'unknown-vertex' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
  assert.deepEqual(routeMapWarnings(warnings), []);
});

// The Flow's other Vertices are checked beside a Procedure none of them names (#449, Q3 A, reversing H6 (b)).
test('a Procedure no Vertex of the Flow names holds none of its checks', () => {
  const config = exampleLayer.config();
  config.procedures.spare = { ...structuredClone(config.procedures.fix), passed: 7 };
  exampleTicket(config).vertices.green.route['bad-test'] = 'red';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.spare.passed', code: 'not-a-list' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
});

// A Vertex the map does not read is no landing, so its refused exhausted target adds no cycle, end or input (#449).
test('a refused exhausted target of a Vertex the map does not read adds nothing to the map', () => {
  const exhaustedAt = [{ at: `${VERTICES}.senior-dev.exhausted`, code: 'malformed-route-target' }];
  const errorsOf = (exhausted: unknown, viaRed: boolean) => {
    const config = exampleLayer.config();
    exampleTicket(config).vertices['senior-dev'].exhausted = exhausted;
    if (viaRed) exampleTicket(config).vertices.red.route['no-test'] = 'senior-dev';
    return exampleLayer.firedRules(exampleLayer.check(config).errors);
  };
  assert.deepEqual(
    {
      cycle: errorsOf({ to: 'reviewer' }, false),
      end: errorsOf({ end: 'ready-for-qa', extra: true }, false),
      input: errorsOf({ to: 'senior-red' }, true),
    },
    { cycle: exhaustedAt, end: exhaustedAt, input: exhaustedAt },
  );
});

// The sound target still lands, so the input it leaves unsure is reported.
test('a sound exhausted target of a mapped Vertex adds its landing to the map', () => {
  const config = exampleLayer.config();
  exampleTicket(config).vertices.red.route['no-test'] = 'senior-dev';
  exampleTicket(config).vertices['senior-dev'].exhausted = 'senior-red';
  const fired = exampleLayer.firedRules(exampleLayer.check(config).errors);
  assert.ok(
    fired.some(({ at, code }) => code === 'required-input-unsure' && at === `${VERTICES}.senior-red.inputs.findings`),
  );
});

// A Vertex that is not an object has no routes the map can read, so the warnings wait (#449, Q2 A).
test('a Vertex that is not an object holds the warnings', () => {
  const config = exampleLayer.config();
  exampleTicket(config).vertices.green = 7;
  assert.deepEqual(routeMapWarnings(exampleLayer.check(config).warnings), []);
});

// A null is refused at its key, so it holds the cycle through its Vertex like any error there (#449, Q1 A, D3 A).
test("a null on a Vertex's own key or its Agent holds the cycle through it", () => {
  for (const [owner, key] of [
    [(config: Layer) => config.agents.implementer, 'model'],
    [(config: Layer) => config.agents.implementer, 'persona'],
    [(config: Layer) => exampleTicket(config).vertices.green, 'effort'],
  ] as const) {
    const config = exampleLayer.config();
    owner(config)[key] = null;
    exampleTicket(config).vertices.green.route['bad-test'] = 'red';
    const [only, ...rest] = exampleLayer.firedRules(exampleLayer.check(config).errors);
    assert.deepEqual([only?.code, rest], ['null-value', []], key);
  }
});

// senior runs no Vertex of the cycle through red and green, so its null holds none of the cycle's checks.
test('a null on an Agent outside a cycle holds none of its checks', () => {
  const config = exampleLayer.config();
  config.agents.senior.model = null;
  exampleTicket(config).vertices.green.route['bad-test'] = 'red';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.senior.model', code: 'null-value' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
});
