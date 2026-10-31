import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.mjs';
import * as flow from '../../lib/flow.mjs';

const IMPLEMENTER = { persona: 'personas/implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false };
const REVIEWER = { persona: 'personas/reviewer.md', skills: [], mcp: [], plugins: [], access: 'read-only', network: false };
// The inputs of the shipped Flow (#113): green reads red's tests and Red Evidence; the reviewer and publish the latest
// report and Green Evidence, and the Red Evidence; the fix the review's Findings and their file paths.
const GREEN_INPUTS = { tests: { from: 'red.commit.files' }, red: { from: 'red.red-check.evidence' } };
const IMPL_INPUTS = {
  report: { from: ['green.green.response', 'implementer-fix.fix.response'] },
  red: { from: 'red.red-check.evidence' },
  green: { from: ['green.test.evidence', 'implementer-fix.test.evidence'] },
};
const FIX_INPUTS = {
  findings: { from: 'reviewer.review.response.findings' },
  testFiles: { from: 'reviewer.review.response.findings', pick: 'file' },
  red: { from: 'red.red-check.evidence' },
};

test('resolveFlow expands use into the resolved flow shape, with the Flow routes and an Agent-less publish', () => {
  const resolvedImplementer = { persona: 'personas/implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false, harness: null, model: null, effort: null };
  assert.deepEqual(flow.resolveFlow(config.loadDefaults()), {
    name: 'default',
    plan: null,
    ticket: {
      entry: 'red',
      routes: { misscoped: { end: 'needs-replan' }, '*': { end: 'needs-human' } },
      vertices: {
        red: { agent: resolvedImplementer, options: {}, procedure: 'tests-fail', route: { ok: 'green' } },
        green: { agent: resolvedImplementer, options: {}, procedure: 'implement', inputs: GREEN_INPUTS, route: { ok: 'reviewer' } },
        reviewer: {
          agent: { persona: 'personas/reviewer.md', skills: [], mcp: [], plugins: [], access: 'read-only', network: false, harness: null, model: null, effort: null },
          options: {}, procedure: 'review', inputs: IMPL_INPUTS,
          route: { ok: 'publish', changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } } },
        },
        'implementer-fix': { agent: resolvedImplementer, options: {}, procedure: 'fix', inputs: FIX_INPUTS, route: { ok: 'reviewer' } },
        publish: { agent: null, options: {}, procedure: 'publish', inputs: IMPL_INPUTS, route: { ok: { end: 'ready-for-qa' } } },
      },
    },
  });
});

test('a Vertex field overrides the library Agent it uses, and the rest comes from that Agent', () => {
  const overridden = config.loadDefaults();
  overridden.flows.default.ticket.vertices['implementer-fix'] = { use: 'implementer', model: 'model-z', procedure: 'fix', route: { ok: 'reviewer' } };
  assert.deepEqual(flow.resolveFlow(overridden).ticket.vertices['implementer-fix'], {
    agent: { persona: 'personas/implementer.md', skills: [], mcp: [], plugins: [], access: 'workspace-write', network: false, harness: null, model: 'model-z', effort: null },
    options: {}, procedure: 'fix', route: { ok: 'reviewer' },
  });
});

test('resolveFlow does not mutate the Agent Library', () => {
  const overridden = config.loadDefaults();
  overridden.flows.default.ticket.vertices['implementer-fix'] = { use: 'implementer', model: 'model-z', procedure: 'fix', route: { ok: 'reviewer' } };
  flow.resolveFlow(overridden);
  assert.deepEqual(overridden.agents, { implementer: IMPLEMENTER, reviewer: REVIEWER });
});

test('the Resolved Flow carries the persona file name, not a path', () => {
  assert.equal(flow.resolveFlow(config.loadDefaults()).ticket.vertices.green.agent.persona, 'personas/implementer.md');
});

for (const [harness, agents] of [
  ['claude', {
    red: { harness: 'claude', model: 'opus', effort: 'high' },
    green: { harness: 'claude', model: 'opus', effort: 'high' },
    reviewer: { harness: 'claude', model: 'sonnet', effort: 'high' },
    'implementer-fix': { harness: 'claude', model: 'opus', effort: 'high' },
  }],
  ['codex', {
    red: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    green: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
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
    assert.equal(vertices.publish.agent, null, 'publish runs no agent');
    delete vertices.publish;
    assert.deepEqual(Object.fromEntries(Object.entries(vertices).map(([id, { agent }]) => [id, { harness: agent.harness, model: agent.model, effort: agent.effort }])), agents);
  });
}

test('resolveFlow rejects an unknown agent or procedure naming the vertex', () => {
  const unknownAgent = config.loadDefaults();
  unknownAgent.flows.default.ticket.vertices['odd-vertex'] = { use: 'no-such-agent', procedure: 'fix', route: { ok: 'reviewer' } };
  assert.throws(() => flow.resolveFlow(unknownAgent), /odd-vertex/);

  const unknownProcedure = config.loadDefaults();
  unknownProcedure.flows.default.ticket.vertices['odd-vertex'] = { use: 'implementer', procedure: 'no-such-procedure', route: { ok: 'reviewer' } };
  assert.throws(() => flow.resolveFlow(unknownProcedure), /odd-vertex/);
});

test('resolveFlow rejects inherited property names as agent or procedure naming the vertex', () => {
  const inheritedAgent = config.loadDefaults();
  inheritedAgent.flows.default.ticket.vertices['odd-vertex'] = { use: 'constructor', procedure: 'fix', route: { ok: 'reviewer' } };
  assert.throws(() => flow.resolveFlow(inheritedAgent), /odd-vertex/);

  const inheritedProcedure = config.loadDefaults();
  inheritedProcedure.flows.default.ticket.vertices['odd-vertex'] = { use: 'implementer', procedure: 'constructor', route: { ok: 'reviewer' } };
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
