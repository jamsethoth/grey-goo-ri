import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = [
  'lib/opts.mjs', 'lib/config.mjs', 'lib/flow.mjs', 'lib/run.mjs', 'lib/interpreter.mjs', 'lib/effects.mjs', 'lib/terminal.mjs',
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

// lib/git.mjs is the one git interface (grey-goo-ri issue #144): every other module calls its verbs with gg's values.
test('no module outside lib/git.mjs passes git a command line', async () => {
  const git = await import(pathToFileURL(`${root}lib/git.mjs`));
  assert.equal(git.runGit, undefined, 'runGit is not exported');
  const raw = [
    [/\brunGit\b/, 'runGit'],
    [/\b(?:run|spawn|spawnSync|execFile|execFileSync)\(\s*['"`]git['"`]/, 'a spawned git'],
    [/\^\{|\.\.\.HEAD|refs\/heads\/|['"`]HEAD['"`]/, 'git ref syntax'],
    [/['"`]:\([a-z,]+\)/, 'a git pathspec'],
    // bin/gg.mjs passes lib/git.mjs in; a module that imported it could fall back to it instead of the git it was given.
    [/from ['"`]\.\/git\.mjs['"`]/, 'an import of lib/git.mjs'],
  ];
  for (const path of [...modules.filter((m) => m !== 'lib/git.mjs'), 'bin/gg.mjs', 'scripts/run-suite.mjs']) {
    const text = await readFile(root + path, 'utf8');
    for (const [re, what] of raw) assert.doesNotMatch(text, re, `${path} builds ${what}`);
  }
});
