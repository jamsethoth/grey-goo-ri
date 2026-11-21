import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../../lib/harnesses/claude.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as outcome from '../../lib/outcome.ts';
import * as agentChecks from '../../lib/validate/agents.ts';
import * as exampleSource from '../support/example-source.ts';

// The Agent keys the validator checks (#386). A case about a rule asserts which one fired and where.
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// Every Agent key the interpreter reads is checked wherever an Agent key is written (#386), so a Run cannot fail on one
// at Visit entry: agentChecks.AGENT_FIELDS is model.Agent's declared keys, and each must be here.
const AGENT_KEY_ERRORS: Record<string, { under: boolean; code: string }> = {
  harness: { under: false, code: 'invalid-name' },
  persona: { under: true, code: 'file-not-named' },
  model: { under: true, code: 'not-a-string' },
  effort: { under: true, code: 'not-a-string' },
  network: { under: true, code: 'not-a-boolean' },
};
const AGENT_SITES: Record<string, (config: exampleSource.Source) => { site: Record<string, unknown>; at: string }> = {
  'a declared Agent': (config) => ({ site: config.agents.implementer, at: 'agents.implementer' }),
  "a Vertex's override of its Agent": (config) => ({
    site: config.flows.default.ticket.vertices.red,
    at: `${VERTICES}.red`,
  }),
  'an inline Vertex Agent': (config) => {
    const red = config.flows.default.ticket.vertices.red;
    exampleSource.putAt(red, ['use']);
    Object.assign(red, config.agents.implementer);
    return { site: red, at: `${VERTICES}.red` };
  },
};

test('the Agent keys checked at each site are every key the Resolved Flow declares for an Agent', () => {
  assert.deepEqual(Object.keys(AGENT_KEY_ERRORS).sort(), Object.keys(agentChecks.AGENT_FIELDS).sort());
});

for (const key of Object.keys(agentChecks.AGENT_FIELDS))
  for (const [where, place] of Object.entries(AGENT_SITES))
    test(`an Agent's ${key} of the wrong type at ${where} is an error there, and the Flow does not resolve`, () => {
      const config = exampleSource.config();
      const { site, at } = place(config);
      site[key] = { wrong: true };
      const { under, code } = AGENT_KEY_ERRORS[key]!;
      const { errors, flows } = exampleSource.check(config);
      assert.deepEqual(exampleSource.firedRules(errors), [{ at: under ? `${at}.${key}` : at, code }]);
      // The check that reports the key types it, so the Agent it sits in is not typed (#391).
      assert.equal(flows.default, undefined);
    });

test("an Agent with no persona is one error at the Agent, used or not, which a Vertex's own does not excuse", () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.reviewer, ['persona']);
  exampleSource.putAt(config.flows.default.ticket.vertices.reviewer, ['persona'], 'reviewer.md');
  exampleSource.putAt(config.agents, ['spare'], { harness: 'fake' });
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    { at: 'agents.reviewer', code: 'required-key-missing' },
    { at: 'agents.spare', code: 'required-key-missing' },
  ]);
  assert.deepEqual(errors[0]!.params, { key: 'persona' });
});

test('an inline Vertex Agent with no persona is an error at the Vertex', () => {
  const config = exampleSource.config();
  const red = config.flows.default.ticket.vertices.red;
  exampleSource.putAt(red, ['use']);
  Object.assign(red, { harness: 'fake', access: 'workspace-write' });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'required-key-missing' },
  ]);
});

test("a Vertex may override its Agent's persona with another file", () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['persona'], 'reviewer.md');
  const { errors, flows } = exampleSource.check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default!.ticket.vertices.red!.agent!.persona, 'reviewer.md');
});

test('an empty persona names no file, and a null one is only a null', () => {
  const config = exampleSource.config();
  config.agents.reviewer.persona = ' ';
  exampleSource.putAt(config.agents.senior, ['persona'], null);
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.senior.persona', code: 'null-value' },
    { at: 'agents.reviewer.persona', code: 'file-not-named' },
  ]);
});

