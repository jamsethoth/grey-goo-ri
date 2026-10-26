// The template repos every real-git fixture copies: each copy must be a repository of its own, or one case's commits
// would reach the next case's starting point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a copied fixture repository is independent of its template', async (t) => {
  const templateRepos = await import('../../support/template-repos.mjs');
  const changed = tempRoot(t);
  const untouched = tempRoot(t);
  const base = templateRepos.seedRepos(changed);
  templateRepos.seedRepos(untouched);
  writeFileSync(join(changed, 'main', 'a.txt'), 'a');
  sh(join(changed, 'main'), 'add', '-A');
  sh(join(changed, 'main'), 'commit', '-q', '-m', 'one');
  sh(join(changed, 'main'), 'push', '-q', 'origin', 'main');
  const later = tempRoot(t);

  assert.equal(templateRepos.seedRepos(later), base);
  assert.equal(sh(join(untouched, 'main'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(untouched, 'origin.git'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'main'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'origin.git'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'main'), 'status', '--porcelain'), '');
});

test('a copied clone pushes to its own origin, not the template\'s', async (t) => {
  const templateRepos = await import('../../support/template-repos.mjs');
  const pushed = tempRoot(t);
  templateRepos.seedRepos(pushed);
  sh(join(pushed, 'main'), 'checkout', '-q', '-b', 'ticket/9-thing');
  sh(join(pushed, 'main'), 'commit', '-q', '--allow-empty', '-m', 'work');
  sh(join(pushed, 'main'), 'push', '-q', 'origin', 'ticket/9-thing');
  const later = tempRoot(t);
  templateRepos.seedRepos(later);

  assert.equal(sh(join(pushed, 'origin.git'), 'rev-parse', 'ticket/9-thing'), sh(join(pushed, 'main'), 'rev-parse', 'HEAD'));
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ticket/9-thing'], { cwd: join(later, 'origin.git') }).status, 1);
});
