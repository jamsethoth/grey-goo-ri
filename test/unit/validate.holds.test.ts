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

// The checks a key's refusal may hold, each fired by the edits below: three through green, which implementer runs
// under Procedure implement, and two on the rest of the Flow (#454, Q4 A).
const CANARIES = [
  'cycle through green',
  "green's commit",
  'pr-ready past green',
  'cycle elsewhere',
  "senior-green's commit",
] as const;
type Canary = (typeof CANARIES)[number];
function withCanaries(config: Layer) {
  const { vertices } = exampleTicket(config);
  vertices.green.route['bad-test'] = { to: 'red' };
  // With no Check required, implement has no failed Outcome to route.
  config.procedures.implement.claimTokens.ok.requires = [];
  delete vertices.green.route.failed;
  vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  vertices.reviewer.route.changes = 'publish';
  vertices.publish.route.ok = 'reviewer';
  return config;
}
function heldCanaries(errors: report.Problem[]): Canary[] {
  const fired = (code: string, at: string, cycle?: string[]) =>
    errors.some(
      (problem) =>
        problem.code === code && problem.at === at && (!cycle || util.isDeepStrictEqual(problem.params, { cycle })),
    );
  const firing: Record<Canary, boolean> = {
    'cycle through green': fired('unbounded-cycle', 'flows.default.ticket', ['red', 'green']),
    "green's commit": fired('commit-without-check', `${VERTICES}.green`),
    'pr-ready past green': fired('pr-ready-skippable', `${VERTICES}.reviewer`),
    'cycle elsewhere': fired('unbounded-cycle', 'flows.default.ticket', ['reviewer', 'publish']),
    "senior-green's commit": fired('commit-without-check', `${VERTICES}.senior-green`),
  };
  return CANARIES.filter((canary) => !firing[canary]);
}

test('the canaries fire on the example with no key refused', () => {
  const { errors } = exampleLayer.check(withCanaries(exampleLayer.config()));
  assert.deepEqual(exampleLayer.firedRules(errors), [
    { at: `${VERTICES}.green`, code: 'commit-without-check' },
    { at: `${VERTICES}.senior-green`, code: 'commit-without-check' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
    { at: 'flows.default.ticket', code: 'unbounded-cycle' },
    { at: `${VERTICES}.reviewer`, code: 'pr-ready-skippable' },
    { at: `${VERTICES}.reviewer.inputs.green`, code: 'required-input-unsure' },
    { at: `${VERTICES}.senior-dev.inputs.green`, code: 'required-input-unsure' },
    { at: `${VERTICES}.publish.inputs.green`, code: 'required-input-unsure' },
  ]);
  assert.deepEqual(heldCanaries(errors), []);
});

// Each key a route-map check reads, where it sits, a value its own check refuses and the canaries that refusal holds:
// the checks through its Vertex, and only those. A key no check judges is refused only as a null (#454, Q3 A).
type Row = readonly [refusing: unknown, holds: readonly Canary[]];
const THROUGH_GREEN: Canary[] = ['cycle through green', "green's commit", 'pr-ready past green'];
// A route target is typed apart and changes no Outcome, so only the map through its Vertex waits (#436, D3 C).
const MAP_THROUGH_GREEN: Canary[] = ['cycle through green', 'pr-ready past green'];
// implement runs green and senior-green.
const THROUGH_IMPLEMENT: Canary[] = [...THROUGH_GREEN, "senior-green's commit"];
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
const ROUTE_KEY_SITES: Record<string, { path: string[]; keys: Record<string, Row> }> = {
  ticket: {
    path: ['flows', 'default', 'ticket'],
    keys: {
      // A cycle reads no entry; what a route guarantees starts from it (#449).
      entry: [7, ['pr-ready past green']],
      // Every Vertex's routes fall back to the Flow's, so the whole map waits; a commit reads no route.
      routes: [7, ['cycle through green', 'pr-ready past green', 'cycle elsewhere']],
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
const ROUTE_KEY_ROWS = Object.entries(ROUTE_KEY_SITES).flatMap(([site, { path, keys }]) =>
  Object.entries(keys).map(([key, [refusing, holds]]) => ({
    name: `${site} ${key}`,
    path: [...path, key],
    refusing,
    holds,
  })),
);
// Whether the key at `path`, set to `value`, was refused by its own check (a problem under the object holding it, from
// no route-map check), and which canaries the refusal holds.
function refusalAt(path: string[], value: unknown) {
  const config = withCanaries(exampleLayer.config());
  exampleLayer.putAt(config, path, value);
  const { errors } = exampleLayer.check(config);
  const parent = path.slice(0, -1).join('.');
  const refused = errors.some(
    ({ code, at }) => !ROUTE_MAP_CODES.includes(code) && (at === parent || at.startsWith(`${parent}.`)),
  );
  return { refused, holds: heldCanaries(errors) };
}
const expectedRefusals = Object.fromEntries(ROUTE_KEY_ROWS.map(({ name, holds }) => [name, { refused: true, holds }]));

test('each key a route check reads, refused, holds the checks through its Vertex', () => {
  assert.deepEqual(
    Object.fromEntries(ROUTE_KEY_ROWS.map(({ name, path, refusing }) => [name, refusalAt(path, refusing)])),
    expectedRefusals,
  );
});

// A null is refused at its key like any value its check refuses, so it holds the same checks (#454, Q3 A).
test('each key a route check reads, set to null, holds the checks through its Vertex', () => {
  assert.deepEqual(
    Object.fromEntries(ROUTE_KEY_ROWS.map(({ name, path }) => [name, refusalAt(path, null)])),
    expectedRefusals,
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