// An Agent asking for more access than its Procedure allows is refused, never capped, so the Harness sees the access
// the call runs with (#424, Q1 A).
test('a workspace-write Agent on a read-only Procedure is an access-conflict that names the fix', () => {
  const config = exampleSource.config();
  config.agents.reviewer.access = 'workspace-write';
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [{ at: `${VERTICES}.reviewer`, code: 'access-conflict' }]);
  assert.ok(errors[0]!.message.includes('"review"'), errors[0]!.message);
  assert.ok(errors[0]!.message.includes('"reviewer"'), errors[0]!.message);
  assert.ok(errors[0]!.message.includes('set "access": "read-only" on the Vertex'), errors[0]!.message);
  assert.deepEqual(errors[0]!.params, { procedure: 'review', agent: 'reviewer' });
});

// Every combination of the Procedure's, the Agent's and the Vertex's access: a Vertex either runs with the access its
// Agent asks for, or, asking for workspace-write on a read-only Procedure, is an access-conflict at the Vertex. Only
// access-conflict is read: a review that may write breaks the review Procedure's other rules.
test('every Vertex runs with the access its Agent asks for, or is an access-conflict', () => {
  const accesses = [undefined, 'read-only', 'workspace-write'];
  const wrong: string[] = [];
  for (const procedureAccess of [undefined, 'read-only'])
    for (const agentAccess of accesses)
      for (const vertexAccess of accesses) {
        const config = exampleSource.config();
        exampleSource.putAt(config, ['procedures', 'review', 'access'], procedureAccess);
        exampleSource.putAt(config, ['agents', 'reviewer', 'access'], agentAccess);
        exampleSource.putAt(config, ['flows', 'default', 'ticket', 'vertices', 'reviewer', 'access'], vertexAccess);
        const { errors, flows } = exampleSource.check(config);
        const asked = vertexAccess ?? agentAccess ?? 'read-only';
        const fired = JSON.stringify(exampleSource.firedRules(errors.filter(({ code }) => code === 'access-conflict')));
        const runs = flows.default?.ticket.vertices.reviewer?.access;
        const conflict = procedureAccess === 'read-only' && asked === 'workspace-write';
        const expected = conflict ? JSON.stringify([{ at: `${VERTICES}.reviewer`, code: 'access-conflict' }]) : '[]';
        if (fired !== expected || (!conflict && runs !== asked))
          wrong.push(
            `procedure ${procedureAccess}, agent ${agentAccess}, vertex ${vertexAccess}: ${fired}, runs ${runs}`,
          );
      }
  assert.deepEqual(wrong, []);
});

// An Agent's timeouts is { stallMs, wallMs }, each optional and a positive integer of ms; the defaults are the
// Harness's (#395, decision 1 of #429).
const TIMEOUTS_FORMS: { form: string; timeouts: unknown; under: string; code: string }[] = [
  { form: 'a number', timeouts: 5, under: '', code: 'not-an-object' },
  { form: 'a list', timeouts: [60000], under: '', code: 'not-an-object' },
  { form: 'an unknown key', timeouts: { stall: 60000 }, under: '', code: 'unknown-key' },
  { form: 'a zero stallMs', timeouts: { stallMs: 0 }, under: '.stallMs', code: 'not-a-positive-integer' },
  { form: 'a negative stallMs', timeouts: { stallMs: -1 }, under: '.stallMs', code: 'not-a-positive-integer' },
  { form: 'a fractional wallMs', timeouts: { wallMs: 1.5 }, under: '.wallMs', code: 'not-a-positive-integer' },
  { form: 'a string wallMs', timeouts: { wallMs: '60000' }, under: '.wallMs', code: 'not-a-positive-integer' },
];
for (const { form, timeouts, under, code } of TIMEOUTS_FORMS)
  for (const [where, place] of Object.entries(AGENT_SITES))
    test(`timeouts of ${form} is an error at ${where}`, () => {
      const config = exampleSource.config();
      const { site, at } = place(config);
      site.timeouts = timeouts;
      const { errors, flows } = exampleSource.check(config);
      assert.deepEqual(exampleSource.firedRules(errors), [{ at: `${at}.timeouts${under}`, code }]);
      assert.equal(flows.default, undefined);
    });

test('timeouts of { stallMs, wallMs }, either left out, resolve into the Agent', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.implementer, ['timeouts'], { stallMs: 60000, wallMs: 3600000 });
  exampleSource.putAt(config.flows.default.ticket.vertices.green, ['timeouts'], { wallMs: 7200000 });
  const { errors, flows } = exampleSource.check(config);
  assert.deepEqual(errors, []);
  const { vertices } = flows.default!.ticket;
  assert.deepEqual(vertices.red!.agent!.timeouts, { stallMs: 60000, wallMs: 3600000 });
  assert.deepEqual(vertices.green!.agent!.timeouts, { wallMs: 7200000 });
});

