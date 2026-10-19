import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = [
  'lib/opts.mjs', 'lib/config.mjs', 'lib/flow.mjs', 'lib/run.mjs', 'lib/interpreter.mjs',
  'lib/procedures.mjs', 'lib/briefs.mjs', 'lib/outcome.mjs', 'lib/checks.mjs', 'lib/integrity.mjs',
  'lib/record.mjs', 'lib/marker.mjs', 'lib/reconcile.mjs', 'lib/events.mjs', 'lib/labels.mjs',
  'lib/approval.mjs', 'lib/locks.mjs', 'lib/harnesses/contract.mjs', 'lib/harnesses/claude.mjs',
  'lib/harnesses/codex.mjs', 'lib/exec.mjs', 'lib/git.mjs', 'lib/paths.mjs', 'lib/github.mjs', 'lib/render.mjs',
  'lib/work.mjs', 'lib/trace.mjs', 'lib/stats.mjs', 'lib/doctor.mjs', 'lib/plan.mjs', 'lib/publish.mjs',
];

test('every module in the AGENTS.md layout imports', async () => {
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^## Layout$/m);
  assert.match(agents, /^## Tests$/m);
  assert.doesNotMatch(agents, /The layout section here grows with the code/);
  for (const path of [...modules, 'bin/gg.mjs']) assert.ok(agents.includes(`\`${path}\``), `AGENTS.md lists ${path}`);
  for (const path of modules) {
    const mod = await import(pathToFileURL(root + path));
    assert.equal(typeof mod, 'object', path);
  }
});
