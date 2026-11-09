import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as flow from '../../lib/flow.ts';
import type * as model from '../../lib/model.ts';
import * as exampleLayer from '../support/example-layer.ts';

test('writeResolved writes the flow and hash to the run directory', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'gg-flow-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const resolved: model.ResolvedFlowJson = exampleLayer.config().flows.default;
  const hash = 'a'.repeat(64);
  flow.writeResolved(runDir, resolved, hash);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'flow.json'), 'utf8')), resolved);
  assert.equal(readFileSync(join(runDir, 'config-hash.txt'), 'utf8').trim(), hash);
});
