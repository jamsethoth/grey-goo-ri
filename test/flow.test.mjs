import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as config from '../lib/config.mjs';
import * as flow from '../lib/flow.mjs';

test('resolveFlow expands use with overrides into the resolved flow shape', () => {
  const defaults = config.loadDefaults();
  const library = structuredClone(defaults.nodes);
  const resolved = flow.resolveFlow(defaults);

  assert.equal(resolved.name, 'default');
  assert.equal(resolved.plan, null);
  assert.equal(resolved.ticket.entry, 'implementer');
  const { vertices } = resolved.ticket;
  assert.deepEqual(Object.keys(vertices).sort(), ['implementer', 'implementer-fix', 'reviewer']);
  const uses = { implementer: 'implementer', reviewer: 'reviewer', 'implementer-fix': 'implementer' };
  for (const [id, use] of Object.entries(uses)) {
    const { node } = vertices[id];
    assert.ok(existsSync(node.persona), `${id} persona is a readable path: ${node.persona}`);
    assert.deepEqual({ ...node, persona: basename(node.persona) }, library[use], `${id} node comes from ${use}`);
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
  assert.equal(fix.node.model, 'model-z', 'a Vertex field overrides the library Node');
  assert.equal(fix.node.harness, library.implementer.harness, 'the rest comes from the library Node');
  assert.equal(fix.model, undefined, 'the override lives on the node, not the Vertex');
  assert.deepEqual(overridden.nodes, library, 'the Node Library is not mutated');
});

test('resolveFlow rejects an unknown node or procedure naming the vertex', () => {
  const unknownNode = config.loadDefaults();
  unknownNode.flows.default.ticket.vertices['odd-vertex'] = { use: 'no-such-node', procedure: 'fix', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(unknownNode), /odd-vertex/);

  const unknownProcedure = config.loadDefaults();
  unknownProcedure.flows.default.ticket.vertices['odd-vertex'] = { use: 'implementer', procedure: 'no-such-procedure', then: 'reviewer' };
  assert.throws(() => flow.resolveFlow(unknownProcedure), /odd-vertex/);
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
