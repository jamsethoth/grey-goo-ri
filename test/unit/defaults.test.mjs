import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultsDir = fileURLToPath(new URL('../../defaults/', import.meta.url));
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
    ticket: {
      entry: 'red',
      routes: { misscoped: { end: 'needs-replan' }, '*': { end: 'needs-human' } },
      vertices: {
        red: { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } },
        green: { use: 'implementer', procedure: 'implement', inputs: GREEN_INPUTS, route: { ok: 'reviewer' } },
        reviewer: {
          use: 'reviewer', procedure: 'review', inputs: IMPL_INPUTS,
          route: { ok: 'publish', changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } } },
        },
        'implementer-fix': { use: 'implementer', procedure: 'fix', inputs: FIX_INPUTS, route: { ok: 'reviewer' } },
        publish: { procedure: 'publish', inputs: IMPL_INPUTS, route: { ok: { end: 'ready-for-qa' } } },
      },
    },
  });
});
