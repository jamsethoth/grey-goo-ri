import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.mjs';
import * as flow from '../../lib/flow.mjs';

const IMPLEMENTER = { persona: 'implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false };
const REVIEWER = { persona: 'reviewer.md', skills: [], mcp: [], plugins: [], access: 'read-only', network: false };

test('resolveFlow expands use into the resolved flow shape', () => {
  const resolvedImplementer = { persona: 'implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false, harness: null, model: null, effort: null };
  assert.deepEqual(flow.resolveFlow(config.loadDefaults()), {
    name: 'default',
    plan: null,
    ticket: {
      entry: 'implementer',
      vertices: {
        implementer: { agent: resolvedImplementer, options: {}, procedure: 'tdd', then: 'reviewer' },
        reviewer: {
          agent: { persona: 'reviewer.md', skills: [], mcp: [], plugins: [], access: 'read-only', network: false, harness: null, model: null, effort: null },
          options: {}, procedure: 'review',
          route: { ok: 'done', changes: { to: 'implementer-fix', max: 2, exhausted: 'needs-human' } },
        },
        'implementer-fix': { agent: resolvedImplementer, options: {}, procedure: 'fix', then: 'reviewer' },
      },
    },
  });
});

test('a Vertex field overrides the library Agent it uses, and the rest comes from that Agent', () => {
  const overridden = config.loadDefaults();
  overridden.flows.default.ticket.vertices['implementer-fix'] = { use: 'implementer', model: 'model-z', procedure: 'fix', then: 'reviewer' };
  assert.deepEqual(flow.resolveFlow(overridden).ticket.vertices['implementer-fix'], {
    agent: { persona: 'implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false, harness: null, model: 'model-z', effort: null },
    options: {}, procedure: 'fix', then: 'reviewer',
  });
});

test('resolveFlow does not mutate the Agent Library', () => {
  const overridden = config.loadDefaults();
  overridden.flows.default.ticket.vertices['implementer-fix'] = { use: 'implementer', model: 'model-z', procedure: 'fix', then: 'reviewer' };
  flow.resolveFlow(overridden);
  assert.deepEqual(overridden.agents, { implementer: IMPLEMENTER, reviewer: REVIEWER });
});

test('the Resolved Flow carries the persona file name, not a path', () => {
  assert.equal(flow.resolveFlow(config.loadDefaults()).ticket.vertices.implementer.agent.persona, 'implementer.md');
});

for (const [harness, agents] of [
  ['claude', {
    implementer: { harness: 'claude', model: 'opus', effort: 'high' },
    reviewer: { harness: 'claude', model: 'sonnet', effort: 'high' },
    'implementer-fix': { harness: 'claude', model: 'opus', effort: 'high' },
  }],
  ['codex', {
    implementer: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    reviewer: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    'implementer-fix': { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  }],
]) {
  test(`the ${harness} example Layer over the defaults resolves every Vertex with its harness`, (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'gg-example-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const example = fileURLToPath(new URL(`../../examples/${harness}.json`, import.meta.url));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(example, 'utf8')).agents).sort(), ['implementer', 'reviewer'], 'it sets every shipped Agent');
    mkdirSync(join(repo, '.agents', 'gg'), { recursive: true });
    copyFileSync(example, config.layerPath(repo));
    const { vertices } = flow.resolveFlow(config.loadConfig(repo, join(repo, 'no-user-layer'))).ticket;
    assert.deepEqual(Object.fromEntries(Object.entries(vertices).map(([id, { agent }]) => [id, { harness: agent.harness, model: agent.model, effort: agent.effort }])), agents);
  });
}

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
