import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as util from 'node:util';
import * as agentChecks from '../../lib/validate/agents.ts';
import * as validate from '../../lib/validate/index.ts';
import * as procedureChecks from '../../lib/validate/procedures.ts';
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

// Each route-map check's code in lib/validate/graph.ts and the module only it imports, read from their source so a new
// one joins the case below.
const GRAPH_SOURCES = ['graph.ts', 'route-facts.ts'].map((file) =>
  readFileSync(new URL(`../../lib/validate/${file}`, import.meta.url), 'utf8'),
);
const ROUTE_MAP_CODES = report.PROBLEM_CODES.filter((code) =>
  GRAPH_SOURCES.some((source) => source.includes(`'${code}'`)),
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

// The edge's to is no landing, but its exhausted end still is, so the route past pr-ready is reported (#449; #459).
test('an edge to a Vertex the map does not read keeps its exhausted landing', () => {
  const config = exampleLayer.config();
  const { vertices } = exampleTicket(config);
  vertices.red.route['no-test'] = { to: 'senior-red', max: 1, exhausted: { end: 'ready-for-qa' } };
  vertices['senior-red'].colour = 'blue';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.senior-red`, code: 'unknown-key' },
    { at: `${VERTICES}.red`, code: 'pr-ready-skippable' },
  ]);
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

// red and green, each spent once, name each other as their exhausted target; implementer runs both, so its null holds
// the loop (#454, Q3 A).
test('a null Agent model holds the loop through its Vertex', () => {
  const config = exampleLayer.config();
  Object.assign(exampleTicket(config).vertices.red, { max: 1, exhausted: 'green' });
  Object.assign(exampleTicket(config).vertices.green, { max: 1, exhausted: 'red' });
  config.agents.implementer.model = null;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.implementer.model', code: 'null-value' },
  ]);
});

// implementer-fix's testFiles, unpicked, gives fix's named tests a list of objects in its scope alone, so only
// implementer-fix waits; senior-dev, which runs fix too, keeps the cycle through it (#454, Q2 A).
test("a Procedure error found in one Vertex's input scope holds only that Vertex", () => {
  const config = exampleLayer.config();
  const { vertices } = exampleTicket(config);
  vertices.reviewer.route.changes = 'implementer-fix';
  vertices.reviewer.route.repeat = 'senior-dev';
  delete vertices['senior-dev'].max;
  delete vertices['senior-dev'].exhausted;
  delete vertices['implementer-fix'].inputs.testFiles.pick;
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedAtVertices(errors), [
    { at: 'procedures.fix.tests', code: 'not-a-list-of-strings', flow: 'default', vertex: 'implementer-fix' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
  ]);
  assert.deepEqual(errors[1]?.params, { cycle: ['reviewer', 'senior-dev'] });
});

// A reference to no Action of fix is found with the Procedure alone, so every Vertex running fix waits.
test('a Procedure error found in its references alone holds every Vertex naming it', () => {
  const config = exampleLayer.config();
  const { vertices } = exampleTicket(config);
  vertices.reviewer.route.changes = 'implementer-fix';
  vertices.reviewer.route.repeat = 'senior-dev';
  delete vertices['senior-dev'].max;
  delete vertices['senior-dev'].exhausted;
  config.procedures.fix.actions[4].with.report = 'nowhere.response';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.fix.actions[4]', code: 'undefined-reference' },
  ]);
});

// The checks a key's refusal may hold, each fired by the edits below: seven through green, which implementer runs
// under Procedure implement, and three on the rest of the Flow (#454, Q4 A). No loop runs through green: a Vertex in
// an exhausted loop has a max, which would bound the cycle through it.
const CANARIES = [
  'cycle through green',
  "green's commit",
  "green's write",
  "green's unknown Outcome",
  "green's unrouted Outcome",
  "green's input",
  'pr-ready past green',
  'cycle elsewhere',
  "senior-green's commit",
  'loop through senior-green',
] as const;
type Canary = (typeof CANARIES)[number];
function withCanaries(config: Layer) {
  const { vertices, routes } = exampleTicket(config);
  vertices.green.route['bad-test'] = { to: 'red' };
  // With no Check required, implement has no failed Outcome, so green's route for it is unknown.
  config.procedures.implement.claimTokens.ok.requires = [];
  const { implement } = config.procedures;
  implement.actions = implement.actions.filter((action: { id: string }) => action.id !== 'commit');
  delete routes['*'];
  delete routes.misscoped;
  delete vertices.green.inputs.findings.optional;
  vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  vertices.reviewer.route.changes = 'publish';
  vertices.publish.route.ok = 'reviewer';
  vertices['senior-green'].exhausted = 'senior-red';
  vertices['senior-red'].exhausted = 'senior-green';
  return config;
}
function heldCanaries(errors: report.Problem[]): Canary[] {
  const fired = (code: string, at: string, params?: object) =>
    errors.some(
      (problem) =>
        problem.code === code && problem.at === at && (!params || util.isDeepStrictEqual(problem.params, params)),
    );
  const firing: Record<Canary, boolean> = {
    'cycle through green': fired('unbounded-cycle', 'flows.default.ticket', { cycle: ['red', 'green'] }),
    "green's commit": fired('commit-without-check', `${VERTICES}.green`),
    "green's write": fired('write-without-commit', `${VERTICES}.green`),
    "green's unknown Outcome": fired('unknown-outcome', `${VERTICES}.green.route.failed`),
    "green's unrouted Outcome": fired('unrouted-outcome', `${VERTICES}.green`, { outcome: 'misscoped' }),
    "green's input": fired('required-input-unsure', `${VERTICES}.green.inputs.findings`),
    'pr-ready past green': fired('pr-ready-skippable', `${VERTICES}.reviewer`),
    'cycle elsewhere': fired('unbounded-cycle', 'flows.default.ticket', { cycle: ['reviewer', 'publish'] }),
    "senior-green's commit": fired('commit-without-check', `${VERTICES}.senior-green`),
    'loop through senior-green': fired('exhausted-loop', 'flows.default.ticket', {
      loop: ['senior-green', 'senior-red'],
    }),
  };
  return CANARIES.filter((canary) => !firing[canary]);
}

// reviewer's changes go to publish, so implementer-fix is unreachable: the warnings fire unless a refusal holds them.
test('the canaries fire on the example with no key refused', () => {
  const { errors, warnings } = exampleLayer.check(withCanaries(exampleLayer.config()));
  assert.deepEqual(heldCanaries(errors), []);
  assert.deepEqual(routeMapWarnings(warnings), [{ at: `${VERTICES}.implementer-fix`, code: 'unreachable-vertex' }]);
});

// Each key a route-map check reads, where it sits, a value its own check refuses and the canaries that refusal holds:
// the checks through its Vertex, and only those. A key no check judges is refused only as a null (#454, Q3 A).
type Row = readonly [refusing: unknown, holds: readonly Canary[]];
const THROUGH_GREEN: Canary[] = [
  'cycle through green',
  "green's commit",
  "green's write",
  "green's unknown Outcome",
  "green's unrouted Outcome",
  "green's input",
  'pr-ready past green',
];
// A route target is typed apart and changes no Outcome, so only the map through its Vertex waits (#436, D3 C).
const MAP_THROUGH_GREEN: Canary[] = ['cycle through green', "green's input", 'pr-ready past green'];
// implement runs green and senior-green.
const THROUGH_IMPLEMENT: Canary[] = [...THROUGH_GREEN, "senior-green's commit", 'loop through senior-green'];
// Every Vertex's routes fall back to the Flow's, so the whole map waits, and so does an unrouted Outcome; a commit
// reads no route.
const THROUGH_FLOW_ROUTES: Canary[] = [
  'cycle through green',
  "green's unrouted Outcome",
  "green's input",
  'pr-ready past green',
  'cycle elsewhere',
  'loop through senior-green',
];
const MAP_THROUGH_REVIEWER: Canary[] = ['pr-ready past green', 'cycle elsewhere'];
const THROUGH_SENIOR_GREEN: Canary[] = ["senior-green's commit", 'loop through senior-green'];
const AGENT_KEY_ROWS: Record<string, Row> = {
  harness: [7, THROUGH_GREEN],
  model: [7, THROUGH_GREEN],
  effort: [7, THROUGH_GREEN],
  persona: [7, THROUGH_GREEN],
  skills: [null, THROUGH_GREEN],
  mcp: [null, THROUGH_GREEN],
  plugins: [null, THROUGH_GREEN],
  mode: [null, THROUGH_GREEN],
  access: [7, THROUGH_GREEN],
  network: [7, THROUGH_GREEN],
  resolutionPolicy: [null, THROUGH_GREEN],
  contextBudget: [null, THROUGH_GREEN],
  timeouts: [7, THROUGH_GREEN],
};
const GREEN = ['flows', 'default', 'ticket', 'vertices', 'green'];
const REVIEWER = ['flows', 'default', 'ticket', 'vertices', 'reviewer'];
// A site's keys, each a dotted path under it; `prepare` adds what the site needs to the canaries' example.
interface Site {
  path: string[];
  keys: Record<string, Row>;
  prepare?: (config: Layer) => void;
}
const ROUTE_KEY_SITES: Record<string, Site> = {
  ticket: {
    path: ['flows', 'default', 'ticket'],
    keys: {
      // A cycle reads no entry; what a route guarantees starts from it (#449).
      entry: [7, ["green's input", 'pr-ready past green']],
      routes: [7, THROUGH_FLOW_ROUTES],
      vertices: [7, [...CANARIES]],
    },
  },
  vertex: {
    path: GREEN,
    keys: {
      use: [7, THROUGH_GREEN],
      procedure: [7, THROUGH_GREEN],
      inputs: [7, THROUGH_GREEN],
      route: [7, THROUGH_GREEN],
      max: [0, THROUGH_GREEN],
      exhausted: [7, THROUGH_GREEN],
      ...AGENT_KEY_ROWS,
    },
  },
  edge: {
    path: [...GREEN, 'route', 'bad-test'],
    keys: { to: [7, MAP_THROUGH_GREEN], max: [0, MAP_THROUGH_GREEN], exhausted: [7, MAP_THROUGH_GREEN] },
  },
  input: {
    path: [...GREEN, 'inputs', 'redReport'],
    keys: { from: [7, THROUGH_GREEN], optional: [7, THROUGH_GREEN], pick: [7, THROUGH_GREEN] },
  },
  // implementer runs red, green and implementer-fix; senior runs senior-green.
  agent: { path: ['agents', 'implementer'], keys: AGENT_KEY_ROWS },
  procedure: {
    path: ['procedures', 'implement'],
    keys: {
      tests: [7, THROUGH_IMPLEMENT],
      access: [7, THROUGH_IMPLEMENT],
      claimTokens: [7, THROUGH_IMPLEMENT],
      // With no Actions, implement leaves none of the outputs reviewer and publish read: their inputs are refused too.
      actions: [7, [...CANARIES]],
      recover: [7, THROUGH_IMPLEMENT],
      passed: [7, THROUGH_IMPLEMENT],
      failed: [7, THROUGH_IMPLEMENT],
      stopped: [7, THROUGH_IMPLEMENT],
      otherwise: [7, THROUGH_IMPLEMENT],
    },
  },
};
// The keys the route checks read inside those sites' values. lib/procedures.ts's ACTION_KEYS lists each kind's own
// keys (await-approval's `decisions`), not an Action's `id` and `do`; a route's end and a Rule Table row's keys have no
// list; a Claim token's forms are CLAIM_TOKEN_FORMS, whose `comment` no route check reads, so its rows are the two keys
// the commit checks read, `requires` and `stop`, which sorts the passing tokens (#454, D13).
const NESTED_KEY_SITES: Record<string, Site> = {
  // senior-green and reviewer's repeat edge declare both max and exhausted, so a refused one is their only refusal: on
  // green and its edge, the pair check refuses the other key too (#454, D8).
  'bounded Vertex': {
    path: ['flows', 'default', 'ticket', 'vertices', 'senior-green'],
    keys: { max: [0, THROUGH_SENIOR_GREEN], exhausted: [7, THROUGH_SENIOR_GREEN] },
  },
  'bounded edge': {
    path: [...REVIEWER, 'route', 'repeat'],
    keys: { max: [0, MAP_THROUGH_REVIEWER], exhausted: [7, MAP_THROUGH_REVIEWER] },
  },
  'Flow route': { path: ['flows', 'default', 'ticket', 'routes'], keys: { misscoped: [7, THROUGH_FLOW_ROUTES] } },
  'Vertex route': { path: [...REVIEWER, 'route', 'ok'], keys: { end: [7, MAP_THROUGH_REVIEWER] } },
  // green's edge has no max, so that the cycle through green fires; reviewer's repeat has one.
  'edge exhausted': { path: [...REVIEWER, 'route', 'repeat'], keys: { 'exhausted.end': [7, MAP_THROUGH_REVIEWER] } },
  action: {
    path: ['procedures', 'implement', 'actions', '2'],
    keys: { id: [7, THROUGH_IMPLEMENT], do: [7, THROUGH_IMPLEMENT] },
  },
  'Claim token': {
    path: ['procedures', 'implement', 'claimTokens'],
    keys: { 'ok.requires': [7, THROUGH_IMPLEMENT], 'blocked.stop': [7, THROUGH_IMPLEMENT] },
  },
  row: {
    path: ['procedures', 'implement', 'stopped', '0'],
    keys: { outcome: [7, THROUGH_IMPLEMENT], when: [7, THROUGH_IMPLEMENT] },
  },
  // publish asks, then routes its Decision to reviewer.
  'await-approval': {
    path: ['procedures', 'publish', 'actions', '3'],
    keys: { decisions: [7, ['cycle elsewhere']] },
    prepare: (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval', decisions: ['approved'] });
      exampleTicket(config).vertices.publish.route = { approved: 'reviewer' };
    },
  },
};

test('the table of keys a route check reads holds every key the code declares at each site', () => {
  const keysOf = (site: string) => Object.keys(ROUTE_KEY_SITES[site]!.keys).sort();
  assert.deepEqual(
    {
      ticket: keysOf('ticket'),
      vertex: keysOf('vertex'),
      edge: keysOf('edge'),
      input: keysOf('input'),
      agent: keysOf('agent'),
      procedure: keysOf('procedure'),
    },
    {
      ticket: [...validate.TICKET_KEYS].sort(),
      vertex: [...validate.VERTEX_KEYS, ...validate.AGENT_KEYS].sort(),
      edge: [...validate.EDGE_KEYS].sort(),
      input: [...validate.INPUT_KEYS].sort(),
      agent: [...validate.AGENT_KEYS].sort(),
      procedure: [...validate.PROCEDURE_KEYS].sort(),
    },
  );
});

// Each row of the table, named for its site and key.
const ROUTE_KEY_ROWS = Object.entries({ ...ROUTE_KEY_SITES, ...NESTED_KEY_SITES }).flatMap(
  ([site, { path, keys, prepare }]) =>
    Object.entries(keys).map(([key, [refusing, holds]]) => ({
      name: `${site} ${key}`,
      site: path,
      key: key.split('.'),
      refusing,
      holds,
      prepare,
    })),
);
type KeyRow = (typeof ROUTE_KEY_ROWS)[number];
// The route checks: the map's, and routes.ts's check of each route key, which waits with its Vertex.
const ROUTE_CHECK_CODES = [...ROUTE_MAP_CODES, 'unknown-outcome'];
// Whether the row's key, set to `value`, was refused by its own check (a problem at or under its site, from no route
// check), which canaries the refusal holds, and whether a warning fired that waits while any Vertex is out of the map
// (#449, Q2 A).
function refusalAt(row: KeyRow, value: unknown) {
  const config = withCanaries(exampleLayer.config());
  row.prepare?.(config);
  exampleLayer.putAt(config, [...row.site, ...row.key], value);
  const { errors, warnings } = exampleLayer.check(config);
  const site = row.site.join('.').replace(/\.(\d+)/g, '[$1]');
  const refused = errors.some(
    ({ code, at }) => !ROUTE_CHECK_CODES.includes(code) && (at === site || at.startsWith(`${site}.`)),
  );
  return { refused, holds: heldCanaries(errors), warned: routeMapWarnings(warnings).length > 0 };
}
const expectedRefusals = Object.fromEntries(
  ROUTE_KEY_ROWS.map(({ name, holds }) => [name, { refused: true, holds, warned: false }]),
);

test('each key a route check reads, refused, holds the checks through its Vertex', () => {
  assert.deepEqual(
    Object.fromEntries(ROUTE_KEY_ROWS.map((row) => [row.name, refusalAt(row, row.refusing)])),
    expectedRefusals,
  );
});

// A null is refused at its key like any value its check refuses, so it holds the same checks (#454, Q3 A).
test('each key a route check reads, set to null, holds the checks through its Vertex', () => {
  assert.deepEqual(Object.fromEntries(ROUTE_KEY_ROWS.map((row) => [row.name, refusalAt(row, null)])), expectedRefusals);
});

// A refused Procedure's findings would be dropped at its Vertex, so no run shows a read of its Actions; the source
// does. Both files read a whole Vertex's Actions as typed (#391, #454).
test("the graph checks read only a whole Vertex's typed Actions", () => {
  assert.deepEqual(
    GRAPH_SOURCES.map((source) => source.includes('procedure.actions')),
    [false, false],
  );
});

// A check gives the value it judged refused when it reported, a null in it among them, so nothing reads the error
// list to learn it (#391; #454, Q1 A, Q3 A).
test('an Agent with a null at any key is refused by its own check', () => {
  const notRefused = agentChecks.AGENT_KEYS.filter((key) => {
    const config = exampleLayer.config();
    config.agents.implementer[key] = null;
    const { agents } = agentChecks.checkAgents(report.newReport(), config, { fake: {} }, new Set(['implementer']));
    return !report.isReported(agents.get('implementer')?.typed);
  });
  assert.deepEqual(notRefused, []);
});

// The example's Procedure implement, changed, as its own check gives it.
function checkedImplement(change: (implement: Record<string, unknown>) => void) {
  const config = exampleLayer.config();
  change(config.procedures.implement);
  const schemas = exampleLayer.schemas();
  const declaring = {
    report: report.newReport(),
    readSchema: (name: string) => schemas[name],
    schemas: new Map(),
    commands: config.commands,
  };
  return procedureChecks.checkProcedure(declaring, 'implement', config.procedures.implement);
}

test('a sound Procedure is not refused', () => {
  assert.equal(checkedImplement(() => {})?.refused, undefined);
});

test('a Procedure with an unknown key or a null at any key is refused by its own check', () => {
  const notRefused = ['colour', ...procedureChecks.PROCEDURE_KEYS].filter((key) => {
    const procedure = checkedImplement((implement) => {
      implement[key] = key === 'colour' ? 'blue' : null;
    });
    return !report.isReported(procedure?.refused);
  });
  assert.deepEqual(notRefused, []);
});

// Each read that builds what the route checks receive, and each refusal read in a check that refuses a route target,
// a Procedure or an Agent (#459, Q1 A): its file, its source (once in that file), the mutant that drops it (null for a
// declaration, which tsc holds), and the test that fails under that mutant, or why none can. A read no table row
// reaches, or one a second refusal at its Vertex masks, shows here (#454, D14).
type WaitRead = readonly [file: string, read: string, mutant: string | null, fails: string];
const KEY_TABLE = 'each key a route check reads, refused, holds the checks through its Vertex';
const VERTEX_WORK = "a Vertex whose route target is refused shows no work for its Outcomes' routing";
const AGENT_HOLD = 'a Vertex whose Agent has an error holds the checks that read it, and only those';
const OWN_KEY = "an error at a Vertex's own key holds the cycle through it";
const NO_VERTICES = 'malformed configuration is an error, never a throw: vertices that are a list';
const SAME_REFUSAL = 'equivalent: reportedSince returns the same refusal';
const DECLARATION = 'equivalent: declares the read below';
const WAIT_READS: WaitRead[] = [
  ['flows.ts', 'let verticesRefused: Reported | undefined;', null, DECLARATION],
  [
    'flows.ts',
    'verticesRefused = report.errorOf(problems, atVertices, finding);',
    'report.errorOf(problems, atVertices, finding);',
    NO_VERTICES,
  ],
  ['flows.ts', '!verticesRefused && ', '', NO_VERTICES],
  ['flows.ts', ' && !notAnObject }', ' }', KEY_TABLE],
  ['flows.ts', 'id: string, refused: Reported | undefined)', null, DECLARATION],
  ['flows.ts', "typeof use === 'string' && report.isReported(checking.agents.get(use)?.typed)", 'false', AGENT_HOLD],
  [
    'flows.ts',
    '!report.isReported(procedure.refused) && ',
    '',
    'a Vertex whose Procedure has an error holds the checks that read it, and only those',
  ],
  ['flows.ts', '!agentRefused && ', '', AGENT_HOLD],
  ['flows.ts', ' && !refused) state', ') state', OWN_KEY],
  ['flows.ts', 'const ownRefused = report.reportedSince(problems, before);', 'const ownRefused = undefined;', OWN_KEY],
  ['flows.ts', 'bound.refused, ', '', KEY_TABLE],
  [
    'flows.ts',
    ', report.reportedSince(problems, afterRoutes)]',
    ']',
    "a Procedure error found in one Vertex's input scope holds only that Vertex",
  ],
  ['flows.ts', 'markWhole(checking, state, id, refused);', 'markWhole(checking, state, id, undefined);', OWN_KEY],
  [
    'flows.ts',
    ' && Object.keys(vertices).every((id) => whole.has(id));',
    ';',
    'a Vertex whose Procedure has an error holds only its own route keys, and the Flow defaults',
  ],
  ['flows.ts', ' && !report.isReported(typed.routes);', ';', KEY_TABLE],
  ['flows.ts', 'mapSound && !report.isReported(state.typed.get(id)?.route)', 'mapSound', KEY_TABLE],
  [
    'flows.ts',
    ' && Object.keys(vertices).every((id) => mapped.has(id));',
    ';',
    'a Vertex that is not an object holds the warnings',
  ],
  [
    'flows.ts',
    'nullValues.reportNulls(problems, { ...vertex, route: undefined }, location);',
    '',
    "a null on a Vertex's own key or its Agent holds the cycle through it",
  ],
  ['routes.ts', 'if (report.isReported(to)) return to;', '', SAME_REFUSAL],
  ['routes.ts', 'if (report.isReported(max)) return max;', '', SAME_REFUSAL],
  ['routes.ts', 'if (report.isReported(exhausted)) return exhausted;', '', SAME_REFUSAL],
  [
    'routes.ts',
    'const reported = report.reportedSince(problems, before);',
    'const reported = undefined;',
    'an unknown key on an edge holds the cycle through its Vertex',
  ],
  ['routes.ts', 'let refused: Reported | undefined;', null, DECLARATION],
  ['routes.ts', 'if (report.isReported(checked)) refused', 'if (false) refused', VERTEX_WORK],
  ['routes.ts', 'return refused ?? Object.fromEntries(typed);', 'return Object.fromEntries(typed);', VERTEX_WORK],
  ['routes.ts', 'refused: [notAnObject, ', 'refused: [', KEY_TABLE],
  ['routes.ts', 'notAnObject, max, ', 'notAnObject, ', KEY_TABLE],
  ['routes.ts', ', exhausted].find', '].find', KEY_TABLE],
  // The refusals those reads take from the Procedure, Agent and Vertex checks.
  [
    'index.ts',
    'procedure.refused ??= report.reportedSince(problems, before);',
    '',
    'a Procedure error found in its references alone holds every Vertex naming it',
  ],
  [
    'procedures.ts',
    'procedure.refused = report.reportedSince(problems, before);',
    '',
    'a Procedure with an unknown key or a null at any key is refused by its own check',
  ],
  [
    'agents.ts',
    'nullValues.reportNulls(problems, agent, location);',
    '',
    'an Agent with a null at any key is refused by its own check',
  ],
  [
    'procedures.ts',
    'nullValues.reportNulls(problems, declaration, location);',
    '',
    "equivalent: each Procedure key's own check refuses a null",
  ],
];
// The route checks read none: validate.route-checks.test.ts holds them to that (#459, Q1 A).
const WAIT_SOURCES = ['flows.ts', 'routes.ts'];
const validateSource = (file: string) => readFileSync(new URL(`../../lib/validate/${file}`, import.meta.url), 'utf8');

// The census holds the table to the source: a new read of a refusal without an entry fails it. It matches refusal
// words only; a flag the route checks receive is the type test's (#454, D16; #459, Q2 A).
test('every refusal read that builds what the route checks receive names the test that fails without it', () => {
  const notOnce = WAIT_READS.filter(([file, read]) => validateSource(file).split(read).length !== 2).map(
    ([file, read]) => `${file}: ${read}`,
  );
  const unnamed = WAIT_SOURCES.flatMap((file) =>
    validateSource(file)
      .split('\n')
      .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
      .filter(({ line }) => !line.trim().startsWith('//') && /isReported|reportedSince|refused|Refused/.test(line))
      .filter(({ line }) => !WAIT_READS.some(([readFile, read]) => readFile === file && line.includes(read)))
      .map(({ at }) => at),
  );
  assert.deepEqual({ notOnce, unnamed }, { notOnce: [], unnamed: [] });
});
