import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultsDir = fileURLToPath(new URL('../defaults/', import.meta.url));

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
      persona: `${name}.md`, skills: [], mcp: [], plugins: [], access, network: false,
    }, `${name} names no harness, model or effort`);
    assert.ok(existsSync(`${defaultsDir}personas/${name}.md`), `${name}.md ships in defaults/personas`);
  }

  assert.deepEqual(gg.flows.default, {
    plan: null,
    ticket: {
      entry: 'implementer',
      vertices: {
        implementer: { use: 'implementer', procedure: 'tdd', then: 'reviewer' },
        reviewer: {
          use: 'reviewer', procedure: 'review',
          route: { ok: 'done', changes: { to: 'implementer-fix', max: 2, exhausted: 'needs-human' } },
        },
        'implementer-fix': { use: 'implementer', procedure: 'fix', then: 'reviewer' },
      },
    },
  });
});