// An Agent's resolutionPolicy is its retry budgets, each optional and a whole number 0 or more; a budget left out
// keeps its shipped value (#435, Q1 A and Q2 A).
const POLICY_FORMS: { form: string; policy: unknown; under: string; code: string }[] = [
  { form: 'a number', policy: 5, under: '', code: 'not-an-object' },
  { form: 'a list', policy: [1, 2], under: '', code: 'not-an-object' },
  { form: 'an unknown budget', policy: { nonsense: 1 }, under: '', code: 'unknown-key' },
  { form: 'a negative transient', policy: { transient: -1 }, under: '.transient', code: 'not-a-non-negative-integer' },
  { form: 'a fractional parse', policy: { parse: 1.5 }, under: '.parse', code: 'not-a-non-negative-integer' },
  { form: 'a string timeout', policy: { timeout: '1' }, under: '.timeout', code: 'not-a-non-negative-integer' },
];
for (const { form, policy, under, code } of POLICY_FORMS)
  for (const [where, place] of Object.entries(AGENT_SITES))
    test(`a resolutionPolicy of ${form} is an error at ${where}`, () => {
      const config = exampleSource.config();
      const { site, at } = place(config);
      site.resolutionPolicy = policy;
      const { errors, flows } = exampleSource.check(config);
      assert.deepEqual(exampleSource.firedRules(errors), [{ at: `${at}.resolutionPolicy${under}`, code }]);
      assert.equal(flows.default, undefined);
    });

// Every budget the Transition Table spends may be set, at every site an Agent key is written: 0 resolves into the
// Agent, and a negative one is an error at that budget.
test('every retry budget the Transition Table spends is a budget a resolutionPolicy may set, 0 or more', () => {
  const wrong: string[] = [];
  for (const budget of Object.keys(outcome.DEFAULT_RESOLUTION_POLICY))
    for (const [where, place] of Object.entries(AGENT_SITES))
      for (const value of [0, -1]) {
        const config = exampleSource.config();
        const { site, at } = place(config);
        site.resolutionPolicy = { [budget]: value };
        const { errors, flows } = exampleSource.check(config);
        const fired = JSON.stringify(exampleSource.firedRules(errors));
        const refused = [{ at: `${at}.resolutionPolicy.${budget}`, code: 'not-a-non-negative-integer' }];
        const expected = JSON.stringify(value < 0 ? refused : []);
        const resolves = flows.default !== undefined;
        if (fired !== expected || resolves !== value >= 0)
          wrong.push(`${budget} ${value} at ${where}: ${fired}, resolves ${resolves}`);
      }
  assert.deepEqual(wrong, []);
});

// The Agent keys the Capability matrix rules on, each with a value that asks for it. A listed field is refused where
// its Harness declares it unsupported; a Permission Intent where it is hint or unsupported, since an intent runs as
// asked or fails (ADR 0006, Q1 A and Q2 A of #429).
const CAPABILITY_KEYS = contract.CAPABILITY_FIELDS.filter((field) => agentChecks.AGENT_KEYS.includes(field));
const ASKING: Record<string, unknown> = {
  skills: ['tdd'],
  mcp: ['github'],
  plugins: ['alpha'],
  contextBudget: 100000,
  access: 'workspace-write',
  network: true,
};
const PERMISSION_INTENTS = new Set(['access', 'network']);
const EXACT = Object.fromEntries(CAPABILITY_KEYS.map((field) => [field, 'exact']));

test('every Agent key the Capability matrix rules on is asked for in the capability cases', () => {
  assert.deepEqual(Object.keys(ASKING).sort(), [...CAPABILITY_KEYS].sort());
});

