import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../lib/config.mjs';
import * as flow from '../lib/flow.mjs';

test('resolveFlow expands use with overrides into the resolved flow shape', () => {
  const defaults = config.loadDefaults();
  const library = structuredClone(defaults.agents);
  const resolved = flow.resolveFlow(defaults);

  assert.equal(resolved.name, 'default');
  assert.equal(resolved.plan, null);
  assert.equal(resolved.ticket.entry, 'implementer');
  const { vertices } = resolved.ticket;
  assert.deepEqual(Object.keys(vertices).sort(), ['implementer', 'implementer-fix', 'reviewer']);
  const uses = { implementer: 'implementer', reviewer: 'reviewer', 'implementer-fix': 'implementer' };
  for (const [id, use] of Object.entries(uses)) {
    const { agent } = vertices[id];
    assert.deepEqual(agent, { ...library[use], harness: null, model: null, effort: null }, `${id} agent comes from ${use}`);
    assert.equal(vertices[id].use, undefined, `${id} no longer carries use`);
    assert.deepEqual(vertices[id].options, {});
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(vertices).map(([id, v]) => [id, v.procedure])),
    { implementer: 'tdd', reviewer: 'review', 'implementer-fix': 'fix' },
  );
  assert.equal(vertices.implementer.then, 'reviewer');
  assert.equal(vertices['implementer-fix'].then, 'reviewer');
  assert.deepEqual(vertices.reviewer.route, { ok: 'done', changes: { to: 'implementer-fix', max: 2, exhausted: 'needs-human' } });

  const overridden = structuredClone(defaults);
  overridden.flows.default.ticket.vertices['implementer-fix'] = { use: 'implementer', model: 'model-z', procedure: 'fix', then: 'reviewer' };
  const fix = flow.resolveFlow(overridden).ticket.vertices['implementer-fix'];
  assert.equal(fix.agent.model, 'model-z', 'a Vertex field overrides the library Agent');
  assert.equal(fix.agent.persona, library.implementer.persona, 'the rest comes from the library Agent');
  assert.equal(fix.agent.harness, null, 'a missing harness resolves to null');
  assert.equal(fix.model, undefined, 'the override lives on the agent, not the Vertex');
  assert.deepEqual(overridden.agents, library, 'the Agent Library is not mutated');
});

test('the Resolved Flow carries the persona file name, not a path', () => {
  assert.equal(flow.resolveFlow(config.loadDefaults()).ticket.vertices.implementer.agent.persona, 'implementer.md');
});

test('each example Layer merged over the defaults resolves with its harness', () => {
  for (const harness of ['claude', 'codex']) {
    const example = JSON.parse(readFileSync(fileURLToPath(new URL(`../examples/${harness}.json`, import.meta.url)), 'utf8'));
    const merged = config.loadDefaults();
    assert.deepEqual(Object.keys(example.agents).sort(), Object.keys(merged.agents).sort(), `${harness} sets every shipped Agent`);
    for (const [name, agent] of Object.entries(example.agents)) merged.agents[name] = { ...merged.agents[name], ...agent };
    for (const [id, { agent }] of Object.entries(flow.resolveFlow(merged).ticket.vertices)) {
      assert.equal(agent.harness, harness, `${harness} ${id} harness`);
      assert.equal(typeof agent.model, 'string', `${harness} ${id} model`);
      assert.equal(typeof agent.effort, 'string', `${harness} ${id} effort`);
    }
  }
});

test('resolveFlow rejects an unknown agent or procedure naming the vertex', () => {
  const unknownAgent = config.loadDefaults();
  unknownAgent.flows.default.ticket.vertices['odd-vertex'] = { use: 'no-such-agent', procedure: 'fix', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(unknownAgent), /odd-vertex/);

  const unknownProcedure = config.loadDefaults();
  unknownProcedure.flows.default.ticket.vertices['odd-vertex'] = { use: 'implementer', procedure: 'no-such-procedure', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(unknownProcedure), /odd-vertex/);
});

test('resolveFlow rejects inherited property names as agent or procedure naming the vertex', () => {
  const inheritedAgent = config.loadDefaults();
  inheritedAgent.flows.default.ticket.vertices['odd-vertex'] = { use: 'constructor', procedure: 'fix', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(inheritedAgent), /odd-vertex/);

  const inheritedProcedure = config.loadDefaults();
  inheritedProcedure.flows.default.ticket.vertices['odd-vertex'] = { use: 'implementer', procedure: 'constructor', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(inheritedProcedure), /odd-vertex/);
});

test('writeResolved writes the flow and hash to the run directory', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'gg-flow-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const resolved = flow.resolveFlow(config.loadDefaults());
  const hash = 'a'.repeat(64);
  flow.writeResolved(runDir, resolved, hash);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'flow.json'), 'utf8')), resolved);
  assert.equal(readFileSync(join(runDir, 'config-hash.txt'), 'utf8').trim(), hash);
});
