import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.mjs';

const defaultsDir = fileURLToPath(new URL('../../defaults/', import.meta.url));
// The inputs of the shipped Flow (#113): green reads red's tests and Red Evidence; the reviewer and publish the latest
// report and Green Evidence, and the Red Evidence; the fix the review's Findings and their file paths.
const GREEN_INPUTS = { tests: { from: 'red.commit.files' }, red: { from: 'red.red-check.evidence' } };
const IMPL_INPUTS = {
  report: { from: ['green.green.response', 'implementer-fix.fix.response', 'senior-dev.fix.response'] },
  red: { from: 'red.red-check.evidence' },
  green: { from: ['green.test.evidence', 'implementer-fix.test.evidence', 'senior-dev.test.evidence'] },
};
const FIX_INPUTS = {
  findings: { from: 'reviewer.review.response.findings' },
  testFiles: { from: 'reviewer.review.response.findings', pick: 'file' },
  red: { from: 'red.red-check.evidence' },
};

test('defaults/gg.json declares the default flow and its two agents', () => {
  const gg = JSON.parse(readFileSync(`${defaultsDir}gg.json`, 'utf8'));
  assert.equal(gg.maxParallel, 2);
  assert.equal(gg.baseBranch, 'main');
  assert.equal(typeof gg.worktreeRoot, 'string');
  assert.equal(gg.labelPrefix, 'gg');

  assert.deepEqual(Object.keys(gg.agents).sort(), ['implementer', 'reviewer']);
  const intents = { implementer: 'workspace-write', reviewer: 'read-only' };
  for (const [name, access] of Object.entries(intents)) {
    assert.deepEqual(gg.agents[name], {
      persona: `personas/${name}.md`, skills: [], mcp: [], plugins: [], access, network: false,
    }, `${name} names no harness, model or effort`);
    assert.ok(existsSync(`${defaultsDir}personas/${name}.md`), `${name}.md ships in defaults/personas`);
  }

  assert.deepEqual(gg.flows.default, {
    plan: null,
    actionCap: 180,
    ticket: {
      entry: 'red',
      routes: { misscoped: { end: 'needs-replan' }, '*': { end: 'needs-human' } },
      vertices: {
        red: { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } },
        green: { use: 'implementer', procedure: 'implement', inputs: GREEN_INPUTS, route: { ok: 'reviewer' } },
        reviewer: {
          use: 'reviewer', procedure: 'review', inputs: IMPL_INPUTS,
          route: { ok: 'publish', changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } },
            repeat: { to: 'senior-dev', max: 1, exhausted: { end: 'needs-human' } } },
        },
        'implementer-fix': { use: 'implementer', procedure: 'fix', inputs: FIX_INPUTS, route: { ok: 'reviewer' } },
        'senior-dev': { use: 'implementer', procedure: 'fix', maxVisits: 1, exhausted: { end: 'needs-human' }, inputs: FIX_INPUTS, route: { ok: 'reviewer' } },
        publish: { procedure: 'publish', inputs: IMPL_INPUTS, route: { ok: { end: 'ready-for-qa' } } },
      },
    },
  });
});

test("defaults/gg.json declares the shipped Procedures in the validator's shape", async () => {
  const { validate } = await import('../../lib/validate.mjs');
  const c = config.loadDefaults();
  c.agents.implementer.harness = 'fake';
  c.agents.reviewer.harness = 'fake';
  c.commands = { test: 'npm test' };
  const { flows, errors } = validate(c, { harnesses: { fake: {} }, readSchema: (name) => JSON.parse(config.layerFile(c.files, name)),
    readTemplate: (name) => config.layerFile(c.files, name) });
  assert.deepEqual(errors, []);
  const { procedures } = flows.default;
  assert.deepEqual(procedures['tests-fail'].actions.map((a) => [a.id, a.do].join(':')), ['red:agent', 'red-check:check', 'commit:commit']);
  assert.deepEqual(procedures.implement.actions.map((a) => [a.id, a.do].join(':')), ['green:agent', 'test:check', 'commit:commit', 'push:push', 'pr:pr-upsert']);
  assert.deepEqual(procedures.fix.actions.map((a) => [a.id, a.do].join(':')), ['fix:agent', 'test:check', 'commit:commit', 'push:push', 'pr:pr-upsert']);
  assert.deepEqual(procedures.review.actions.map((a) => [a.id, a.do].join(':')),
    ['review:agent', 'review-pass:check', 'repeat:check', 'comment:comment', 'pr:pr-upsert']);
  assert.deepEqual(procedures.publish.actions.map((a) => [a.id, a.do].join(':')), ['test:check', 'pr:pr-upsert', 'pr-ready:pr-ready']);
  assert.deepEqual(procedures.implement.claims, {
    ok: { requires: ['test'] }, blocked: { stop: true, comment: 'templates/stop.md' }, misscoped: { stop: true, comment: 'templates/stop.md' },
  });
  assert.deepEqual(procedures.publish.claims, { ok: { requires: ['test'] } });
  assert.deepEqual([procedures['tests-fail'].tests, procedures.fix.tests, procedures.review.access], ['write', { named: 'inputs.testFiles' }, 'read-only']);
});