// Each key, at each site, on a Harness declaring it exact, hint or unsupported and every other key exact. The fake
// Harness the other Agents run on declares no Capabilities, which the validator leaves to the contract check.
function capabilityErrors(intents: boolean) {
  const wrong: string[] = [];
  for (const field of CAPABILITY_KEYS.filter((key) => PERMISSION_INTENTS.has(key) === intents))
    for (const level of ['exact', 'hint', 'unsupported'])
      for (const [where, place] of Object.entries(AGENT_SITES)) {
        const config = exampleSource.config();
        const { site, at } = place(config);
        Object.assign(site, { harness: 'limited', [field]: ASKING[field] });
        const limited = { capabilities: { ...EXACT, [field]: level } };
        const { errors } = exampleSource.checkOn(config, { fake: {}, limited });
        const refused = intents ? level !== 'exact' : level === 'unsupported';
        const code = intents ? 'unenforceable-permission-intent' : 'unsupported-agent-field';
        const fired = JSON.stringify(exampleSource.firedRules(errors));
        const expected = JSON.stringify(refused ? [{ at: `${at}.${field}`, code }] : []);
        if (fired !== expected) wrong.push(`${field} ${level} at ${where}: ${fired}, expected ${expected}`);
      }
  return wrong;
}

test('an Agent listing a field its Harness declares unsupported is an error', () => {
  assert.deepEqual(capabilityErrors(false), []);
});

test('a permission intent its Harness cannot enforce is an error', () => {
  assert.deepEqual(capabilityErrors(true), []);
});

test('a read-only Claude Agent listing MCP servers is an error', () => {
  const config = exampleSource.config();
  Object.assign(config.agents.reviewer, { harness: 'claude', mcp: ['github'] });
  const { errors } = exampleSource.checkOn(config, { fake: {}, claude });
  assert.deepEqual(exampleSource.firedRules(errors), [{ at: 'agents.reviewer.mcp', code: 'unsupported-agent-field' }]);
  assert.deepEqual(errors[0]!.params, { field: 'mcp', harness: 'claude' });
});

// The field is the Agent's but the Harness the Vertex's own, so the Vertex is where the two meet.
test('a field its Agent lists, unsupported by the Harness its Vertex sets, is an error at the Vertex', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.implementer, ['mcp'], ['github']);
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['harness'], 'limited');
  const limited = { capabilities: { ...EXACT, mcp: 'unsupported' } };
  const { errors } = exampleSource.checkOn(config, { fake: {}, limited });
  assert.deepEqual(exampleSource.firedRules(errors), [{ at: `${VERTICES}.red`, code: 'unsupported-agent-field' }]);
});

// An Agent that writes no access asks for read-only, so its Harness must enforce access; one that writes no network
// asks for nothing.
test('an Agent writing no access still asks for read-only, which a Harness that only hints access refuses', () => {
  const config = exampleSource.config();
  config.agents.reviewer.harness = 'limited';
  exampleSource.putAt(config.agents.reviewer, ['access']);
  const limited = { capabilities: { ...EXACT, access: 'hint', network: 'unsupported' } };
  const { errors } = exampleSource.checkOn(config, { fake: {}, limited });
  assert.deepEqual(exampleSource.firedRules(errors), [
    { at: 'agents.reviewer', code: 'unenforceable-permission-intent' },
  ]);
});

// A recovery resumes its agent Action's Session; on a Harness that cannot resume one it would run without the Session
// it was written for, so each Vertex whose Procedure recovers is refused. An Attempt retry falls back to a fresh
// Session and is not refused (Q3 A of #429).
test('a Vertex whose Procedure recovers, on a Harness that cannot resume a Session, is an error', () => {
  const fired = (supported: boolean) => {
    const sessionResume = { supported, preconditions: [] };
    const harnesses = { fake: { capabilities: { ...EXACT, sessionResume } } };
    return exampleSource.firedRules(exampleSource.checkOn(exampleSource.config(), harnesses).errors);
  };
  const config = exampleSource.config();
  const recoveringProcedures = new Set(
    Object.entries(config.procedures).flatMap(([name, procedure]) => ('recover' in procedure ? [name] : [])),
  );
  const vertices = Object.entries(config.flows.default.ticket.vertices);
  const recovers = (vertex: { procedure: string }) => recoveringProcedures.has(vertex.procedure);
  const recovering = vertices
    .filter(([, vertex]) => recovers(vertex))
    .map(([id]) => ({ at: `${VERTICES}.${id}`, code: 'session-resume-unsupported' }));
  // The rule is not vacuous: some Vertices recover, and some that run an Agent do not.
  assert.ok(recovering.length > 0);
  assert.ok(vertices.some(([, vertex]) => 'use' in vertex && !recovers(vertex)));
  assert.deepEqual(fired(false), recovering);
  assert.deepEqual(fired(true), []);
});
